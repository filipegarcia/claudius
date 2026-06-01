# Remote-session model switch rejection notice

**Source:** Claude Code TUI — error & recovery
**Status:** PARTIAL

## What it is
When `/model` is invoked inside a remote/teleport session and the host rejects the switch, the TUI surfaces a clear `Remote session couldn't switch to <model>` notice instead of silently failing. Grounded in the binary strings `[remote] set_model rejected:`, `model_switch`, `remote_rejected`, and `Remote session couldn't switch to ` appearing contiguously in the CLI.

## Claudius today
Claudius surfaces the generic (non-remote) form of this notice through `components/chat/ModelSwitchNoticePanel.tsx`, rendered from `app/[workspaceId]/page.tsx` with the `session.modelSwitchNotice` state owned by `lib/client/use-session.ts`. The `setModel` callback there POSTs to `app/api/sessions/[id]/model/route.ts` (which calls `Session.setModel` in `lib/server/session.ts`); on a 409 the client reverts the optimistic pill to the server-authoritative model and pushes a `{ attempted, error }` notice that the panel renders as `Couldn't switch to <model>` with the SDK error underneath. The panel's own comment calls out the gap: Claudius has no remote/teleport concept, so the copy is the generic "Couldn't switch to ..." rather than the TUI's remote-specific "Remote session couldn't switch to ...".

## Decision
PARTIAL. The rejection path itself is covered — picker reverts, banner surfaces the attempted model and SDK error — but the remote-session framing from the TUI string doesn't apply because every Claudius session runs against the local SDK. No follow-up needed unless a remote/teleport surface is ever added to Claudius, at which point the headline in `ModelSwitchNoticePanel.tsx` could branch on a remote flag.
