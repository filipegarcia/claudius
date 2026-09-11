-- v21: track which MCP servers we've already told the user need auth.
--
-- CC 2.1.268 parity — the upstream "N MCP servers need authentication"
-- startup notice now announces each server once instead of at every
-- launch. Claudius's equivalent (`mcp_needs_auth_notice` SSE event →
-- transcript info pill, CC 2.1.193 parity) previously gated on an
-- in-memory `Session.mcpNeedsAuthNoticeFired` flag, which resets on every
-- new session — i.e. it re-nagged on every launch, exactly the upstream
-- pre-2.1.268 behavior.
--
-- This table persists the "already announced" flag per server name,
-- scoped to the per-cwd `.claudius.db` (workspace isolation is implicit,
-- same convention as `loop_ticks` — see `loop-ticks-db.ts`).
--
-- The flag is deliberately NOT permanent: a row is deleted as soon as
-- `mcpServerStatus()` observes that server leaving `needs-auth` (the user
-- authenticated). That way a later, genuinely new needs-auth episode
-- (e.g. the token expires again) re-announces instead of going silent
-- forever. The standing signal for "still needs auth right now" stays
-- the `/mcp` page's per-server status badge, which is unaffected by this
-- table — this only dedupes the one-shot transcript pill.
CREATE TABLE IF NOT EXISTS mcp_needs_auth_notified (
  server_name TEXT PRIMARY KEY,
  notified_at INTEGER NOT NULL
);
