-- v2: sessions index. Mirrors the SDK's per-cwd JSONL store at the metadata
-- level so we can list/rename/title sessions without scanning every JSONL.
-- The JSONL files remain the source of truth for messages; this table is
-- just a fast index keyed by the same session id the SDK uses on disk.

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  cwd           TEXT NOT NULL,
  -- User-set custom title (null until rename). The SDK also stores this in
  -- the JSONL header; we keep our own copy because (a) it's authoritative
  -- for sessions that haven't completed a turn yet (no JSONL yet), and
  -- (b) it's faster to look up than scanning the JSONL header.
  title         TEXT,
  model         TEXT,
  created_at    INTEGER NOT NULL,
  -- Bumped on each agent turn (`result` event) so list views can sort
  -- "most recently active first" without re-reading the JSONL mtime.
  updated_at    INTEGER NOT NULL,
  -- Last time we saw the session bound to a live `Session` in-memory.
  -- Useful for "still alive in this Claudius instance" debugging.
  last_seen_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_cwd     ON sessions(cwd);
