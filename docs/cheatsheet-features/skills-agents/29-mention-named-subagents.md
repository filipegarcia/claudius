# Mention named subagents (@agent-name)

**Source:** Claude Code cheat sheet — Skills & Agents
**Status:** IMPLEMENTED

**Implemented:** `components/chat/AtMentionPicker.tsx` now offers an agent-completion source (token body `agent-<name>`, sourced from the session-cached `/api/sessions/[id]/agents` list) when the `@`-token starts with `agent-`; `components/chat/PromptInput.tsx` threads `sessionId` to the picker and updates the composer hint to "@ for files/agents".

## What it is
Typing `@agent-name` in the composer explicitly directs the request to a named subagent (rather than letting the main agent decide whether to delegate).

## Claudius today
The composer has an `@`-mention picker (`components/chat/AtMentionPicker.tsx`), but it is wired to **files only** — it fetches filesystem entries from `/api/fs/list` and inserts a relative path. There is no `@agent-`/`@agent-name` completion source, even though the set of available agents is already known to the client (the loaded-agents list at `app/api/sessions/[id]/agents/route.ts`, and the SkillsOverlay's agent list). So mentioning a file works; mentioning a subagent by name does not.

## Decision
UI_WORTHY (med). Extend the existing `@`-mention flow to offer agent completions: when the token starts with `@agent-` (or a configurable prefix), source suggestions from the session's loaded agents (`app/api/sessions/[id]/agents/route.ts`) instead of (or alongside) files, and insert the `@agent-name` token verbatim so the SDK routes the turn. Frontend-mostly — the agent list endpoint already exists; the work is a second suggestion source in `AtMentionPicker.tsx` and its caller in `app/[workspaceId]/page.tsx`. Medium priority: it's a real, frequently-cited routing affordance with a clean buildable surface.
