# Doctor Stale-Lock Cleanup with Count

**Source:** Claude Code TUI — `screens-doctor-repl`
**Status:** MISSING

## What it is
The TUI's Doctor screen runs an automatic sweep of leftover `~/.claude/locks/*` lockfiles and reports the result inline under a "Version locks / agents-locks" section rather than just diagnosing the problem. `screens/Doctor.tsx` renders `{versionLockInfo.staleLocksCleaned > 0 && <Text dimColor={true}>└ Cleaned {versionLockInfo.staleLocksCleaned} stale lock(s)</Text>}` — so the count only appears when the sweep actually removed something, and the parent `versionLockInfo` row carries the live counter (binary string occurs twice in the bundle).

## Claudius today
Not surfaced in Claudius. The natural home is `app/api/doctor/route.ts` — it would gain a `locks` check that `readdir`s `~/.claude/locks`, deletes entries whose pidfile no longer maps to a live process (or whose mtime is older than a threshold), and returns the cleaned count in the `Check.detail`; the existing `app/doctor/page.tsx` would render it like the other ok/warn rows.

## Decision
MISSING. Nothing in Claudius reads, writes, or cleans `~/.claude/locks` — `app/api/doctor/route.ts` only inspects `~/.claude` and `~/.claude/projects` for existence and writability, and a repo-wide search for `locks/`, `staleLocks`, or `versionLock` returns no matches. A faithful port would add a `locks` Check to `app/api/doctor/route.ts` that performs the sweep and reports `Cleaned N stale lock(s)` (or `no stale locks`) for the existing Doctor page to render, matching the `screens/Doctor.tsx` pattern from the leak.
