-- v1: assets index for content-addressed file store.
CREATE TABLE IF NOT EXISTS assets (
  hash          TEXT PRIMARY KEY,
  media_type    TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  width         INTEGER,
  height        INTEGER,
  first_seen_ms INTEGER NOT NULL,
  last_seen_ms  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assets_last_seen ON assets(last_seen_ms DESC);
CREATE INDEX IF NOT EXISTS idx_assets_media     ON assets(media_type);

CREATE TABLE IF NOT EXISTS asset_uses (
  asset_hash   TEXT NOT NULL REFERENCES assets(hash) ON DELETE CASCADE,
  session_id   TEXT NOT NULL,
  message_uuid TEXT NOT NULL,
  ordinal      INTEGER NOT NULL,
  occurred_ms  INTEGER NOT NULL,
  PRIMARY KEY (asset_hash, session_id, message_uuid, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_uses_session  ON asset_uses(session_id);
CREATE INDEX IF NOT EXISTS idx_uses_occurred ON asset_uses(occurred_ms DESC);

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
