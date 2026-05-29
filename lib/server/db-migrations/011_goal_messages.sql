-- v11: track which user messages were sent as a session goal. When the user
-- submits the header goal input (or `/goal <text>`), the text is sent as a
-- normal user prompt AND recorded as the tracked goal — the agent starts
-- working on it. We persist (session_id, message_uuid) here so the chat can
-- badge that bubble as a "Goal" — including after a reload, where the message
-- is replayed from the SDK JSONL with no in-memory provenance.
--
-- Mirrors `suggested_messages` (migration 009): same (session_id, message_uuid)
-- join key — the client mints the uuid, sends it with the prompt, and the SDK
-- writes that same uuid into the JSONL, so it's stable across reloads. The
-- leftmost-prefix PK on session_id backs the "all goal uuids for this session"
-- lookup. `goal_text` stores the goal text (== the sent message) for analytics.
--
-- The DB file is per-cwd, so workspace scoping is implicit.

CREATE TABLE IF NOT EXISTS goal_messages (
  session_id    TEXT NOT NULL,
  message_uuid  TEXT NOT NULL,
  goal_text     TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (session_id, message_uuid)
);
