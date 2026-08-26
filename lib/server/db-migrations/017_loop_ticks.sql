-- v17: Loops breakdown (Claude Code 2.1.243 — "Added a Loops breakdown to
-- /usage: per-loop run count, total tokens, tokens per run, and last run,
-- so runaway or chatty /loop tasks are easy to spot").
--
-- Claudius's in-memory `Session.scheduledLoops` map only ever holds the
-- *current* ScheduleWakeup tick for a session-only dynamic loop — each new
-- tick replaces the previous one (see `trackScheduledLoops` in session.ts),
-- so there was never any historical record to aggregate from. This table
-- persists one row per observed tick going forward; `tokens` starts NULL
-- and is filled in once the tick's turn produces a `result` message (see
-- `attachLoopTickTokens` in loop-ticks-db.ts).
--
-- Grouped by session_id, not by individual /loop invocation — Claudius has
-- no stable id across a chained wake-up (each tick gets a fresh
-- tool_use_id); see the 2.1.245 run-notes for the scoping rationale.
CREATE TABLE IF NOT EXISTS loop_ticks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  session_title TEXT,
  tool_use_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  fired_at INTEGER NOT NULL,
  tokens INTEGER,
  noop INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_loop_ticks_session ON loop_ticks(session_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_loop_ticks_tool_use ON loop_ticks(tool_use_id);
