# claude update

**Source:** Claude Code cheat sheet — CLI & Flags
**Status:** ALREADY_EXISTS

## What it is
`claude update` updates the Claude Code installation to the latest version.

## Claudius today
The updater page (`app/updater/page.tsx`) shows current/available versions and a one-click apply, backed by `app/api/updater/{check,status,apply}/route.ts` and `lib/server/updater/apply.ts`. There is also an updater settings section (`components/updater/UpdaterSettingsSection.tsx`) for channel and auto-update behavior.

## Decision
Already covered. The updater page is the browser surface for self-update: check, apply (with a Claude-merge fallback), and restart. Settings expose the release channel and auto-update toggle. No new UI needed.
