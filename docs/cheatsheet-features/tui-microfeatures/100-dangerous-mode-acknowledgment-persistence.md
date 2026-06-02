# Dangerous-Mode Acknowledgment Remembered Across Sessions

**Source:** Claude Code TUI — migrations
**Status:** PARTIAL

## What it is
Once a user clicks through the bypass-permissions / dangerous-mode warning dialog, the TUI persists `skipDangerousModePermissionPrompt` in `settings.json` so the scary modal does not reappear on every new session. The migration comment in `migrations/migrateBypassPermissionsAcceptedToSettings.ts` spells out the intent: "Migration: Move bypassPermissionsModeAccepted from global config to settings.json as skipDangerousModePermissionPrompt. This is a better home since settings.json is the user-configurable settings file." Distinct from selecting bypass mode itself — this is the durable "I read the warning" acknowledgment.

## Claudius today
The SDK setting key is plumbed through the generic settings editor: `app/settings/page.tsx` (line 893) lists `skipDangerousModePermissionPrompt` in `SDK_SETTINGS_CATALOG` under the `Permissions` section with the description "Whether the user has accepted the bypass permissions mode dialog", so the flag round-trips to user `settings.json` if a user toggles it manually. What does *not* exist is the warning dialog whose acknowledgment that flag is supposed to remember: `components/chat/ModeSelector.tsx` lets the user pick `bypassPermissions` straight from the dropdown (line 49, red `ShieldOff` icon, description "Never prompt — auto-allow everything (dangerous)") with zero confirmation step, and `components/workspaces/WorkspaceForm.tsx` prefills `bypassPermissions` as the default for new workspaces (line 52) with the same no-modal posture. No code path in `components/`, `lib/server/session.ts`, or `app/api/sessions/[id]/mode/route.ts` reads `skipDangerousModePermissionPrompt` to gate first-time bypass selection.

## Decision
PARTIAL. The acknowledgment *persistence* surface already exists — `skipDangerousModePermissionPrompt` is a recognized settings key in `app/settings/page.tsx` (line 893) — but the modal it is meant to remember was never built, so the flag has nothing to suppress. To match the TUI's `migrations/migrateBypassPermissionsAcceptedToSettings.ts` contract, gate first-time entry into `bypassPermissions` from `components/chat/ModeSelector.tsx` (and the workspace default in `components/workspaces/WorkspaceForm.tsx`) behind a one-shot warning dialog that, on accept, flips `skipDangerousModePermissionPrompt = true` via the existing settings round-trip so the same modal never fires again in future sessions.
