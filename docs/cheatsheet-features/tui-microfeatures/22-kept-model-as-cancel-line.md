# 'Kept model as <X>' on /model cancel

**Source:** Claude Code TUI — model state
**Status:** MISSING

## What it is
If you open the `/model` menu and cancel out without picking anything, the TUI emits a system transcript line `Kept model as <name>` so there is a written record of the (non-)change. The binary strings show `tengu_model_command_menu` adjacent to `cancel` and `Kept model as ` followed by `system`, confirming a system-line transcript entry on cancel — a power-user safeguard so the chat log reflects the deliberate dismissal.

## Claudius today
Not surfaced in Claudius. `components/panels/widgets/ModelPicker.tsx` is a popover anchored on the SessionCard (`components/panels/widgets/SessionCard.tsx`); closing it without picking a model just calls `onClose()` and emits nothing to the transcript. It would naturally live as a synthetic system event appended through `lib/server/session.ts` when the picker dismisses without a `onPickModel` call.

## Decision
MISSING. Low-value to port: Claudius' model picker is a discoverable popover next to a persistent current-model chip, so the "did I change it or not?" ambiguity the TUI line solves does not really exist here. Worth revisiting only if users start asking for transcript breadcrumbs around model toggles.
