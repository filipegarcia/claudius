-- v9: track which user messages originated from a clicked "Suggested
-- follow-up" chip (PromptSuggestions). When the user clicks a suggestion the
-- composer sends it verbatim; we record the message here so the chat can show
-- an "auto-suggested" badge on that bubble — including after a reload, where
-- the message is replayed from the SDK JSONL with no in-memory provenance.
--
-- Keyed by (session_id, message_uuid): the client mints the uuid, sends it
-- with the prompt, and the SDK writes that same uuid into the JSONL, so it's a
-- stable join key across reloads. The leftmost-prefix index on session_id
-- backs the "all suggested uuids for this session" lookup. `suggestion_text`
-- stores the chip text (== the sent message) for later analytics.
--
-- The DB file is per-cwd, so workspace scoping is implicit.

CREATE TABLE IF NOT EXISTS suggested_messages (
  session_id      TEXT NOT NULL,
  message_uuid    TEXT NOT NULL,
  suggestion_text TEXT NOT NULL DEFAULT '',
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (session_id, message_uuid)
);
