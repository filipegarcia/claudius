-- v10: per-session goal. A goal is a single user-stated objective for the
-- session, shown prominently in the chat header and tracked until the agent
-- reports it accomplished. We keep it on the sessions index (rather than a
-- side table) because it's strictly 1:1 with a session and the listing surface
-- may want to badge "has an active goal" later without a join.
--
--   goal              the objective text (null = no goal set)
--   goal_achieved     1 once the agent calls report_goal_achieved; sticky
--                     until the user clears or replaces the goal
--   goal_summary      the agent's one-line summary of what was accomplished
--   goal_set_at       epoch ms the goal was (re)set — resets achievement
--   goal_achieved_at  epoch ms the goal was marked achieved
--
-- The DB file is per-cwd, so workspace scoping is implicit.

ALTER TABLE sessions ADD COLUMN goal             TEXT;
ALTER TABLE sessions ADD COLUMN goal_achieved    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN goal_summary     TEXT;
ALTER TABLE sessions ADD COLUMN goal_set_at      INTEGER;
ALTER TABLE sessions ADD COLUMN goal_achieved_at INTEGER;
