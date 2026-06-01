# Folder-trust safety-check dialog with red-flag telemetry

**Source:** Claude Code TUI — permission flow
**Status:** MISSING

## What it is
The first time Claude Code is launched in a directory, the TUI shows a confirmation dialog: `Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team)` with `Yes, I trust this folder` / `No, exit` options. The `tengu_trust_dialog_shown` telemetry event captures risk signals from the folder before the user answers: `isHomeDir`, `hasMcpServers`, `hasBashExecution`, `hasApiKeyHelper`, `hasAwsCommands`, `hasGcpCommands`, `hasOtelHeadersHelper`, and `hasDangerousEnvVars`.

## Claudius today
Not surfaced in Claudius. The workspace-creation flow (`components/workspaces/WorkspaceForm.tsx`, `components/workspaces/DirectoryPicker.tsx`, `app/api/workspaces/route.ts`) accepts any directory without a trust gate or red-flag scan; there is no equivalent of the TUI's first-run confirmation, and `lib/shared/tips.ts` / `lib/shared/slash-commands.ts` contain no trust prompt.

## Decision
MISSING. Worth adding as a one-time "Quick safety check" dialog in `components/workspaces/WorkspaceForm.tsx` (and/or on first session open in `app/[workspaceId]/page.tsx`) that inspects the chosen folder for the same red flags — `.mcp.json`, `apiKeyHelper`/`awsCredentialHelper` settings, suspicious env vars, and whether the path equals `$HOME` — before letting the agent run there.
