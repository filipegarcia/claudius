-- v22: persist `reason` on session_tasks rows.
--
-- SDK 0.3.273 added `reason: 'worker_restart'` to the terminal
-- `task_notification` — set only when a worker-process restart orphaned the
-- task (always alongside `status: 'stopped'`), so a reload can tell that
-- apart from an ordinary user/agent stop. Same nullable-TEXT convention as
-- `ambient` (migration 018): most tasks never carry a reason, so absent
-- round-trips as `undefined` rather than a sentinel.
ALTER TABLE session_tasks ADD COLUMN reason TEXT;
