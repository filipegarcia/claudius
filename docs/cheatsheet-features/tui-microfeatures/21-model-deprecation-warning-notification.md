# model-deprecation-warning ambient banner

**Source:** Claude Code TUI — model state
**Status:** MISSING

## What it is
An ambient notification kind `model-deprecation-warning` that fires at high priority when the user's selected model is deprecated, distinct from the runtime fallback that swaps the model under load. The binary strings show the kind paired with `warning` severity and `high` priority (and a second occurrence paired with `immediate`), so the warning is meant to surface up-front rather than waiting for the next request to fail over.

## Claudius today
Not surfaced in Claudius. `lib/shared/notifications.ts` defines six `NotificationKind`s (`permission_request`, `ask_user_question`, `plan_approval_request`, `session_error`, `session_idle`, `scheduled_run_finished`) — none of them carry a severity/priority axis and none track model deprecation. `components/panels/widgets/ModelPicker.tsx` lists `supportedModels()` from the SDK but doesn't flag deprecated entries, and `lib/client/use-session.ts`'s `model_changed` reducer only records the new id. It would naturally live as a new notification kind on the bus (`lib/server/notification-bus.ts`) plus a deprecation-aware badge on `ModelPicker.tsx` / a banner near `components/chat/StatusLine.tsx`.

## Decision
MISSING. Claudius surfaces no model-deprecation signal today; the picker treats every SDK-advertised model as equally healthy and the notification bus has no `model-deprecation-warning` kind. Worth adding as a high-priority banner (and matching `NotificationKind`) driven off the SDK's deprecation metadata, so a user pinned to a soon-to-be-retired model finds out before the next fallback rather than after.
