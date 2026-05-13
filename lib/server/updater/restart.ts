import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { claudiusdPath, daemonLogFile, runtimeMode } from "./root";

export type RestartResult =
  | { kind: "scheduled"; mode: "daemon"; pid: number }
  | { kind: "manual"; mode: "dev"; reason: string };

/**
 * Trigger a restart of the running Claudius process.
 *
 *   - Daemon mode (`make up`): spawn a fully-detached shell that waits for
 *     OUR pid to exit, then re-execs `bin/claudiusd restart` (which itself
 *     calls `down` then `up`). We don't trigger `down` ourselves — we just
 *     exit cleanly so the supervisor child can take over. The exit happens
 *     via SIGTERM to our own pid right after we return; the API route
 *     responds to the client first.
 *
 *   - Dev mode (`bun run dev` from a terminal): we can't safely kill the
 *     user's foreground process — they'd lose their tty. Surface "manual
 *     restart needed" instead. Hot-reload picks up TypeScript changes
 *     automatically; only `bun install` adds usually require a full
 *     restart, and even then the user can Ctrl-C and re-run `claudius`.
 */
export async function triggerRestart(): Promise<RestartResult> {
  const mode = runtimeMode();
  if (mode !== "daemon") {
    return {
      kind: "manual",
      mode: "dev",
      reason: "running in dev mode — Ctrl-C and re-run `claudius` to pick up the update",
    };
  }
  const pid = process.pid;
  await spawnRestarter(pid);
  // Schedule our own exit shortly so the API response has time to flush.
  // The detached restarter is already polling; once we're gone (~2s), it
  // runs `claudiusd restart`, which performs its own `up`.
  scheduleSelfExit();
  return { kind: "scheduled", mode: "daemon", pid };
}

const SELF_EXIT_DELAY_MS = 1500;

function scheduleSelfExit(): void {
  setTimeout(() => {
    // Give the supervisor child the SIGTERM grace window. claudiusd's
    // `cmd_down` already does the same: TERM, wait 10s, then KILL.
    try {
      process.kill(process.pid, "SIGTERM");
    } catch {
      process.exit(0);
    }
  }, SELF_EXIT_DELAY_MS).unref?.();
}

/**
 * Spawn the detached restarter. The child:
 *   1. Polls every 500ms for our PID until it's gone (or hits a 30s limit
 *      and force-runs claudiusd anyway, which does its own SIGKILL escalation).
 *   2. Runs `bin/claudiusd up` to bring the new build online. (Not
 *      `restart` — we've already exited, so `down` would be a no-op.)
 *
 * The script is written to a temp file and exec'd with `setsid`/`nohup` so
 * it survives our death.
 */
async function spawnRestarter(parentPid: number): Promise<void> {
  const claudiusd = claudiusdPath();
  if (!existsSync(claudiusd)) {
    throw new Error(`claudiusd not found at ${claudiusd}`);
  }
  const log = daemonLogFile();
  await fs.mkdir(dirname(log), { recursive: true });

  const script = `#!/usr/bin/env bash
# claudius updater — detached restarter (parent pid ${parentPid})
set -u
LOG=${shellQuote(log)}
{
  echo ""
  echo "[updater] $(date) waiting for parent pid ${parentPid} to exit"
  for i in $(seq 1 60); do
    kill -0 ${parentPid} 2>/dev/null || break
    sleep 0.5
  done
  if kill -0 ${parentPid} 2>/dev/null; then
    echo "[updater] $(date) parent still alive after 30s — forcing claudiusd restart"
    ${shellQuote(claudiusd)} restart >>"$LOG" 2>&1
  else
    echo "[updater] $(date) parent gone — running claudiusd up"
    ${shellQuote(claudiusd)} up >>"$LOG" 2>&1
  fi
} >>"$LOG" 2>&1
`;

  // Use bash with `-c` so we don't need a temp file; pass the script via -c.
  // Pre-pend `setsid` if available so the child gets its own session.
  const useSetsid = await hasCmd("setsid");
  const child = useSetsid
    ? spawn("setsid", ["bash", "-c", script], {
        detached: true,
        stdio: "ignore",
      })
    : spawn("nohup", ["bash", "-c", script], {
        detached: true,
        stdio: "ignore",
      });
  child.unref();
}

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

async function hasCmd(cmd: string): Promise<boolean> {
  return await new Promise((resolve) => {
    const c = spawn("command", ["-v", cmd], { stdio: "ignore", shell: true });
    c.on("close", (code) => resolve(code === 0));
    c.on("error", () => resolve(false));
  });
}
