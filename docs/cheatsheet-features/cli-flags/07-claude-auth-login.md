# claude auth login (SSO/console)

**Source:** Claude Code cheat sheet — CLI & Flags
**Status:** UI_WORTHY

## What it is
`claude auth login` signs you in via Claude.ai (Pro/Max SSO) or the Anthropic Console, establishing the credentials Claude Code uses.

## Claudius today
There is a read-only account surface: `app/api/account/route.ts` returns `session.accountInfo()` (who you're logged in as), and `forceLoginMethod` ("claudeai" | "console") is editable in the Settings catalog (`app/settings/page.tsx`). But there is no interactive sign-in / sign-out flow in the browser — login still happens out-of-band in the terminal.

## Decision
UI_WORTHY. Add a sign-in surface to Settings (an "Account" section) that shows the current account from `/api/account` and triggers the SDK/CLI login flow (choosing Claude.ai vs Console, mirroring `forceLoginMethod`) plus a logout. Backend: the auth handshake is an interactive OAuth/device flow that the SDK owns — wiring it to a browser button needs server plumbing to launch the flow and surface the verification URL/code. Mark as **deferred — needs backend** for the actual login handshake; the read-only account display already exists. Priority: low (most users log in once via the CLI; the value is convenience, not a gap).
