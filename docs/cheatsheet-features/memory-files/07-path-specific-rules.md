# Path-specific rules (paths: frontmatter)

**Source:** Claude Code cheat sheet — Memory & Files
**Status:** NOT_APPLICABLE

## What it is
A `paths:` frontmatter field inside a rule file (features 05/06) that scopes the rule so it applies only when the agent touches matching paths, rather than globally.

## Claudius today
No surface — and none independent of the rules files themselves. It is a frontmatter key edited inside a rule markdown file, not a standalone feature with its own location or backend.

## Decision
NOT_APPLICABLE. This is a field *within* a rules file, not a standalone browser surface. It is covered by whatever rules editor handles features 05/06 (the `paths:` value would just be another field in that editor, like `description`/`type` are in the auto-memory form). There is no independent page, tile, settings section, or chat control to add for it — manufacturing a separate surface for a single frontmatter key would not match the quality bar.
