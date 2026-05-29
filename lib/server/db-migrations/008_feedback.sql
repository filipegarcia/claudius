-- v8: user feedback (session-quality survey) records.
--
-- Claudius replicates the CLI's occasional "how's it going?" survey: after a
-- turn completes, with a low probability gated by `feedbackSurveyRate`, the
-- server broadcasts a `feedback_survey` event and the browser shows a slim,
-- dismissible banner. When the user submits, the comment is BOTH forwarded to
-- Anthropic (via the SDK's undocumented `query.submitFeedback`) AND persisted
-- here so we keep a local record even if the unsupported forward call fails.
--
-- Notes:
--   - `rating` is the thumbs verdict ('up' / 'down') or NULL when the user
--     submitted only free text. The rating is encoded into the forwarded
--     description too, since `submitFeedback` takes only a description string.
--   - `forwarded` is 1 when the SDK accepted the forward, 0 when it failed or
--     the method was unavailable (we still keep the row — no data loss).
--   - `surface` mirrors the SDK's feedback surface tag (defaults to 'claudius').
--   - The DB file is per-cwd, so workspace scoping is implicit.

CREATE TABLE IF NOT EXISTS feedback (
  id          TEXT PRIMARY KEY,
  session_id  TEXT,
  cwd         TEXT,
  rating      TEXT,
  comment     TEXT,
  surface     TEXT,
  forwarded   INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at);
