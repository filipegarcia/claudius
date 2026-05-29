-- v12: per-workspace, DB-backed programmatic subagent definitions.
--
-- Distinct from the file-based agents under `.claude/agents/*.md` (which the
-- SDK auto-loads from disk). These rows are passed to the SDK at session start
-- via `Options.agents` — letting a project define shared subagents without
-- writing markdown into the working tree. Per SDK semantics, programmatic
-- agents take precedence over file-based ones with the same name.
--
-- The DB file is per-cwd, so workspace scoping is implicit (same as every
-- other table here). `definition_json` holds the full SDK AgentDefinition
-- (description, prompt, tools, model, skills, effort, …) as opaque JSON — the
-- server validates required fields (description + prompt) on write, so we
-- don't decompose it into columns that would drift from the SDK type.

CREATE TABLE IF NOT EXISTS db_agents (
  name            TEXT PRIMARY KEY,
  definition_json TEXT NOT NULL,
  updated_at      INTEGER NOT NULL
);
