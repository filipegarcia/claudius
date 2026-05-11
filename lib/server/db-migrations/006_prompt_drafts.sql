-- v6: per-session unsent prompt draft. The composer's textarea (and any
-- attached images) is persisted so the user can refresh / switch tabs /
-- close-and-reopen Claudius without losing what they were typing.
--
-- Keyed by session_id because every session has its own conversation;
-- switching sessions must NOT carry over the in-progress prompt. The DB
-- file itself is per-cwd, so workspace scoping is implicit.
--
-- Notes:
--   - `images` is an opaque JSON array of `AttachedImage` rows (base64
--     payloads + ordinal). Storing inline keeps the surface tiny and
--     avoids a second table; in exchange we accept the on-disk blob cost
--     for whatever the user attaches. Drafts are cleared on submit, so
--     the steady state is empty rows or none at all.
--   - On submit we DELETE the row; an explicit empty draft is also stored
--     as a DELETE rather than a blank row, so "missing" and "explicitly
--     cleared" collapse to the same on-disk state.

CREATE TABLE IF NOT EXISTS prompt_drafts (
  session_id TEXT PRIMARY KEY,
  text       TEXT NOT NULL DEFAULT '',
  images     TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL
);
