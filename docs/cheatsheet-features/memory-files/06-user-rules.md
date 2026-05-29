# User rules (~/.claude/rules/*.md)

**Source:** Claude Code cheat sheet — Memory & Files
**Status:** UI_WORTHY

## What it is
User-scoped rule files at `~/.claude/rules/*.md`, applied across all projects. Same shape as project rules (feature 05) but global to the user rather than checked into a repo.

## Claudius today
No surface. As with project rules, there is no `~/.claude/rules/` handling in `app/`, `lib/`, or `components/`, and the bundled SDK does not auto-load these files (its "rules" are permission allow/deny/ask only).

## Decision
UI_WORTHY (med). Same surface as feature 05 — a **rules editor section/tab on the `/memory` page** with a user-vs-project scope toggle (matching how the CLAUDE.md editor already toggles user/project scopes via the account/workspace `ScopeToggle`). The "user" branch points at `~/.claude/rules/*.md`. Backend shared with feature 05 (`lib/server/rules.ts` + `app/api/rules/route.ts`, with a `scope` param resolving to `homedir()/.claude/rules` vs `<cwd>/.claude/rules`). Runtime injection into the session is **deferred — needs backend** for the same reason as feature 05. Status UI_WORTHY; the management UI is buildable today.
