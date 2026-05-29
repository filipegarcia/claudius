# Switch model (Option+P)

**Source:** Claude Code cheat sheet — Keyboard Shortcuts (General / Mode / Input / Prefixes)
**Status:** ALREADY_EXISTS

## What it is
Option+P opens the model switcher to change the active model mid-session.

## Claudius today
The Activity rail's `SessionCard` (`components/panels/widgets/SessionCard.tsx`) has
a model-picker trigger (`data-testid="model-picker-trigger"`) that opens
`ModelPicker` (`components/panels/widgets/ModelPicker.tsx`). The picker fetches the
session's advertised models from `app/api/sessions/[id]/model/route.ts` and calls
`session.setModel` on selection. The `/model <id>` slash command (`runNative` in
`app/[workspaceId]/page.tsx`) is a second path.

## Decision
ALREADY_EXISTS. Model switching is the `ModelPicker` popover on the `SessionCard`
plus the `/model` command, backed by `app/api/sessions/[id]/model/route.ts`. The
literal Option+P chord isn't bound (no value in remapping it), but the capability
has a full surface.
