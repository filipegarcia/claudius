-- v16: persist `isBackgrounded` + `spawnDepth` on session_tasks rows.
--
-- SDK 0.3.238 added `is_backgrounded` and `spawn_depth` to `task_started`
-- events. `is_backgrounded` already existed as an in-memory-only field
-- (previously seeded solely from a later `task_updated.patch.is_backgrounded`,
-- which a task backgrounded from birth — e.g. a resumed subagent, always
-- backgrounded per the SDK — never receives); `spawn_depth` is new. Neither
-- was ever written to this table, so a Task's background/nesting state was
-- silently lost on every reload rebuilt from `session_tasks` (idle-reap,
-- server restart) — `hasActiveSubagents()` / `countActiveBackgroundTasks()`
-- would see a fresh, unset `isBackgrounded` and could wrongly re-treat a
-- backgrounded task as an active, blocking subagent after reload.
--
-- `is_backgrounded` is stored as 0/1 (SQLite has no native boolean),
-- nullable so "never reported" round-trips as `undefined`, not `false`.
ALTER TABLE session_tasks ADD COLUMN is_backgrounded INTEGER;
ALTER TABLE session_tasks ADD COLUMN spawn_depth INTEGER;
