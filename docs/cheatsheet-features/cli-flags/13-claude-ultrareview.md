# claude ultrareview [target]

**Source:** Claude Code cheat sheet — CLI & Flags
**Status:** NOT_APPLICABLE

## What it is
`claude ultrareview [target]` runs a non-interactive, deep code review of a target (diff/PR/branch) and prints the findings — a headless review command.

## Claudius today
There is no dedicated "ultrareview" page. Code review in Claudius happens conversationally inside a chat session (you ask the agent to review the diff), and the repo ships a `code-review` skill that runs in a session. The git page (`app/[workspaceId]/git/page.tsx`) surfaces diffs that feed such a review.

## Decision
Not applicable as a new browser surface. `ultrareview` is a non-interactive CLI verb; its interactive analog already exists as a chat workflow plus the `code-review` skill, both of which run in the normal session UI. Building a separate headless-review page would duplicate the chat/skill flow without adding a distinct surface, and the "ultra" (cloud multi-agent) plumbing is SDK/CLI territory. Covered by existing chat + skill surfaces; no dedicated UI warranted.
