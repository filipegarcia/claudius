-- v3: per-workspace commit-message draft. Keyed by cwd because every
-- workspace stages and commits independently. We only ever keep ONE active
-- draft per workspace — generating a new one replaces the prior, the user
-- committing clears it.
--
-- The DB is already per-cwd (one .claudius.db file per project), so
-- "the row" effectively keys by the database itself; we still keep `cwd`
-- as a column for symmetry with the sessions table and for cross-DB
-- aggregation later.

CREATE TABLE IF NOT EXISTS commit_drafts (
  cwd        TEXT PRIMARY KEY,
  message    TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
