# --from-pr

**Source:** Claude Code cheat sheet — CLI & Flags
**Status:** UI_WORTHY

## What it is
`--from-pr <url|number>` starts a session pre-loaded with the context of a pull/merge request (GitHub, GitLab, Bitbucket, or GitHub Enterprise) — the diff, description, and review threads.

## Claudius today
The git page (`app/[workspaceId]/git/page.tsx`) handles local git ops (diff, pull, push, pull-with-Claude conflict resolution) but has no "start a session from a PR" action. There is no route that fetches a remote PR's context, and the create-session route (`app/api/sessions/route.ts`) takes no PR identifier.

## Decision
UI_WORTHY. Add a "Start from PR" entry point — a control on the git page (`app/[workspaceId]/git/page.tsx`) or the new-session flow that takes a PR URL/number, fetches the PR (diff + description + comments) and opens a new session seeded with that context. Backend: a new API route (e.g. `app/api/workspaces/[id]/from-pr`) that resolves the PR via the host API (GitHub/GitLab/Bitbucket/GHE) — likely shelling out to `gh`/`glab` or hitting the REST API with the user's token — then creates a session with the PR context as the opening prompt. Effort: medium-high — the UI is small but multi-host PR fetching + auth is real plumbing. Mark **deferred — needs backend**. Priority: med (clear, common review workflow; the git page is the natural home).
