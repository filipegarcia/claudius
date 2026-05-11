-- v5: per-workspace notification inbox + per-session block/snooze prefs.
--
-- `notifications` is the attention-worthy events surfaced from sessions and
-- scheduled-job runs (see lib/server/notification-bus.ts). The bus filters at
-- write-time using per-session prefs + per-workspace `enabledKinds`, so every
-- row here is something we expect to surface in the UI.
--
-- `request_id` carries the SDK-side correlation id for events that have one
-- (`permission_request`, `ask_user_question`, `plan_approval_request`). The
-- partial UNIQUE index makes `INSERT OR IGNORE` a clean dedup for the
-- resubscribe-replay path — if a future change ever causes the same prompt
-- to round-trip through broadcast() twice, the inbox stays clean.

CREATE TABLE IF NOT EXISTS notifications (
  id          TEXT PRIMARY KEY,
  session_id  TEXT,
  run_id      TEXT,
  job_id      TEXT,
  kind        TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT,
  payload     TEXT,
  request_id  TEXT,
  created_at  INTEGER NOT NULL,
  read_at     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_notif_unread
  ON notifications(read_at, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notif_session
  ON notifications(session_id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_notif_request
  ON notifications(request_id) WHERE request_id IS NOT NULL;

-- `session_notification_prefs` is the per-session block / snooze switch
-- driven by the SessionNotifyMenu popover. `snooze_until` is epoch ms;
-- rows can be deleted when block=0 and snooze is past, but we keep them
-- for audit / "recently snoozed" UX. The bus checks both columns on every
-- record() call.

CREATE TABLE IF NOT EXISTS session_notification_prefs (
  session_id   TEXT PRIMARY KEY,
  blocked      INTEGER NOT NULL DEFAULT 0,
  snooze_until INTEGER
);
