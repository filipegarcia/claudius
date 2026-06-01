# Session-scoped 'allow Claude to edit its own settings'

**Source:** Claude Code TUI — permission flow
**Status:** MISSING

## What it is
When Claude tries to write to `.claude/` or `~/.claude/`, the permission prompt surfaces a dedicated option — `Yes, and allow Claude to edit its own settings for this session` — distinct from the normal accept-once or directory-trust paths. The Claude binary contains the literals `yes-claude-folder`, `accept-session`, `global-claude-folder`, and `claude-folder` near other prompt-option keys, confirming a separate branch for edits targeting the Claude folder.

## Claudius today
Not surfaced in Claudius. `components/chat/PermissionPrompt.tsx` offers `Allow once`, `Always (session)`, `Always (project)`, and `Always (user)`, but does not detect when the tool's target path is inside `.claude/` or `~/.claude/` and does not present a `.claude`-specific session grant. The decision type in `lib/shared/events.ts` (`PermissionDecision`) likewise has no `yes-claude-folder` variant. It would naturally live as an extra button on `components/chat/PermissionPrompt.tsx` conditional on the request input touching a `.claude/` path.

## Decision
MISSING. The dedicated `.claude`-folder session branch is not implemented; today users have to fall back to `Always (session)` for the tool as a whole or save a permanent rule. Worth adding as a path-aware option in `components/chat/PermissionPrompt.tsx` (plus a new `PermissionDecision` variant in `lib/shared/events.ts`) if the user wants this surfaced.
