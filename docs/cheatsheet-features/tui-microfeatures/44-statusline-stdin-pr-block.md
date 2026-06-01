# statusLine stdin exposes open PR for current branch

**Source:** Claude Code TUI — ambient status line
**Status:** MISSING

## What it is
The JSON piped to a custom `statusLine` command has an optional `pr` block mirroring the footer PR badge, so a status line can render e.g. `PR #1234 (changes_requested)`:

> `"pr": { "number": number, "url": "string", "review_state": "approved" | "pending" | "changes_requested" | "draft" }`

The docs even show the jq one-liner: `pr=$(echo "$input" | jq -r '.pr.number // empty'); [ -n "$pr" ] && echo "PR #$pr ($(echo "$input" | jq -r '.pr.review_state // "open"'))"`.

## Claudius today
Not surfaced in Claudius. `components/chat/StatusLine.tsx` is a hand-rolled React status line (worktree badge, model deprecation chip, compact/clear buttons) — it does not consume the SDK's `statusLine` stdin JSON, and there is no PR badge anywhere; `lib/shared/slash-commands.ts` only references PRs via skill argsHints (`/review`, `/autofix-pr`). The natural home would be a new PR chip in `components/chat/StatusLine.tsx`, fed by a small `app/api/sessions/[id]/pr/route.ts` that runs `gh pr view --json number,url,reviewDecision` against the agent's cwd.

## Decision
MISSING. Claudius' `StatusLine` is a bespoke React component, not a TUI status-line consumer, so the SDK's `pr` stdin field is invisible to it. Worth adding as a small `PR #1234 (changes_requested)` chip in `components/chat/StatusLine.tsx` if the user wants the footer PR badge surfaced in the browser.
