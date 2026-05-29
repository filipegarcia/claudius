import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Where the running Claudius lives on disk. The updater always operates
 * against this directory — never against a workspace cwd.
 *
 * In practice this is `process.cwd()` because both the `claudius` launcher
 * and `bin/claudiusd` chdir into the install root before invoking Next.
 * Override with `CLAUDIUS_INSTALL_ROOT` for tests or unusual setups.
 */
export function installRoot(): string {
  const override = process.env.CLAUDIUS_INSTALL_ROOT;
  if (override && override.trim()) return override.trim();
  return process.cwd();
}

/** Path to the daemon PID file relative to the install root. */
export function daemonPidFile(): string {
  return join(installRoot(), ".claudius", "claudius.pid");
}

/** Path to the daemon log file. */
export function daemonLogFile(): string {
  return join(installRoot(), ".claudius", "logs", "claudius.log");
}

/** Path to the bundled claudiusd script. */
export function claudiusdPath(): string {
  return join(installRoot(), "bin", "claudiusd");
}

/**
 * Best-effort detection of how the user is running Claudius:
 *   - "daemon"  background process started via `make up` / `bin/claudiusd up`
 *               (PID file present and points at our process)
 *   - "dev"     foreground `bun run dev` / `claudius` launcher (no PID file)
 *   - "unknown" PID file present but stale or doesn't match us
 *
 * The distinction matters for restart: only the daemon mode can be
 * restarted in-place via `bin/claudiusd restart`. Dev mode would orphan the
 * user's terminal, so we surface a "please restart" notice instead.
 */
export function runtimeMode(): "daemon" | "dev" | "unknown" {
  const pidPath = daemonPidFile();
  if (!existsSync(pidPath)) return "dev";
  try {
    const raw = readFileSync(pidPath, "utf8").trim();
    const pid = Number(raw);
    if (!Number.isFinite(pid) || pid <= 0) return "unknown";
    if (pid === process.pid) return "daemon";
    // Different PID — could be a stale file from a prior run, or a sibling
    // daemon. Either way, we can still trigger `claudiusd restart` safely
    // because that script targets whatever the PID file points at.
    return "daemon";
  } catch {
    return "unknown";
  }
}
