# Hard-deny commands that cannot be auto-allowed

**Source:** Claude Code TUI — permission flow
**Status:** MISSING

## What it is
A subset of bash commands (`rm -rf` of cwd / parent / critical system dirs,
unset variable expansions like `$UNSET`, process substitution, UNC paths) are
flagged by the SDK as hard-deny: a saved allow-rule will not bypass them.
The user sees the verbatim message
> This command would remove a critical system directory. This requires explicit approval and cannot be auto-allowed by permission rules.

## Claudius today
Not surfaced in Claudius. `lib/client/usePermissions.ts` and the `/permissions`
page edit the standard `allow` / `ask` / `deny` rule scopes, and
`components/chat/PermissionPrompt.tsx` renders whatever permission request the
SDK forwards — but neither side has any knowledge of the SDK's intrinsic
hard-deny list. If a hard-deny fires, the user just sees a normal permission
prompt with the SDK's reason text; there is no badge, banner, or hint that the
saved allow rule was deliberately ignored.

## Decision
MISSING. The check itself lives inside `@anthropic-ai/claude-agent-sdk` and
fires before Claudius' permission resolver runs, so the behavior is
automatically correct — but the UX is silent. Worth adding a small "hard-deny
override" badge inside `components/chat/PermissionPrompt.tsx` (keyed on the
SDK's "cannot be auto-allowed by permission rules" reason string) so the user
understands why their existing allow rule did not apply.
