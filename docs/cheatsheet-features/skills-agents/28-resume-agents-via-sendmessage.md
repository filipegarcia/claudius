# Resume agents via SendMessage

**Source:** Claude Code cheat sheet — Skills & Agents
**Status:** NOT_APPLICABLE

## What it is
In recent Claude Code, the `SendMessage` tool replaces a separate "resume agent" mechanism — the main agent continues/re-engages a subagent by sending it a message rather than via an explicit resume command.

## Claudius today
This is an SDK-internal tool-orchestration change: how the main agent talks to subagents, not a user-facing control. Claudius already renders subagent activity (`components/chat/TaskBlock.tsx` with inner messages) and tracks tasks (`lib/server/session-tasks-db.ts`, Background Tasks panel). There is no Claudius UI that "resumed" a subagent before, so there is nothing to replace; the agent decides when to call `SendMessage` on its own.

## Decision
NOT_APPLICABLE. An internal agent-to-subagent messaging mechanism with no distinct browser control — it's the model's tool to call, and its effects already render through the existing subagent/Task UI. No browser surface to add.
