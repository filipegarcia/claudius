-- Cumulative per-session cost/usage totals.
--
-- WHY: the SDK's `result` messages (the only carrier of authoritative
-- `total_cost_usd` / `num_turns` / durations / `modelUsage`) are NEVER
-- written to the session JSONL, and the SDK's own running totals "start
-- fresh" on every resume. So any session rebuilt from disk (dev-server
-- restart, app relaunch, idle-session reap) lost its cost history and the
-- /cost dialog visibly reset to a tail-window estimate. This table is the
-- durable accumulator: `Session` folds each SDK process's running totals
-- into the persisted baseline and re-seeds clients via `usage_snapshot`.
--
-- One row per session id (session ids are stable across resumes — see
-- `Session`'s `requestedId = opts.id ?? opts.resume`). `model_usage_json`
-- is the merged per-model breakdown (SDK `ModelUsage` shape, JSON).
CREATE TABLE IF NOT EXISTS session_usage (
  session_id TEXT PRIMARY KEY,
  total_cost_usd REAL NOT NULL DEFAULT 0,
  num_turns INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  duration_api_ms INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
  model_usage_json TEXT,
  updated_at INTEGER NOT NULL
);
