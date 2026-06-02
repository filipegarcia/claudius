# Skill disable-model-invocation frontmatter (user-only)

**Source:** Claude Code TUI — skills loader
**Status:** PARTIAL

## What it is
A skill can opt out of auto-invocation by setting `disable-model-invocation: true` in SKILL.md frontmatter. The leaked `skills/loadSkillsDir.ts` comment spells it out — `// disableModelInvocation so that the user has to explicitly request it in\n    // interactive mode and so the description does not take up context.\n    disableModelInvocation: true,` — so the skill still appears as a user-typeable slash command, but its description is stripped from the agent's slash-command catalog and stops eating context tokens. Used by built-ins like `/skillify` and `/debug`.

## Claudius today
The Skills editor (`app/[workspaceId]/skills/page.tsx`) lets you type any YAML frontmatter into the SKILL.md textarea and round-trips it via `parseFrontmatter` in `lib/server/skills.ts` — so `disable-model-invocation: true` persists, but nothing in Claudius reads it. Only `name`, `description`, and `allowed-tools` are special-cased in the list (search index + the `TEMPLATE` seed at lines 17–31). The slash-command catalog in `lib/shared/slash-commands.ts` is a static registry merged with the SDK's reported `slash_commands` / `supportedCommands()` payload in `mergeSuggestions` (lines 228–281); it doesn't crack open SKILL.md files itself, so the description-suppression half of the contract has to come from the SDK in `system:init` / `richCommands` — Claudius forwards whatever description the SDK reports. There is no badge on the list row to flag a skill as "user-only" and no template hint pointing at the field.

## Decision
PARTIAL. The frontmatter key round-trips through `lib/server/skills.ts` and the SKILL.md textarea in `app/[workspaceId]/skills/page.tsx`, and the actual auto-invocation gate lives in the SDK — so once a skill carries `disable-model-invocation: true` the SDK is responsible for omitting it (or its description) from the `slash_commands` / rich-command payload that feeds `mergeSuggestions`. What's missing on the Claudius side is purely surfacing: a "user-only" pill on the skill list row when `frontmatter["disable-model-invocation"] === true`, a matching line in the `TEMPLATE` constant, and inclusion in the search index — same shape as the existing description/allowed-tools special-casing, citing the leaked `skills/loadSkillsDir.ts` comment as the rationale.
