# model-deprecation-warning ambient banner

**Source:** Claude Code TUI — model state
**Status:** PARTIAL

## What it is
An ambient notification kind `model-deprecation-warning` that fires at high priority when the user's selected model is deprecated, distinct from the runtime fallback that swaps the model under load. The binary strings show the kind paired with `warning` severity and `high` priority (and a second occurrence paired with `immediate`), so the warning is meant to surface up-front rather than waiting for the next request to fail over.

## Claudius today
Partially covered. `lib/shared/model-deprecations.ts` mirrors the SDK's internal `jw` deprecation map (model id to EOL date string, snapshot taken from `claude-agent-sdk` @ 2026-Q2), and `components/chat/StatusLine.tsx` promotes the active-model label to an amber `AlertTriangle` pill (`data-testid="status-line-model-deprecated"`) with a `title` carrying the EOL date when `modelDeprecationDate(model)` returns a hit — so the user sees the warning up-front rather than after a fallback. What's missing is the matching `NotificationKind`: `lib/shared/notifications.ts` defines `permission_request`, `ask_user_question`, `plan_approval_request`, `session_error`, `session_idle`, `scheduled_run_finished` — no `model-deprecation-warning` kind with a severity/priority axis, and `components/panels/widgets/ModelPicker.tsx` doesn't flag deprecated entries in the picker itself.

## Decision
PARTIAL. The StatusLine deprecation chip already surfaces the signal up-front from the same EOL data the SDK uses, which is the user-visible half of the TUI's `warning`/`high` ambient banner. The missing half is a real notification on `lib/server/notification-bus.ts` (so OS/in-app notifs fire when a session starts on a deprecated model) and a deprecated badge inside `ModelPicker.tsx` so users can't silently re-pin to an EOL model from the picker.
