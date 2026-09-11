import { openDb } from "./db";

/**
 * Persisted "already told the user about this MCP server's needs-auth
 * state" flags (CC 2.1.268 parity: "announce each server once instead of
 * at every launch"). Scoped to the per-cwd `.claudius.db` like
 * `loop-ticks-db.ts`, so workspace isolation is implicit — see
 * `db-migrations/021_mcp_needs_auth_notified.sql` for the table and the
 * clearing rationale.
 *
 * `syncNeedsAuthNotifications` is the single entry point: given the
 * servers currently observed as `needs-auth`, it returns only the ones
 * that haven't been announced yet (for the caller to broadcast), records
 * them as announced, and clears any previously-announced server that is
 * no longer `needs-auth` — so a server that re-enters `needs-auth` later
 * (e.g. a token expiring again) re-announces instead of staying silent
 * forever. Call with an empty array on every check (even when nothing
 * currently needs auth) so stale entries still get cleared.
 *
 * Fails open: if the DB can't be opened, every server is treated as
 * unannounced rather than silently suppressing the notice.
 */
export async function syncNeedsAuthNotifications(
  cwd: string,
  currentNeedsAuthServers: string[],
): Promise<string[]> {
  const db = await openDb(cwd).catch(() => null);
  if (!db) return currentNeedsAuthServers;

  const sync = db.transaction((servers: string[]) => {
    const already = new Set(
      (
        db.prepare(`SELECT server_name FROM mcp_needs_auth_notified`).all() as Array<{
          server_name: string;
        }>
      ).map((r) => r.server_name),
    );

    const stillNeeded = new Set(servers);
    const del = db.prepare(`DELETE FROM mcp_needs_auth_notified WHERE server_name = ?`);
    for (const name of already) {
      if (!stillNeeded.has(name)) del.run(name);
    }

    const toAnnounce = servers.filter((name) => !already.has(name));
    const now = Date.now();
    const insert = db.prepare(
      `INSERT INTO mcp_needs_auth_notified(server_name, notified_at) VALUES (?, ?)
       ON CONFLICT(server_name) DO UPDATE SET notified_at = excluded.notified_at`,
    );
    for (const name of toAnnounce) insert.run(name, now);

    return toAnnounce;
  });

  return sync(currentNeedsAuthServers);
}
