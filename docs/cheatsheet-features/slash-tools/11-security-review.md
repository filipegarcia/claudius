# /security-review

**Source:** Claude Code cheat sheet — Slash Commands — Tools
**Status:** ALREADY_EXISTS

## What it is
`/security-review` scans the pending diff for security vulnerabilities and
reports findings.

## Claudius today
Registered in `lib/shared/slash-commands.ts` as `handler: "sdk"` (category
`skill`, "Security review of pending changes") and backed by the
`security-review` skill (there is also a `security-triage` skill for CodeQL
alerts). As an `sdk`-handler command, `handleSend` in `app/[workspaceId]/page.tsx`
forwards it verbatim to the SDK via the `asSlashCommand` no-echo path; the agent
runs the scan against the current diff and streams the findings into chat. Diffs
themselves are viewable at `app/[workspaceId]/git/page.tsx`.

## Decision
ALREADY_EXISTS. `/security-review` works today through the SDK forward path
(`cmd?.handler === "sdk"` branch in `app/[workspaceId]/page.tsx`). Scanning a
diff is an agent action that streams into the existing chat transcript; no
separate browser UI is warranted. No new surface needed.
