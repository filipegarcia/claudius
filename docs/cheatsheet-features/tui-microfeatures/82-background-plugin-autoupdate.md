# Background plugin/marketplace auto-update with restart notification

**Source:** Claude Code TUI — plugins-output-styles
**Status:** UNVERIFIED

## What it is
Marketplaces with `autoUpdate` enabled (the default for Anthropic's official marketplaces) are refreshed at startup, and installed plugins from those marketplaces get updated in-place on disk. Since a running plugin can't be hot-swapped, the REPL is handed a restart notification listing the updated plugin names — and because the update can race the REPL mount, the leak in `utils/plugins/pluginAutoupdate.ts` explicitly buffers them: `Store pending updates that occurred before callback was registered // This handles the race condition where updates complete before REPL mounts let pendingNotification: string[] | null = null`. As soon as a callback registers, the queued list is flushed.

## Claudius today
Not surfaced in Claudius. The plugins surface (`app/plugins/page.tsx` + `lib/server/plugins.ts` + `app/api/plugins/reload/route.ts`) handles enable/disable, marketplace config, install via `/plugin install <ref>`, and a manual `session.reloadPlugins()` (wired through `lib/client/usePlugins.ts`'s `reload()` action and rendered as a "Reload" button on the plugins page) — but there is no background marketplace refresh on startup, no per-marketplace `autoUpdate` flag in `PluginsByScope` / `setMarketplaces`, and no "the following plugins were updated — restart to apply" banner. The natural home would be a startup hook in `lib/server/plugins.ts` that walks `~/.claude/plugins/marketplaces/` (already enumerated by `listAvailable`), refreshes those whose manifests opt in, and emits an SSE event consumed by `lib/client/use-session.ts` so a chat-surface banner (alongside the existing `SessionRecapBanner` / Fast-mode notice patterns) can prompt the user to hit the existing Reload action.

## Decision
UNVERIFIED. The behaviour is leak-only (`utils/plugins/pluginAutoupdate.ts`, comment quoted above) with `binary_grep_count: 0`, so the contract — when the refresh actually fires, what triggers `autoUpdate`, what the restart notification looks like — could not be confirmed against shipped binary strings. Claudius already has the swap-half (`session.reloadPlugins()` + the plugins-page Reload button); the missing pieces are the periodic/startup marketplace refresh and the "these plugins changed, reload to pick them up" notification. Worth revisiting once the TUI ships visible strings that pin down the surface.
