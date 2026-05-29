-- v3: per-cwd UI state. A small key/value table for local UI persistence
-- that should survive a browser close/reopen but is naturally scoped to
-- the workspace (the database file already lives at
-- `~/.claude/projects/<encoded-cwd>/.claudius.db`, so each row is implicitly
-- per-cwd). Values are opaque JSON so we can grow it without another
-- migration.
--
-- Current keys:
--   open_tabs  → JSON array of session ids in the order they appear in the
--                tab strip. Powers "leave and come back, find the same
--                tabs" behavior on app/page.tsx.
CREATE TABLE IF NOT EXISTS ui_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
