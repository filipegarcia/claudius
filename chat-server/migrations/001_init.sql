-- v1: initial chat-server schema.
--
-- Three tables: rooms (the IRC channels), messages (the log), bans
-- (moderation). Schema deliberately small — anything more (reactions,
-- DMs, presence) can be additive without rewriting these.
--
-- IDs:
--   - rooms.slug is the natural primary key (e.g. 'general'); URL paths
--     reference rooms by slug, not by some opaque id.
--   - messages.id is a server-generated UUID (crypto.randomUUID()); we
--     never trust client-provided ids.
--
-- Why store ip on messages:
--   The /admin/bans endpoint can ban by 'nick' OR 'ip'. To enforce an
--   ip ban we need to know which messages came from which ip — kept
--   inline on the message row so look-up is O(1). The column is never
--   exposed over the wire (see redactMessage() in src/db.ts).
--
-- Soft delete:
--   deleted_at is nullable; SELECTs filter `deleted_at IS NULL`. We
--   keep the row so the audit trail survives, and so re-broadcast on
--   replay doesn't resurrect deleted content.

CREATE TABLE IF NOT EXISTS rooms (
  slug              TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  description       TEXT,
  pinned_message_id TEXT,
  created_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  room_slug   TEXT NOT NULL REFERENCES rooms(slug),
  nick        TEXT NOT NULL,
  ip          TEXT NOT NULL,
  body        TEXT NOT NULL,
  is_admin    INTEGER NOT NULL DEFAULT 0,
  deleted_at  INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_room_time
  ON messages(room_slug, created_at);

CREATE TABLE IF NOT EXISTS bans (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL CHECK(kind IN ('nick','ip')),
  value       TEXT NOT NULL,
  reason      TEXT,
  created_at  INTEGER NOT NULL,
  UNIQUE(kind, value)
);

-- Seed the three default rooms. INSERT OR IGNORE so re-running the
-- migration on a populated DB is a no-op.
INSERT OR IGNORE INTO rooms (slug, name, description, created_at) VALUES
  ('general', '#general', 'Chat about anything Claudius-related.',  (strftime('%s','now')*1000)),
  ('bugs',    '#bugs',    'Found something broken? Drop it here.',  (strftime('%s','now')*1000)),
  ('ideas',   '#ideas',   'Feature requests and what-ifs.',         (strftime('%s','now')*1000));
