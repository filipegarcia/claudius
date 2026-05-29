# Agent frontmatter — permission mode

**Source:** Claude Code cheat sheet — Skills & Agents
**Status:** ALREADY_EXISTS

## What it is
An agent's `permissionMode` frontmatter (default / acceptEdits / plan / dontAsk / bypassPermissions) sets how the subagent handles permission prompts.

## Claudius today
The Agents page (`app/[workspaceId]/agents/page.tsx`) treats `permissionMode` as a first-class field: the new-agent `TEMPLATE` documents it with the full value set (`# permissionMode: default # default | acceptEdits | bypassPermissions | plan | dontAsk`), the list view renders it as a meta badge (`if (fm.permissionMode) metaBadges.push(fm.permissionMode)`), and the full frontmatter is editable in the textarea. `lib/server/agents.ts` parses it.

## Decision
ALREADY_EXISTS. Surfaced as a badge and seeded in the template on `app/[workspaceId]/agents/page.tsx`; parsed by `lib/server/agents.ts`.
