# Project rules (.claude/rules/*.md)

**Source:** Claude Code cheat sheet — Memory & Files
**Status:** UI_WORTHY

## What it is
Project-scoped rule files stored as individual markdown documents under `./.claude/rules/*.md`. Each file is a focused instruction set (optionally path-scoped via frontmatter — see feature 07) that augments the project's standing instructions.

## Claudius today
No surface. There is no `.claude/rules/` handling anywhere in `app/`, `lib/`, or `components/` (the only `rules` hits in `lib/server` are `PermissionRules` allow/deny lists, unrelated to markdown rule files). The Memory page edits CLAUDE.md scopes and auto-memory only. The bundled `@anthropic-ai/claude-agent-sdk` references "rules" only for permission allow/deny/ask — it does not auto-load `.claude/rules/*.md`.

## Decision
UI_WORTHY (med). Add a **rules editor section/tab on the existing `/memory` page** (the page already groups memory/instruction scopes, so no new SideNav tile). It would list, create, edit, and delete files under `<cwd>/.claude/rules/*.md`, mirroring the existing scope-tabbed CLAUDE.md editor and the auto-memory file CRUD. Shares the same surface and component pattern as feature 06 (user rules). Backend: a new `app/api/rules/route.ts` + `lib/server/rules.ts` (list/read/write/delete with the same `assertWithin` path-safety as `auto-memory.ts`). Because the SDK does not auto-load `.claude/rules/*.md`, the editor alone is a thin shell with no runtime effect — the actual injection into the session is **deferred — needs backend** (resolve rules into the prompt at session start). Status stays UI_WORTHY; the file-management UI is buildable today and matches the existing quality bar.
