# LSP Plugin Recommendation on File Edit

**Source:** Claude Code TUI — hooks-ux
**Status:** MISSING

## What it is
A one-shot install nudge driven off the agent's edit stream. The leak in `hooks/useLspPluginRecommendation.tsx` spells out the gate exactly: "Detects file edits and recommends LSP plugins when: - File extension matches an LSP plugin - LSP binary is already installed on the system - Plugin is not already installed - User hasn't disabled recommendations Only shows one recommendation per session." Tripping all four conditions surfaces a yes/no/never/disable prompt for the matching plugin, and the answer is remembered via a never-suggest list plus a shown-this-session flag.

## Claudius today
Not surfaced in Claudius. There is a plugin surface — `app/plugins/page.tsx`, `lib/client/usePlugins.ts`, `lib/server/plugins.ts`, `app/api/plugins/route.ts` — but it is a marketplace browse/install UI driven off `~/.claude/plugins/marketplaces/**/marketplace.json` and `install-counts-cache.json`; it has no edit-driven trigger, no LSP-binary probe, no per-extension plugin map, and no never-suggest list. The hook plumbing the recommendation would key off (`PostToolUse` for Edit/Write, surfaced via `lib/shared/hook-events.ts` and `lib/server/session.ts`) is present, and a sibling LSP code-intelligence tool is documented as `MISSING` in `docs/cheatsheet-features/tui-microfeatures/120-lsp-code-intelligence-tool.md`. The natural home would be a new `lib/client/useLspPluginRecommendation.ts` that watches the session's edit events, an extension-to-plugin table (probably colocated in `lib/server/plugins.ts`), a server-side `which`/`PATH` probe for the LSP binary, and a one-shot dismissible chip near the composer — with the never-suggest decision persisted in the per-project `.claudius.db` (see `lib/server/db-migrations/`).

## Decision
MISSING. The Claudius plugin surface is purely browse/install — nothing watches the agent's edit stream, probes for an installed LSP binary, or shows a one-shot "install this LSP plugin?" prompt. Per `hooks/useLspPluginRecommendation.tsx` the upstream contract is tightly scoped (four gates, four answers, one-per-session) and would be a small, satisfying nudge to adopt, but it presupposes (a) a curated extension-to-plugin table, (b) the per-workspace LSP infrastructure that #120 already flags as real work, and (c) a never-suggest store. Worth queueing behind the LSP tool itself — recommending a plugin we can't yet drive is putting the cart before the horse.
