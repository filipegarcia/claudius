# Remote-session model switch rejection notice

**Source:** Claude Code TUI — error & recovery
**Status:** MISSING

## What it is
When `/model` is invoked inside a remote/teleport session and the host rejects the switch, the TUI surfaces a clear `Remote session couldn't switch to <model>` notice instead of silently failing. Grounded in the binary strings `[remote] set_model rejected:`, `model_switch`, `remote_rejected`, and `Remote session couldn't switch to ` appearing contiguously in the CLI.

## Claudius today
Not surfaced in Claudius. The model picker (`components/panels/widgets/ModelPicker.tsx` backed by `app/api/sessions/[id]/model/route.ts` → `Session.setModel` in `lib/server/session.ts`) calls `query.setModel(model).catch(() => {})` and swallows failures; there is no remote-session concept in Claudius, since the browser is the only "remote" surface and it talks straight to the local SDK. A natural home for an equivalent banner would be `components/panels/widgets/ModelPicker.tsx`, toasting when `setModel` resolves but the SDK's subsequent state shows the model unchanged.

## Decision
MISSING. The TUI-specific remote/teleport rejection path has no analogue in Claudius — every session is local to the host running the app. Worth adding a lightweight "model switch didn't take" toast in `ModelPicker.tsx` only if users start reporting silent failures; otherwise no action needed.
