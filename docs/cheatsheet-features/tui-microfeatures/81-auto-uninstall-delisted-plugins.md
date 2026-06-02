# Auto-Uninstall of Delisted Marketplace Plugins

**Source:** Claude Code TUI — plugins-output-styles
**Status:** MISSING

## What it is
On every plugin reconcile pass the CLI walks each marketplace manifest that opts in via `forceRemoveDeletedPlugins` and silently uninstalls any plugin that has been removed upstream. Each delisting is appended to a `flagged` list (in `utils/plugins/pluginBlocklist.ts`) so the user gets exactly one notification per removal — when the auto-uninstall itself fails the binary emits `"Failed to auto-uninstall delisted plugin"`.

## Claudius today
Not surfaced in Claudius. `lib/server/plugins.ts` is enable/disable + marketplace allowlist only: `listAll` reads `enabledPlugins` per scope (line 37), `listAvailable` walks `~/.claude/plugins/marketplaces/*/marketplace.json` to materialize the install picker (line 109), and `setMarketplaces` (line 168) writes `extraKnownMarketplaces` / `strictKnownMarketplaces` / `blockedMarketplaces` into the scoped settings file. There is no reconcile pass that diffs installed-vs-manifest, no `forceRemoveDeletedPlugins` honoring, no `flagged` blocklist analogue, and the install/uninstall path itself just forwards `/plugin install <ref>` into the live session (`lib/client/usePlugins.ts` line 123) so the SDK does the work; the natural home for an auto-uninstall sweep would be a new `reconcileDelisted` helper in `lib/server/plugins.ts` invoked from `app/api/plugins/reload/route.ts`, with a one-shot toast on the next `/plugins` page load.

## Decision
MISSING. Claudius reads the same marketplace cache the TUI does but never reconciles it against the installed set, so a plugin yanked upstream stays "installed" indefinitely. Following the TUI's contract from `utils/plugins/pluginBlocklist.ts` would mean: a server-side sweep that compares each scope's `enabledPlugins` against the manifests under `~/.claude/plugins/marketplaces/`, gated on the marketplace declaring `forceRemoveDeletedPlugins`; a persisted `flagged` list (a new column on the plugins migration, or a JSON sidecar) so the notification only fires once per removal; and a single in-app toast routed through `components/notifications/NotificationsProvider.tsx` mirroring the binary's `"Failed to auto-uninstall delisted plugin"` error path. Until then, users have to spot delisted plugins by hand from `/plugins`.
