# Hot-Reload of keybindings.json with Validation Warnings

**Source:** Claude Code TUI — keybindings-vim-voice
**Status:** MISSING

## What it is
The CLI watches `~/.claude/keybindings.json` with chokidar — `src/keybindings/loadUserBindings.ts` calls `watcher = chokidar.watch(userPath, { persistent: true, ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: FILE_STABILITY_THRESHOLD_MS, pollInterval: FILE_STABILITY_POLL_INTERVAL_MS }, ignorePermissionErrors: true, usePolling: false, atomic: true })` (500 ms stability window, 200 ms poll). On change it re-parses the file and re-runs `validateBindings`, surfacing inline warnings keyed `parse_error` / `duplicate` / `reserved` / `invalid_context` / `invalid_action` (including JSON-level duplicate keys that `JSON.parse` silently drops), and fires a once-per-day `tengu_custom_keybindings_loaded` telemetry event.

## Claudius today
Not surfaced in Claudius. `lib/server/keybindings.ts` only exposes `readKeybindings` / `writeKeybindings` (a thin `fs.readFile` + `JSON.parse` over `~/.claude/keybindings.json`); the editor at `app/[workspaceId]/keybindings/page.tsx` writes via `PUT /api/keybindings` and does a manual refetch on save. There is no file watcher, no validator, no warnings panel for `duplicate` / `reserved` / `invalid_context` / `invalid_action`, no JSON-duplicate-key detection (raw-JSON save just does `JSON.parse(rawDraft)`), and no telemetry event. The natural home for a watcher would be `lib/server/keybindings.ts` (chokidar watch + a small `validateBindings` returning the same five warning codes) bridged through the existing `/api/keybindings` route to the editor page.

## Decision
MISSING. The hot-reload + validation surface from `src/keybindings/loadUserBindings.ts` has no counterpart — Claudius reads `keybindings.json` once per page load via `lib/server/keybindings.ts` and never re-reads on disk change. Adding a chokidar watcher (with the same 500 ms `stabilityThreshold` / 200 ms `pollInterval`) plus a `validateBindings` pass that emits `parse_error` / `duplicate` / `reserved` / `invalid_context` / `invalid_action` warnings into the editor would close the gap; the JSON-level duplicate-key check needs a tolerant parser since `JSON.parse` drops them silently. Telemetry can ride on the existing settings/telemetry plumbing as a once-per-day event.
