# Bridge QR-Code Toggle for Connect URL

**Source:** Claude Code TUI — bridge-remote
**Status:** NOT_APPLICABLE

## What it is
When a session is paired to the Remote Control bridge, the status footer ends in a dim italic hint that toggles with the spacebar — `bridge/bridgeUI.ts` (binary-confirmed, two hits) ships the ternary `HH=M?D_.dim.italic("space to hide QR code"):D_.dim.italic("space to show QR code")`. Pressing space stamps a UTF-8 block-character QR code of the connect URL above the status line so the operator can point a phone camera at the terminal and jump straight into the session in the Claude mobile app — no copy/paste, no typing a deep link.

## Claudius today
Not surfaced in Claudius. The connect URL itself is a property of the claude.ai-hosted bridge — Claudius already classifies the whole family `handler: "external"` in `lib/shared/slash-commands.ts`: `mobile` at line 141 (aliases `ios` / `android`, "Open mobile app via QR") and `remote-control` at line 145 explicitly delegate the QR/pairing flow to claude.ai rather than minting a local URL. There is no Claudius-resident pairing channel for a phone to scan into: every session is driven by the local renderer over same-origin SSE against `lib/server/session.ts`, with no bridge-issued URL to encode. The closest local QR surface is the Electron deep-link handling in `electron/ipc/deep-links.ts` and `lib/client/useDeepLinks.ts`, which open `claudius://` workspace links from the OS rather than projecting a scannable code outward.

## Decision
Not applicable. The space-to-show / space-to-hide QR toggle and its companion connect-URL renderer in `bridge/bridgeUI.ts` are a claude.ai-hosted Remote Control concern — the same `bridge-remote` family already classified `external` in `lib/shared/slash-commands.ts` (`mobile`, `remote-control`, `teleport`, `remote-env`) and previously documented at `docs/cheatsheet-features/tui-microfeatures/85-bridge-environment-resume.md`, `docs/cheatsheet-features/tui-microfeatures/86-bridge-mobile-push-notifications.md`, `docs/cheatsheet-features/tui-microfeatures/87-bridge-multi-session-capacity-meter.md`, and `docs/cheatsheet-features/tui-microfeatures/88-bridge-outbound-only-mirror-mode.md`. Claudius is a local-first wrapper with no hosted pairing URL to encode into a QR, so there is no Claudius surface for the toggle to live on. Deferred — would need the hosted bridge, not a UI addition.
