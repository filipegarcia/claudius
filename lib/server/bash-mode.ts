import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/**
 * Per-session persistent bash for the `!` input-box mode (Claude Code parity).
 *
 * Each Claudius session owns one long-lived `bash` child anchored at the
 * session's cwd. `exec` runs one command on that shell and returns stdout,
 * stderr, exit code, and a `truncated` flag — `cd`, `export`, function
 * definitions and other shell state persist across calls within the same
 * session, just like a normal terminal tab.
 *
 * Why persistent (not `bash -c` per call):
 *   - Users expect `!cd subdir` then `!ls` to land in the subdir. A one-shot
 *     `bash -c` resets cwd every invocation.
 *   - Same for `!export FOO=bar` then `!echo $FOO` — env writes survive.
 *
 * Sentinel-marker protocol (per-command):
 *   We don't get a "command finished" event from a persistent shell, so we
 *   wrap each command with a per-call UUID sentinel that bash echoes after
 *   the command flushes its streams. The wrapper is INJECTED as separate
 *   lines into bash's stdin — no `{ … }` grouping, no subshell, so a `cd`
 *   or `export` in the command affects the parent shell as expected:
 *
 *     <command>
 *     __claudius_ec=$?
 *     printf '%s\n' '__CLAUDIUS_BASH_END_<id>__' 1>&2
 *     printf '%s:%d\n' '__CLAUDIUS_BASH_END_<id>__' "$__claudius_ec"
 *
 *   On the Node side we accumulate stdout/stderr separately until BOTH
 *   streams have seen the marker; then we resolve. The sentinel is a v4
 *   UUID, so collision with a command's own output is not a realistic
 *   concern (and even if it were, the exit-code colon-suffix on stdout
 *   discriminates).
 *
 * Concurrency:
 *   Commands run one at a time per session. Pile-ups queue. Two parallel
 *   `exec` calls on the same `BashSession` would interleave their sentinels
 *   on the same stream and tangle output, so the lock is non-negotiable.
 *
 * Timeout:
 *   Per-command. On expiry we SIGTERM the whole process group (the child
 *   is the group leader via `detached: true`, mirroring `shell.ts`) and
 *   respawn a fresh bash so a runaway loop can't poison the session. The
 *   call resolves with `timedOut: true`.
 *
 * Output cap:
 *   Same `MAX_OUTPUT_BYTES` soft cap as `shell.ts` — we stop appending
 *   per stream once the cap is hit and mark `truncated: true`.
 *
 * Sudo:
 *   See `Session.runBashCommand`. The password is injected via a per-call
 *   heredoc wrapped around the `sudo -S` invocation INSIDE the user's
 *   command, so bash itself can't accidentally consume it as a command
 *   word. The password is never logged, never broadcast, never persisted —
 *   only the original (sudo-free or `sudo …`-without-password) command
 *   surfaces in the UI echo and the model-facing prefix block.
 */

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const SHELL_PATH = "/bin/bash";

export type BashExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
  timedOut: boolean;
};

type Pending = {
  id: string;
  marker: string;
  startEnvelopeLen: { stdout: number; stderr: number };
  resolve: (r: BashExecResult) => void;
  timer: NodeJS.Timeout;
};

export class BashSession {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuf = "";
  private stderrBuf = "";
  private stdoutSawMarker = false;
  private stderrSawMarker = false;
  private capturedExitCode: number | null = null;
  /** Per-stream truncation flags for the *currently-running* command. */
  private truncated = false;
  private pending: Pending | null = null;
  private queue: Array<() => void> = [];
  private destroyed = false;

  constructor(
    private readonly cwd: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  /** Idempotent spawn; called lazily on first exec and after timeout respawn. */
  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.child && !this.child.killed && this.child.exitCode === null) {
      return this.child;
    }
    // `--norc --noprofile` mirrors the one-shot `bash -c` behaviour in
    // `shell.ts` — predictable env, no surprise alias expansions.
    const child = spawn(SHELL_PATH, ["--norc", "--noprofile"], {
      cwd: this.cwd,
      env: this.env,
      detached: true,
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    // Each listener carries a reference to its own `child` and ignores
    // events that fire AFTER we've swapped to a new child (timeout
    // respawn, error respawn). Without this gate, the old bash's late
    // `close` event would resolve the NEW pending call with the old
    // exit code, which broke the respawn-after-timeout flow.
    const ownChild = child;
    child.stdout.on("data", (chunk: string) => {
      if (this.child !== ownChild) return;
      this.onStdout(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      if (this.child !== ownChild) return;
      this.onStderr(chunk);
    });
    child.on("error", (err) => {
      if (this.child !== ownChild) return;
      // Spawn-side failures (bash missing, etc.) — fail the in-flight call
      // if any and clear so the next exec respawns.
      if (this.pending) {
        const p = this.pending;
        this.pending = null;
        clearTimeout(p.timer);
        p.resolve({
          stdout: this.stdoutBuf,
          stderr: this.stderrBuf + `\n${err.message}`,
          exitCode: -1,
          truncated: this.truncated,
          timedOut: false,
        });
        this.resetPerCommand();
      }
      this.child = null;
    });
    child.on("close", () => {
      if (this.child !== ownChild) return;
      // Bash exited (user did `exit`, or we killed it). If a call is in
      // flight resolve with what we have; the next exec will respawn.
      if (this.pending) {
        const p = this.pending;
        this.pending = null;
        clearTimeout(p.timer);
        p.resolve({
          stdout: this.stdoutBuf,
          stderr: this.stderrBuf,
          exitCode: this.capturedExitCode ?? -1,
          truncated: this.truncated,
          timedOut: false,
        });
        this.resetPerCommand();
      }
      this.child = null;
    });
    this.child = child;
    return child;
  }

  /**
   * Run one command on the persistent shell. Returns when both stdout and
   * stderr have seen the sentinel, the shell dies, or the timeout fires.
   * Calls serialise — a second invocation while one is in flight queues.
   */
  exec(
    command: string,
    opts?: { stdin?: string; timeoutMs?: number },
  ): Promise<BashExecResult> {
    return new Promise<BashExecResult>((resolve) => {
      if (this.destroyed) {
        resolve({
          stdout: "",
          stderr: "BashSession destroyed",
          exitCode: -1,
          truncated: false,
          timedOut: false,
        });
        return;
      }
      const run = () => this.runOne(command, opts ?? {}, resolve);
      if (this.pending) {
        this.queue.push(run);
      } else {
        run();
      }
    });
  }

  private runOne(
    command: string,
    opts: { stdin?: string; timeoutMs?: number },
    resolve: (r: BashExecResult) => void,
  ) {
    const child = this.ensureChild();
    const id = randomUUID().replace(/-/g, "");
    const marker = `__CLAUDIUS_BASH_END_${id}__`;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    this.resetPerCommand();
    this.pending = {
      id,
      marker,
      startEnvelopeLen: { stdout: 0, stderr: 0 },
      resolve,
      timer: setTimeout(() => this.handleTimeout(), timeoutMs),
    };

    // `opts.stdin` is retained for legacy callers that genuinely want to
    // pipe bytes into the next read — head/cat etc. Note this is NOT a
    // safe channel for sudo passwords in a persistent shell: bash itself
    // consumes the stdin buffer between commands. For sudo, the caller
    // (Session.runBashCommand) wraps the command with a heredoc.
    if (opts.stdin && opts.stdin.length > 0) {
      child.stdin.write(opts.stdin);
    }

    // Wrapping. Each line lands as a separate top-level command in the
    // persistent shell — no `{ … }` group, no subshell, so a `cd` /
    // `export` in `command` mutates the parent shell. The stderr
    // sentinel goes out BEFORE the stdout sentinel: bash's stderr is the
    // same fd as the command's stderr, so by the time bash writes the
    // marker, the command's last stderr byte is already flushed. The
    // dual-stream waiter still requires BOTH sentinels before resolving.
    const wrapped =
      `${command}\n` +
      `__claudius_ec=$?\n` +
      `printf '%s\\n' '${marker}' 1>&2\n` +
      `printf '%s:%d\\n' '${marker}' "$__claudius_ec"\n`;
    child.stdin.write(wrapped);
  }

  private onStdout(chunk: string) {
    if (!this.pending) {
      // Stray output (shouldn't happen — bash is quiet between commands)
      // — drop it.
      return;
    }
    this.appendBuffered("stdout", chunk);
    const marker = this.pending.marker;
    const idx = this.stdoutBuf.indexOf(marker + ":");
    if (idx >= 0) {
      // Capture exit code from the suffix.
      const tail = this.stdoutBuf.slice(idx + marker.length + 1);
      const m = /^(-?\d+)/.exec(tail);
      this.capturedExitCode = m ? Number(m[1]) : -1;
      // Trim the sentinel + its newline out of the visible stdout buffer.
      this.stdoutBuf = this.stdoutBuf.slice(0, idx).replace(/\n$/, "");
      this.stdoutSawMarker = true;
      this.maybeResolve();
    }
  }

  private onStderr(chunk: string) {
    if (!this.pending) return;
    this.appendBuffered("stderr", chunk);
    const marker = this.pending.marker;
    const idx = this.stderrBuf.indexOf(marker);
    if (idx >= 0) {
      // The wrapper prints the marker on its own line. Strip everything
      // from the marker on (including the trailing newline bash printed
      // for us) and the immediately preceding newline that separated
      // any real stderr from our sentinel line.
      this.stderrBuf = this.stderrBuf.slice(0, idx).replace(/\n$/, "");
      this.stderrSawMarker = true;
      this.maybeResolve();
    }
  }

  private appendBuffered(stream: "stdout" | "stderr", chunk: string) {
    const cur = stream === "stdout" ? this.stdoutBuf : this.stderrBuf;
    if (cur.length >= MAX_OUTPUT_BYTES) {
      this.truncated = true;
      return;
    }
    const room = MAX_OUTPUT_BYTES - cur.length;
    const next = chunk.length > room ? chunk.slice(0, room) : chunk;
    if (chunk.length > room) this.truncated = true;
    if (stream === "stdout") {
      this.stdoutBuf = cur + next;
    } else {
      this.stderrBuf = cur + next;
    }
  }

  private maybeResolve() {
    if (!this.pending) return;
    if (!this.stdoutSawMarker || !this.stderrSawMarker) return;
    const p = this.pending;
    this.pending = null;
    clearTimeout(p.timer);
    const result: BashExecResult = {
      stdout: this.stdoutBuf,
      stderr: this.stderrBuf,
      exitCode: this.capturedExitCode ?? -1,
      truncated: this.truncated,
      timedOut: false,
    };
    this.resetPerCommand();
    p.resolve(result);
    // Drain queued runners.
    const next = this.queue.shift();
    if (next) next();
  }

  private handleTimeout() {
    if (!this.pending) return;
    const p = this.pending;
    this.pending = null;
    const result: BashExecResult = {
      stdout: this.stdoutBuf,
      stderr: this.stderrBuf,
      exitCode: -1,
      truncated: this.truncated,
      timedOut: true,
    };
    this.resetPerCommand();
    // Kill the process group (group leader = bash, set up by `detached: true`)
    // so any descendants (sleep, build subprocesses) die too. Same SIGTERM
    // model as `shell.ts`.
    try {
      if (this.child?.pid != null) process.kill(-this.child.pid, "SIGTERM");
    } catch {
      // Already gone — fine.
    }
    this.child = null;
    p.resolve(result);
    // Drain — next run will respawn via ensureChild.
    const next = this.queue.shift();
    if (next) next();
  }

  private resetPerCommand() {
    this.stdoutBuf = "";
    this.stderrBuf = "";
    this.stdoutSawMarker = false;
    this.stderrSawMarker = false;
    this.capturedExitCode = null;
    this.truncated = false;
  }

  /** Tear down the child for good. Subsequent execs reject fast. */
  dispose() {
    this.destroyed = true;
    try {
      if (this.child?.pid != null) process.kill(-this.child.pid, "SIGTERM");
    } catch {
      // ignore
    }
    this.child = null;
    this.queue = [];
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      clearTimeout(p.timer);
      p.resolve({
        stdout: this.stdoutBuf,
        stderr: this.stderrBuf,
        exitCode: -1,
        truncated: this.truncated,
        timedOut: false,
      });
    }
  }
}

/**
 * One BashSession per Claudius session id. Keyed by the session id (not the
 * Session object) so the route handler — which gets a freshly-resolved
 * session from `sessionManager.get(id)` — can look up the right shell
 * without holding a reference. Disposed when the Session ends; see
 * `dropBashSession`.
 */
const bashSessions = new Map<string, BashSession>();

export function getOrCreateBashSession(sessionId: string, cwd: string): BashSession {
  const existing = bashSessions.get(sessionId);
  if (existing) return existing;
  const created = new BashSession(cwd);
  bashSessions.set(sessionId, created);
  return created;
}

export function dropBashSession(sessionId: string) {
  const existing = bashSessions.get(sessionId);
  if (!existing) return;
  existing.dispose();
  bashSessions.delete(sessionId);
}

/**
 * Test-only seam — lets a unit test inject a session at a known id without
 * spawning a real bash process.
 */
export function _registerForTest(sessionId: string, session: BashSession) {
  bashSessions.set(sessionId, session);
}
