/**
 * Default grace period between SIGTERM and SIGKILL. Matches Claude Code
 * 2.1.300 ("Changed exit to force-kill background commands still running
 * 1.5 seconds after being asked to stop").
 */
export const KILL_GRACE_MS = 1500;

/**
 * Ask a process group to stop, then force-kill whatever is still alive after
 * `graceMs`.
 *
 * `pid` must be the leader of its own process group — i.e. the child was
 * spawned with `detached: true` — because both signals are addressed to
 * `-pid` (the kernel's "whole group" form). That reaches bash AND every
 * descendant that stayed in the group, including background jobs started
 * with `&` (a non-interactive bash has job control off, so `&` jobs do not
 * get their own group).
 *
 * SIGTERM first so well-behaved children can flush a final message; SIGKILL
 * after the grace period so a job that traps/ignores TERM
 * (`( trap '' TERM; sleep 999 ) &`) can't outlive the session. CC 2.1.300
 * parity. The escalation timer is `unref()`'d so it never holds the Node
 * process open on its own; both signals swallow ESRCH (group already gone),
 * and no SIGKILL is scheduled when the SIGTERM finds no group at all.
 *
 * Scope: session close and per-command timeouts. It does NOT cover the Next
 * server or the Electron app shutting down — nothing disposes bash sessions on
 * process exit, and an unref'd timer wouldn't fire then anyway.
 */
export function killProcessGroup(pid: number, graceMs: number = KILL_GRACE_MS): void {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // ESRCH — no member of the group is alive. Don't schedule a SIGKILL:
    // the pgid could in theory be recycled by an unrelated process group
    // before the timer fires.
    return;
  }
  setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // ESRCH — everything exited within the grace period. Fine.
    }
  }, graceMs).unref();
}
