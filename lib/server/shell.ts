import { spawn } from "node:child_process";

/**
 * Per-stream output cap. Builds and test runs routinely produce hundreds of
 * KB; we keep 16 MB to handle the long tail without buffering forever. When
 * a stream hits the cap we stop appending but let the process keep running,
 * then mark `truncated: true` so the UI can surface the gap.
 */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/** Default timeout for ad-hoc shell commands typed into the console. */
const DEFAULT_TIMEOUT_MS = 120_000;

/** Hard-pinned shell. bash ships on macOS + every Linux distro. */
const SHELL_PATH = "/bin/bash";

export type ShellExecResult = {
  stdout: string;
  stderr: string;
  /** True when either stream hit `MAX_OUTPUT_BYTES` and we dropped the rest. */
  truncated: boolean;
  /** Exit code; -1 when the child errored before exiting (spawn failure). */
  exitCode: number;
  /**
   * Termination signal, if any. Non-null typically means we tripped the
   * timeout and sent SIGTERM ourselves. Surfacing this lets the UI render
   * "timed out" distinctly from a real non-zero exit.
   */
  signal: NodeJS.Signals | null;
};

/**
 * Run an arbitrary shell command in `cwd` via `bash -c`. Used by the
 * console prompt on the /git page so users can do `bun run lint`,
 * `git merge feat/x`, `tail file.log | head`, etc. without leaving Claudius.
 *
 * Design notes:
 *
 *   - **bash -c, not execFile-with-tokens.** Users expect pipes (`|`),
 *     redirects (`>`), command chaining (`&&`, `;`), env-var expansion
 *     (`$HOME`), and quoting to work the way they do in any other terminal.
 *     execFile with a tokenized argv would lose all of that. The trade-off:
 *     this is a real shell, so the same security model as a terminal
 *     applies — see SECURITY below.
 *
 *   - **Process env inherited.** PATH from the parent process means `bun`,
 *     `npm`, `git`, `node`, etc. resolve the same way they do in the user's
 *     terminal. `~/.bashrc` and `~/.zshrc` are *not* sourced (no `-i`/`-l`
 *     flag), so aliases won't expand. That's intentional: an interactive
 *     init would slow every command by a noticeable fraction of a second
 *     and load shell completions / plugins that we don't need.
 *
 *   - **Streaming buffer, soft cap.** We accumulate stdout/stderr in memory
 *     up to `MAX_OUTPUT_BYTES` per stream and then stop appending — the
 *     child keeps running, but we don't crash on a 5 GB log dump. The cap
 *     is a soft truncate, not a kill, so a verbose-but-short-overall
 *     build still finishes and reports its exit code.
 *
 *   - **Self-managed timeout.** We use a manual `setTimeout` + `kill`
 *     rather than spawn's `timeout` option so we can deliver SIGTERM
 *     ourselves and still resolve cleanly with whatever output landed
 *     before the deadline. Spawn's built-in timeout silently swallows
 *     output in some Node versions.
 *
 * SECURITY: This is a remote-shell endpoint that runs whatever the caller
 * sends. Claudius's threat model is "local-only, single-user, the operator
 * already has shell access on this machine," so that's fine. If Claudius
 * ever gains multi-tenant or hosted deployment, this route MUST be gated
 * behind authentication + per-workspace process isolation, or removed.
 */
export async function execShellCommand(
  cwd: string,
  command: string,
  opts?: {
    timeoutMs?: number;
    /**
     * Per-stream byte cap. Override only for tests — the production default
     * (`MAX_OUTPUT_BYTES`) is sized for build logs.
     */
    maxOutputBytes?: number;
  },
): Promise<ShellExecResult> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = opts?.maxOutputBytes ?? MAX_OUTPUT_BYTES;
  return await new Promise<ShellExecResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let settled = false;

    const child = spawn(SHELL_PATH, ["-c", command], {
      cwd,
      env: process.env,
      // `detached: true` puts the child (bash) in its own process group,
      // making it the group leader. That lets us kill the WHOLE group on
      // timeout via `process.kill(-pid, sig)` below — without this, a
      // `bash -c "sleep 60"` would receive SIGTERM at the bash level but
      // orphan `sleep`, which keeps the stdio pipes open and prevents
      // the `close` event from firing for another minute.
      detached: true,
    });

    const timer = setTimeout(() => {
      // SIGTERM the process group so bash AND any descendants (sleep,
      // node, build subprocesses, …) terminate together. The negative
      // pid is the kernel's "group" addressing — only works because we
      // spawned with `detached: true` above. SIGTERM (not SIGKILL) gives
      // well-behaved children a chance to print a final stderr message
      // about what they were doing.
      try {
        if (child.pid != null) process.kill(-child.pid, "SIGTERM");
      } catch {
        // ESRCH ("no such process") — group already gone. Fine.
      }
    }, timeoutMs);

    function settle(result: ShellExecResult) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      if (stdout.length >= maxOutputBytes) {
        truncated = true;
        return;
      }
      const room = maxOutputBytes - stdout.length;
      if (chunk.length > room) {
        stdout += chunk.slice(0, room);
        truncated = true;
      } else {
        stdout += chunk;
      }
    });

    child.stderr.on("data", (chunk: string) => {
      if (stderr.length >= maxOutputBytes) {
        truncated = true;
        return;
      }
      const room = maxOutputBytes - stderr.length;
      if (chunk.length > room) {
        stderr += chunk.slice(0, room);
        truncated = true;
      } else {
        stderr += chunk;
      }
    });

    child.on("error", (err) => {
      // Spawn-side failure (bash missing, permission denied, etc.). Push
      // the message into stderr so the UI renders something readable
      // instead of a blank row.
      stderr += `\n${err.message}`;
      settle({ stdout, stderr, truncated, exitCode: -1, signal: null });
    });

    child.on("close", (code, signal) => {
      settle({
        stdout,
        stderr,
        truncated,
        exitCode: code ?? -1,
        signal: signal ?? null,
      });
    });
  });
}
