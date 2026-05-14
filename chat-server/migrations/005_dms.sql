-- v5: direct messages.
--
-- One-to-one messages between users, addressed by nick. Same trust
-- model as channel posts (anyone can claim a nick — no real
-- authentication), but the message body is only routed to the
-- recipient's stream rather than fanned out room-wide.
--
-- Why a separate table from `messages`:
--   - Different routing key (nick instead of room_slug).
--   - No pinning, no per-room metadata.
--   - Letting the channel `messages` table grow with DM traffic would
--     muddle moderation queries (e.g. banned-words audit) that only
--     care about public posts.
--
-- IP is stored for ban enforcement (same logic as channel messages).
-- Soft delete via `deleted_at` so users can delete their own DMs
-- without leaving holes in the recipient's view. We do not need the
-- `deletion_reason` discriminator the channel table uses — DMs only
-- support self-delete + admin-ban-purge, no bulk operations.

CREATE TABLE IF NOT EXISTS dms (
  id           TEXT PRIMARY KEY,
  from_nick    TEXT NOT NULL,
  from_ip      TEXT NOT NULL,
  to_nick      TEXT NOT NULL,
  body         TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  deleted_at   INTEGER
);

-- For "fetch a conversation between A and B, paginated by time".
-- The conversation between alice and bob is rows where
--   (from_nick='alice' AND to_nick='bob')
-- OR (from_nick='bob' AND to_nick='alice')
-- Covering both directions with composite indexes:
CREATE INDEX IF NOT EXISTS idx_dms_from_to_time
  ON dms(from_nick, to_nick, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dms_to_from_time
  ON dms(to_nick, from_nick, created_at DESC);

-- For "what conversations does this user have? give me the latest
-- message in each thread." We scan dms where the user is either
-- party, then GROUP BY peer — the per-nick index above covers both
-- legs of the union.
