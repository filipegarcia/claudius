-- v14: server-side queue of pending user messages.
--
-- Previously the queue lived in the browser's sessionStorage, drained by a
-- client-side `flushQueue()` that fired on the React `pending` true→false
-- edge. That made delivery contingent on a live, focused tab: backgrounded
-- tabs are throttled (Chrome stalls SSE processing after a few minutes), so
-- the drain never fired and queued messages sat indefinitely until the user
-- refocused. Closing the tab dropped the queue entirely.
--
-- Moving the queue to SQLite means the Session object (one in-memory
-- instance per session, naturally serialized) owns the drain. Every
-- turn-end (`result.subtype === "success"`) and every
-- permission/ask/plan answer pops the head and feeds it back through
-- `sendInput()` — independent of whether any browser is connected.
--
-- One row per queued message. `position` is the 0-based sort key; `uuid`
-- is the client-minted id used in the queue:updated SSE event payload so
-- DELETE/PATCH/move endpoints have a stable handle. `(session_id, position)`
-- is the natural sort, indexed for the head-pop and re-render queries.
-- `images_json` is a JSON-encoded array of {data,mediaType,ordinal} — only
-- the server reads it (the SSE payload exposes just `hasImages` to avoid
-- shipping multi-MB base64 blobs on every reorder).
--
-- The DB file is per-cwd, so workspace scoping is implicit.

CREATE TABLE IF NOT EXISTS queued_messages (
  uuid             TEXT PRIMARY KEY,
  session_id       TEXT NOT NULL,
  position         INTEGER NOT NULL,
  text             TEXT NOT NULL DEFAULT '',
  images_json      TEXT,
  slash            INTEGER NOT NULL DEFAULT 0,
  from_suggestion  INTEGER NOT NULL DEFAULT 0,
  from_goal        INTEGER NOT NULL DEFAULT 0,
  created_at_ms    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS queued_messages_session_position
  ON queued_messages (session_id, position);
