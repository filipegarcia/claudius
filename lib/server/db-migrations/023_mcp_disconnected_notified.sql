-- v23: track which MCP servers we've already told the user disconnected.
--
-- CC 2.1.273 parity — "Added a notification when an MCP server disconnects
-- mid-session and automatic reconnection gives up, pointing at /mcp".
--
-- Mirrors `021_mcp_needs_auth_notified.sql`'s dedup shape exactly, but keyed
-- on the `failed` status instead of `needs-auth`: Claudius has no push
-- signal for "the SDK's own auto-reconnect loop just gave up" (the SDK only
-- exposes a pull-based `mcpServerStatus()` control call — see
-- `mcp-disconnected-db.ts` and `Session.noteMcpDisconnectedAtStartup()` for
-- the conservative interpretation this implements), so a server observed as
-- `failed` at a status check is treated as the proxy for "disconnected, and
-- not currently reconnecting on its own".
--
-- Same non-permanent shape as v21: a row is deleted as soon as
-- `mcpServerStatus()` observes that server leaving `failed`, so a later,
-- genuinely new disconnect episode re-announces instead of going silent
-- forever. The `/mcp` page's per-server status badge is unaffected — this
-- only dedupes the one-shot transcript pill.
CREATE TABLE IF NOT EXISTS mcp_disconnected_notified (
  server_name TEXT PRIMARY KEY,
  notified_at INTEGER NOT NULL
);
