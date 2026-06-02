# Orphaned Plugin-Version GC (.orphaned_at marker, 7-day retention)

**Source:** Claude Code TUI — plugins-output-styles
**Status:** MISSING

## What it is
When a plugin is updated the previous version isn't deleted — it gets a `.orphaned_at` dotfile and lingers on disk so any concurrent session still mid-tool-call can keep resolving its old skill/agent files. The leak in `utils/plugins/orphanedPluginFilter.ts` is explicit: "When plugin versions are updated, old versions are marked with a `.orphaned_at` file but kept on disk for 7 days (since concurrent sessions might still reference them). During this window, Grep/Glob could return files from orphaned versions, causing Claude to use outdated plugin code." The filter walks the plugins cache, finds every directory with an `.orphaned_at` sibling, and auto-prepends `--glob !<dir>/**` exclusions to Grep/Glob calls so the model never sees the stale code; a background sweep at startup deletes anything past the 7-day cutoff.

## Claudius today
Not surfaced in Claudius. `lib/server/plugins.ts` reads marketplace manifests (`~/.claude/plugins/marketplaces/*/marketplace.json`) and the `enabledPlugins` settings map, but there's no awareness of versioned plugin caches, no `.orphaned_at` writer, no cache-sweep job, and Grep/Glob calls flow through the SDK without any Claudius-side exclusion list. The natural home would be a sibling to `lib/server/plugins.ts` (`lib/server/plugin-cache.ts`) that the session bootstrap calls once, plus an SDK `canUseTool` hook on Grep/Glob to inject the exclusion globs — but since Claudius defers tool execution to `@anthropic-ai/claude-agent-sdk`, the cleaner answer is to let the SDK keep owning it.

## Decision
MISSING. Claudius doesn't manage the plugins cache layout — installs and upgrades go through the Claude Code CLI's own resolver, which is where `utils/plugins/orphanedPluginFilter.ts` runs. The 7-day retention and Grep/Glob filtering are SDK-internal behaviors that Claudius inherits for free whenever the bundled SDK performs a plugin update; there's no Claudius-side surface to add. Worth revisiting only if Claudius ever grows its own plugin installer (today `lib/server/plugins.ts` only toggles `enabledPlugins`, it doesn't fetch or version plugin payloads).
