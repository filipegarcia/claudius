// Pure helpers for the SDK 0.3.268 `reloadPlugins({ holdOnCacheImpact })`
// hold-before-you-drop-the-cache guard.
//
// `Session.reloadPlugins()` (lib/server/session.ts) defaults to
// `holdOnCacheImpact: true` — the same check the interactive CLI's
// `/reload-plugins` makes before it asks for `--force`. When applying would
// change the session's tool list while the conversation's prompt cache
// depends on that list, the CLI does NOT apply the reload; it reports
// `held: true` plus a `cache_impact` summary of what applying would change.
// The `/reload-plugins force` chat command re-sends with
// `holdOnCacheImpact: false` to apply anyway.
//
// Extracted from the call sites so the toast-copy logic is unit-testable
// without mounting `ChatSurface` or hitting a live SDK session.

export type ReloadPluginsCacheImpact = {
  mcp_servers_added?: string[];
  mcp_servers_removed?: string[];
  lsp_tool_change?: "adds" | "may-add" | "removes" | "may-remove" | null;
};

export type ReloadPluginsResult = {
  held?: boolean;
  cache_impact?: ReloadPluginsCacheImpact;
};

/** Query-param convention shared by the reload route and the chat command. */
export function isForceReload(value: string | null | undefined): boolean {
  return value === "1" || value === "true";
}

/**
 * Toast copy for the result of a `reloadPlugins()` call: a plain "reloaded"
 * confirmation, or — when the reload was held on cache impact — a summary of
 * what applying it would change plus the escape hatch (`/reload-plugins
 * force`). Tolerant of a malformed/missing payload (treated as a plain
 * success) since `data` arrives as `unknown` off the wire.
 */
export function describeReloadPluginsResult(data: unknown): string {
  const r = (data ?? {}) as ReloadPluginsResult;
  if (!r.held) return "Plugins reloaded";

  const impact = r.cache_impact;
  const added = impact?.mcp_servers_added?.length ?? 0;
  const removed = impact?.mcp_servers_removed?.length ?? 0;
  const lsp = impact?.lsp_tool_change ?? null;

  const parts: string[] = [];
  if (added) parts.push(`+${added} MCP server${added === 1 ? "" : "s"}`);
  if (removed) parts.push(`-${removed} MCP server${removed === 1 ? "" : "s"}`);
  if (lsp === "adds" || lsp === "may-add") parts.push("adds LSP tool");
  if (lsp === "removes" || lsp === "may-remove") parts.push("removes LSP tool");

  const summary = parts.length ? ` — ${parts.join(", ")}` : "";
  return `Reload held (would invalidate the prompt cache)${summary}. Run /reload-plugins force to apply.`;
}
