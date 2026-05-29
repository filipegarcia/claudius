# CLAUDE_CODE_CERT_STORE

**Source:** Claude Code cheat sheet — Config & Env — Environment Variables
**Status:** NOT_APPLICABLE

## What it is
Selects which TLS CA certificate store to use (bundled vs. system), for environments behind TLS-inspecting proxies or with custom corporate CAs.

## Claudius today
No dedicated surface. This is a low-level networking/TLS knob with no settings.json key and no observable browser behavior. It can be entered as a raw key in the Settings → Environment editor (`app/settings/page.tsx`), but it has no UI worth building — verifying it works requires inspecting TLS handshakes, not the app.

## Decision
NOT_APPLICABLE. Advanced TLS/CA-store env var with no user-visible browser behavior and no settings.json mapping. It is reachable (without value) via the generic Environment editor; a dedicated control would be an opaque advanced toggle no user could meaningfully verify in the browser.
