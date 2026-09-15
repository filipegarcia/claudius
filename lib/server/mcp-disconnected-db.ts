import { openDb } from "./db";

/**
 * Persisted "already told the user this MCP server disconnected" flags (CC
 * 2.1.273 parity: "Added a notification when an MCP server disconnects
 * mid-session and automatic reconnection gives up, pointing at `/mcp`").
 * Scoped to the per-cwd `.claudius.db`, mirroring `mcp-needs-auth-db.ts`
 * exactly — same dedup shape, different source status (`failed` instead of
 * `needs-auth`). See `db-migrations/023_mcp_disconnected_notified.sql` for
 * the table and the clearing rationale.
 *
 * `syncDisconnectedNotifications` is the single entry point: given the
 * servers currently observed as `failed`, it returns only the ones that
 * haven't been announced yet (for the caller to broadcast), records them as
 * announced, and clears any previously-announced server that is no longer
 * `failed` — so a server that disconnects again later re-announces instead
 * of staying silent forever. Call with an empty array on every check (even
 * when nothing is currently failed) so stale entries still get cleared.
 *
 * Fails open: if the DB can't be opened, every server is treated as
 * unannounced rather than silently suppressing the notice.
 */
export async function syncDisconnectedNotifications(
  cwd: string,
  currentFailedServers: string[],
): Promise<string[]> {
  const db = await openDb(cwd).catch(() => null);
  if (!db) return currentFailedServers;

  const sync = db.transaction((servers: string[]) => {
    const already = new Set(
      (
        db.prepare(`SELECT server_name FROM mcp_disconnected_notified`).all() as Array<{
          server_name: string;
        }>
      ).map((r) => r.server_name),
    );

    const stillFailed = new Set(servers);
    const del = db.prepare(`DELETE FROM mcp_disconnected_notified WHERE server_name = ?`);
    for (const name of already) {
      if (!stillFailed.has(name)) del.run(name);
    }

    const toAnnounce = servers.filter((name) => !already.has(name));
    const now = Date.now();
    const insert = db.prepare(
      `INSERT INTO mcp_disconnected_notified(server_name, notified_at) VALUES (?, ?)
       ON CONFLICT(server_name) DO UPDATE SET notified_at = excluded.notified_at`,
    );
    for (const name of toAnnounce) insert.run(name, now);

    return toAnnounce;
  });

  return sync(currentFailedServers);
}
