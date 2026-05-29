# Agent in own worktree (isolation: worktree)

**Source:** Claude Code cheat sheet — Workflows & Tips
**Status:** UI_WORTHY

## What it is
A subagent can declare `isolation: worktree` in its frontmatter so that, when invoked, it runs in a temporary git worktree — an isolated copy of the repo — instead of editing the main checkout directly.

## Claudius today
The agents page (`app/[workspaceId]/agents/page.tsx`) and `lib/server/agents.ts` persist agent definitions, but `agents.ts` parses frontmatter *generically* (`Record<string, unknown>` via `parseFrontmatter`) and the editor surfaces only the common keys (name/description/model/tools). There is **no** dedicated control for `isolation`. The SDK does honor it: `node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts` defines `isolation?: "worktree"` ("creates a temporary git worktree so the agent works on an isolated copy of the repo").

## Decision
UI_WORTHY (genuinely buildable — the backend already exists). Add an "Isolation" control (a select / toggle for `worktree`) to the agent editor on `app/[workspaceId]/agents/page.tsx`. Because frontmatter is already persisted generically, this is a thin UI shell that writes the `isolation` key into the agent file — no new backend plumbing required, just round-tripping the field through the editor. Priority low.
