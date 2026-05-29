-- v2: server-wide kill switch.
--
-- One row, never deleted, never inserted again. `disabled_at` is the
-- on/off signal — null = community is live, non-null epoch ms = killed
-- (with optional `disabled_reason` shown in the offline UI).
--
-- A single-row table is overkill for one flag, but lays the foundation
-- for any future global config that doesn't fit on `rooms` or `bans`.

CREATE TABLE IF NOT EXISTS system_state (
  singleton        INTEGER PRIMARY KEY CHECK(singleton = 1),
  disabled_at      INTEGER,
  disabled_reason  TEXT
);

INSERT OR IGNORE INTO system_state (singleton, disabled_at, disabled_reason)
  VALUES (1, NULL, NULL);
