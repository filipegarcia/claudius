-- v24: persist `output_file` on session_tasks rows.
--
-- CC 2.1.284 — the terminal `task_notification` carries `output_file`, the
-- path the task's full output was written to (what a Monitor event printed, a
-- background task's stdout). Persist it so the Background tasks panel can still
-- point at that output after a reload, instead of dropping the per-event
-- output. Same nullable-TEXT convention as `reason` (migration 022): most
-- tasks round-trip as `undefined` when the column is NULL.
ALTER TABLE session_tasks ADD COLUMN output_file TEXT;
