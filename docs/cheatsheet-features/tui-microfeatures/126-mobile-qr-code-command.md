# /mobile — QR Code to Install Claude Mobile App

**Source:** Claude Code TUI — commands
**Status:** PARTIAL

## What it is
`/mobile` (aliases `/ios`, `/android`) renders an in-terminal QR code pointing at the iOS App Store and Google Play listings for the Claude mobile app, with a platform switcher and Show/Hide QR keyboard controls. The leak in `commands/mobile/mobile.tsx` registers it as `{type:"local-jsx",name:"mobile",aliases:["ios","android"],description:"Show QR code to download the Claude mobile app"` — a local-JSX command, so the TUI owns the rendering rather than handing it off to an external opener.

## Claudius today
The command is *listed* in Claudius's static slash-command registry: `lib/shared/slash-commands.ts:141` carries `{ id: "mobile", name: "mobile", aliases: ["ios", "android"], description: "Open mobile app via QR.", category: "platform", handler: "external" }`, so it surfaces in the `/` picker alongside `/desktop`, `/passes`, and `/stickers`. There is no actual handler behind it — Claudius has no QR-rendering component (a repo-wide grep for `qrcode` / `apps.apple.com` / `play.google.com` returns zero hits), no platform switcher, and no Show/Hide QR control. The `handler: "external"` tag would route execution outside Claudius, but no external destination is wired for this entry, so today the command shows up in the picker and then does nothing on submit. The natural surface would be a `components/chat/MobileQrDialog.tsx` modal triggered from the slash dispatcher, mirroring how `/desktop` is handled.

## Decision
PARTIAL. The picker entry exists at `lib/shared/slash-commands.ts:141` with the correct name + aliases + description, but Claudius is missing the JSX surface that the leak in `commands/mobile/mobile.tsx` implies — an in-app QR code for the App Store and Play Store with a platform toggle and Show/Hide chord. To close the gap, flip the registry entry to `handler: "native"`, intercept it in the slash dispatcher, and render a small dialog (qrcode lib of choice) with two tabs (iOS / Android) pointing at the canonical store URLs, plus a Show/Hide toggle for terminals/screens where the QR is noisy.
