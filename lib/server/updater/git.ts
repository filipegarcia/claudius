import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

/**
 * Thin wrapper around `git` for the updater path. We deliberately don't
 * reuse `lib/server/git.ts` — that one targets the workspace cwd (the user's
 * project), while the updater always operates against the Claudius install
 * root. Keeping them separate avoids accidentally pointing the updater at
 * the wrong tree.
 */

const execFileP = promisify(execFile);

const MAX_BUFFER = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const FETCH_TIMEOUT_MS = 60_000;
const PULL_TIMEOUT_MS = 60_000;

export type GitRunResult = { stdout: string; stderr: string };

export class UpdaterGitError extends Error {
  constructor(
    message: string,
    readonly stderr: string = "",
    readonly exitCode: number | null = null,
  ) {
    super(message);
    this.name = "UpdaterGitError";
  }
}

async function git(
  args: string[],
  cwd: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<GitRunResult> {
  try {
    const { stdout, stderr } = await execFileP("git", args, {
      cwd,
      maxBuffer: MAX_BUFFER,
      timeout: timeoutMs,
      env: {
        ...process.env,
        // Disable any interactive prompts (credentials, GPG passphrase, etc.).
        // The updater must never block waiting for tty input.
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "/bin/echo",
      },
    });
    return { stdout, stderr };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string };
    const stderr = typeof e.stderr === "string" ? e.stderr : "";
    const code = typeof e.code === "number" ? e.code : null;
    throw new UpdaterGitError(
      e.message ?? `git ${args[0] ?? ""} failed`,
      stderr,
      code,
    );
  }
}

/** True when `cwd` is inside a git work tree. Cheap, no network. */
export async function isGitCheckout(cwd: string): Promise<boolean> {
  try {
    await git(["rev-parse", "--is-inside-work-tree"], cwd);
    return true;
  } catch {
    return false;
  }
}

export async function currentBranch(cwd: string): Promise<string | null> {
  const { stdout } = await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  const b = stdout.trim();
  return b === "HEAD" ? null : b;
}

export async function headSha(cwd: string): Promise<string> {
  const { stdout } = await git(["rev-parse", "HEAD"], cwd);
  return stdout.trim();
}

export async function revParse(cwd: string, ref: string): Promise<string> {
  const { stdout } = await git(["rev-parse", ref], cwd);
  return stdout.trim();
}

export async function isDirty(cwd: string): Promise<boolean> {
  const { stdout } = await git(["status", "--porcelain"], cwd);
  return stdout.trim().length > 0;
}

/**
 * Network: fetches the configured remote/branch. Bounded timeout so a slow
 * remote doesn't wedge boot.
 */
export async function fetch(cwd: string, remote: string, branch: string): Promise<void> {
  await git(["fetch", "--quiet", "--no-tags", remote, branch], cwd, FETCH_TIMEOUT_MS);
}

export type AheadBehind = { ahead: number; behind: number };

export async function aheadBehind(
  cwd: string,
  local: string,
  upstream: string,
): Promise<AheadBehind> {
  const { stdout } = await git(
    ["rev-list", "--left-right", "--count", `${local}...${upstream}`],
    cwd,
  );
  const [ahead, behind] = stdout.trim().split(/\s+/).map((n) => Number(n) || 0);
  return { ahead: ahead ?? 0, behind: behind ?? 0 };
}

/** Subject lines for `local..upstream`, newest-first, capped. */
export async function recentCommits(
  cwd: string,
  local: string,
  upstream: string,
  limit = 8,
): Promise<string[]> {
  try {
    const { stdout } = await git(
      ["log", `--pretty=%s`, `-n`, String(limit), `${local}..${upstream}`],
      cwd,
    );
    return stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export async function pullFastForward(
  cwd: string,
  remote: string,
  branch: string,
): Promise<void> {
  await git(["pull", "--ff-only", "--quiet", remote, branch], cwd, PULL_TIMEOUT_MS);
}

/**
 * Streaming spawn — the caller decides how to handle stdout/stderr. Used by
 * the apply path so long-running operations (`bun install`, `bun run build`)
 * can pipe progress into the updater log without buffering the whole output.
 *
 * Returns a promise that resolves with the exit code; rejects if the process
 * couldn't be spawned at all.
 */
export function spawnStreamed(
  cmd: string,
  args: string[],
  cwd: string,
  onLine: (line: string, stream: "out" | "err") => void,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/bin/echo" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let outBuf = "";
    let errBuf = "";
    const flush = (which: "out" | "err", chunk: string) => {
      const buf = which === "out" ? outBuf + chunk : errBuf + chunk;
      const lines = buf.split(/\r?\n/);
      const tail = lines.pop() ?? "";
      for (const ln of lines) onLine(ln, which);
      if (which === "out") outBuf = tail;
      else errBuf = tail;
    };
    child.stdout.on("data", (d: Buffer) => flush("out", d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => flush("err", d.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => {
      if (outBuf) onLine(outBuf, "out");
      if (errBuf) onLine(errBuf, "err");
      resolve(code ?? 1);
    });
  });
}
