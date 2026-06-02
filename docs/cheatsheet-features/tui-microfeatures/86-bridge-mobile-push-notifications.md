# Bridge Push Notifications to Mobile Claude App

**Source:** Claude Code TUI — bridge-remote
**Status:** NOT_APPLICABLE

## What it is
The TUI's Notify tool prompt (binary-confirmed, two hits) reads "Send a notification to the user via their terminal and, when Remote Control is connected, also push to their mobile device" — the contract lives in `bridge/bridgeMessaging.ts`. When the local CLI is paired with a claude.ai Remote Control bridge environment, the same `Notify` tool call that buzzes the user's terminal additionally fans out to the user's mobile Claude app, so a developer who walked away from their desk still gets pinged when the agent finishes or wants attention.

## Claudius today
Not surfaced in Claudius. There is a complete *local* notification stack — `lib/server/notification-bus.ts` fans events into per-workspace inboxes, `lib/client/useNotifications.ts` raises a browser/OS popup (gated by `useAttentionRef`), `components/notifications/NotificationsProvider.tsx` wires it to the SSE stream, and the Electron build escalates the same call through `electron/ipc/notifications.ts` so the OS gets a native banner — but nothing pushes outward to a *remote* mobile device. Claudius is already mobile-*aware* (`/mobile` opens the mobile app via QR at `lib/shared/slash-commands.ts:141`, `/remote-control` at `:145`) yet both commands are tagged `handler: "external"` because they delegate to claude.ai's hosted backend; there is no Claudius-resident transport to ride.

## Decision
Not applicable. The "also push to their mobile device" arm of the Notify tool described in `bridge/bridgeMessaging.ts` is a property of the claude.ai-hosted Remote Control bridge, not of the Agent SDK — the same `bridge-remote` family already classified `external` in `lib/shared/slash-commands.ts` and previously documented at `docs/cheatsheet-features/tui-microfeatures/85-bridge-environment-resume.md` and `docs/cheatsheet-features/workflows-tips/26-web-session.md`. Claudius is a local-first wrapper with a full local-and-OS notification pipeline but no hosted bridge environment to push through, so this is a transport gap rather than a UI omission. Deferred — would need the hosted bridge, not new Claudius plumbing.
