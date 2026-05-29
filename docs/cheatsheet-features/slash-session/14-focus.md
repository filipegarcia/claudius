# /focus

**Source:** Claude Code cheat sheet — Slash Commands — Session
**Status:** NOT_APPLICABLE

## What it is
Toggles a focus view in fullscreen — a terminal-UI affordance that collapses chrome so only the conversation is shown.

## Claudius today
Registered in `lib/shared/slash-commands.ts` (`id: "focus"`, category `ui`, handler `sdk`) and forwarded to the SDK. There is no Claudius browser surface for it, and it maps to a terminal/TUI rendering concern (fullscreen focus) rather than a web feature.

## Decision
NOT_APPLICABLE. This is a terminal/TUI presentation toggle with no meaningful browser equivalent — the web app already has its own layout chrome (SideNav, panels) and browser-native fullscreen. Adding a "focus" mode would be a cosmetic re-implementation, not a feature parity gap, so no surface is warranted. The slash is harmlessly forwarded to the SDK.
