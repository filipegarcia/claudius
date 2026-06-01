# IDE selection / open-file ambient reminder

**Source:** Claude Code TUI — hooks
**Status:** MISSING

## What it is
When the Claude Code IDE plugin is connected, the TUI injects an ambient system-reminder whenever the user highlights code or focuses a file in the editor. The grounded handlers wrap the event in a hedge so the model treats it as context, not an instruction: `` `The user selected the lines ${H.lineStart} to ${H.lineEnd} from ${H.filename}: ...\nThis may or may not be related to the current task.` `` and `` `The user opened the file ${H.filename} in the IDE. This may or may not be related to the current task.` `` — both emitted with `isMeta:!0` so they ride as side-channel reminders rather than user turns.

## Claudius today
Not surfaced in Claudius. `lib/client/ide.ts` and the workspace's `useEditor()` only build *outbound* `vscode://file/<path>:<line>` (and Cursor/Windsurf/Zed/JetBrains) deep-links so the user can jump from Claudius into their editor; there is no inbound bridge that listens for editor selections or focused files and feeds them back to the agent. `/ide` is registered as an `external` (TUI passthrough) command in `lib/shared/slash-commands.ts` with no in-browser implementation, and `lib/server/system-reminders.ts` / `lib/server/session.ts` have no `opened_file_in_ide` / selection hook plumbing. The natural home would be a small bridge (extension or LSP-style client) that posts editor events into `app/api/sessions/[id]/...` and re-broadcasts them as a hedged system-reminder through the existing meta-message queue in `lib/server/system-reminders.ts`.

## Decision
MISSING. Claudius is editor-out (deep-links) but not editor-in — there is no path by which a connected IDE injects selection/open-file context as a system reminder. Worth adding only if we ship an actual IDE companion; the hedge wording from the TUI (`This may or may not be related to the current task.`) is the right template to reuse so the model treats it as ambient context, not a directive.
