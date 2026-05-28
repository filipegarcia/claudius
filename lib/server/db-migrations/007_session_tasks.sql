-- v7: per-session subagent (Task) records. The SDK streams a subagent's
-- live metadata (token/tool counts, duration, status, summary) and its
-- inner conversation as transient `task_progress` / `task_notification`
-- system events plus `parent_tool_use_id`-tagged messages. None of that is
-- written to the on-disk JSONL transcript — it lives only in the in-memory
-- SSE replay buffer. So once a session is idle-reaped (or the server
-- restarts) and rebuilt from disk, a Task block loses everything except its
-- spawn description and final status: the tokens/time counters go blank and
-- the expanded subagent transcript is empty.
--
-- This table persists that derived state so `subscribe()` can rehydrate it
-- via the `task_snapshot` SSE event on every (re)connect.
--
-- Notes:
--   - One row per (session_id, task_id). `task_id` is the SDK's stable task
--     id; `tool_use_id` is the parent Task tool_use block id the client uses
--     to JOIN metadata to the rendered block and to its inner messages.
--   - `inner_messages` is an opaque JSON array of `{ at, message }` rows
--     carrying the raw subagent SDK messages (those with
--     `parent_tool_use_id` set). Stored inline rather than in a child table
--     because they're a closed set written atomically when the task
--     finishes — never incrementally appended on the read path.
--   - The whole row is upserted once, on `task_notification` (task
--     completion). While a task is still running the live in-memory buffer
--     already covers reconnects, so there's no need to write per progress
--     tick and hammer SQLite.
--   - The DB file is per-cwd, so workspace scoping is implicit.

CREATE TABLE IF NOT EXISTS session_tasks (
  session_id     TEXT NOT NULL,
  task_id        TEXT NOT NULL,
  tool_use_id    TEXT,
  subagent_type  TEXT,
  description    TEXT,
  task_type      TEXT,
  workflow_name  TEXT,
  status         TEXT,
  total_tokens   INTEGER,
  tool_uses      INTEGER,
  duration_ms    INTEGER,
  summary        TEXT,
  error          TEXT,
  inner_messages TEXT NOT NULL DEFAULT '[]',
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (session_id, task_id)
);

CREATE INDEX IF NOT EXISTS idx_session_tasks_session ON session_tasks(session_id);
