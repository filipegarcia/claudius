import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db";

export type AssetRow = {
  hash: string;
  mediaType: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  firstSeenMs: number;
  lastSeenMs: number;
  uses: number;
  /** Best-effort cwd this row was read from (for "Account" scope, where rows can come from many projects). */
  cwd?: string;
};

export type Scope = "project" | "account";
export type TypeFilter = "image" | "file" | "all";

type DbRow = {
  hash: string;
  media_type: string;
  size_bytes: number;
  width: number | null;
  height: number | null;
  first_seen_ms: number;
  last_seen_ms: number;
  uses: number;
};

function rowToAsset(r: DbRow, cwd?: string): AssetRow {
  return {
    hash: r.hash,
    mediaType: r.media_type,
    sizeBytes: r.size_bytes,
    width: r.width ?? undefined,
    height: r.height ?? undefined,
    firstSeenMs: r.first_seen_ms,
    lastSeenMs: r.last_seen_ms,
    uses: r.uses,
    cwd,
  };
}

function applyTypeFilter(sql: string, type: TypeFilter): string {
  if (type === "image") return sql + " AND a.media_type LIKE 'image/%'";
  if (type === "file") return sql + " AND a.media_type NOT LIKE 'image/%'";
  return sql;
}

async function listProject(
  cwd: string,
  type: TypeFilter,
  q: string,
  limit: number,
  cursorLastSeenMs?: number,
): Promise<AssetRow[]> {
  let db: import("./db").DB;
  try {
    db = await openDb(cwd, "readwrite"); // create on first read so we can write later
  } catch {
    return [];
  }
  let sql = `
    SELECT a.hash AS hash,
           a.media_type AS media_type,
           a.size_bytes AS size_bytes,
           a.width AS width,
           a.height AS height,
           a.first_seen_ms AS first_seen_ms,
           a.last_seen_ms AS last_seen_ms,
           (SELECT COUNT(*) FROM asset_uses u WHERE u.asset_hash = a.hash) AS uses
    FROM assets a
    WHERE 1=1
  `;
  const params: (string | number)[] = [];
  sql = applyTypeFilter(sql, type);
  if (q) {
    sql += " AND (a.hash LIKE ? OR a.hash IN (SELECT asset_hash FROM asset_uses WHERE session_id LIKE ?))";
    params.push(q + "%", "%" + q + "%");
  }
  if (cursorLastSeenMs != null) {
    sql += " AND a.last_seen_ms < ?";
    params.push(cursorLastSeenMs);
  }
  sql += " ORDER BY a.last_seen_ms DESC LIMIT ?";
  params.push(limit);
  const rows = db.prepare(sql).all(...params) as DbRow[];
  return rows.map((r) => rowToAsset(r, cwd));
}

async function listAccount(
  type: TypeFilter,
  q: string,
  limit: number,
  cursorLastSeenMs?: number,
): Promise<AssetRow[]> {
  const projectsRoot = join(homedir(), ".claude", "projects");
  let entries: string[] = [];
  try {
    entries = await fs.readdir(projectsRoot);
  } catch {
    return [];
  }
  // Find directories that contain a .claudius.db (already-indexed projects).
  const decoded: { encoded: string; cwd: string }[] = [];
  for (const name of entries) {
    const dbFile = join(projectsRoot, name, ".claudius.db");
    try {
      await fs.access(dbFile);
    } catch {
      continue;
    }
    // Decode the project dir back to its original absolute path. The encoding
    // is one-way (every non-alphanumeric → "-"), so the cwd shown here is a
    // best-effort; we keep it as the encoded path. Detail UI links use the
    // encoded path as a stable identifier.
    decoded.push({ encoded: name, cwd: name });
  }
  const all: AssetRow[] = [];
  for (const { encoded, cwd } of decoded) {
    void cwd;
    // Open each project DB readonly. We can't go through openDb() because the
    // helper takes a real cwd; reach in directly.
    let db: import("better-sqlite3").Database;
    try {
      // Lazy import to avoid pulling sql when project scope alone is used.
      const Database = (await import("better-sqlite3")).default;
      db = new Database(join(projectsRoot, encoded, ".claudius.db"), { readonly: true, fileMustExist: true });
    } catch {
      continue;
    }
    let sql = `
      SELECT a.hash AS hash,
             a.media_type AS media_type,
             a.size_bytes AS size_bytes,
             a.width AS width,
             a.height AS height,
             a.first_seen_ms AS first_seen_ms,
             a.last_seen_ms AS last_seen_ms,
             (SELECT COUNT(*) FROM asset_uses u WHERE u.asset_hash = a.hash) AS uses
      FROM assets a
      WHERE 1=1
    `;
    const params: (string | number)[] = [];
    sql = applyTypeFilter(sql, type);
    if (q) {
      sql += " AND a.hash LIKE ?";
      params.push(q + "%");
    }
    sql += " ORDER BY a.last_seen_ms DESC LIMIT 200";
    try {
      const rows = db.prepare(sql).all(...params) as DbRow[];
      for (const r of rows) all.push(rowToAsset(r, encoded));
    } catch {
      // ignore — schema might be newer/older
    } finally {
      db.close();
    }
  }
  all.sort((a, b) => b.lastSeenMs - a.lastSeenMs);
  let from = 0;
  if (cursorLastSeenMs != null) {
    from = all.findIndex((r) => r.lastSeenMs < cursorLastSeenMs);
    if (from < 0) from = all.length;
  }
  return all.slice(from, from + limit);
}

export async function listAssets(opts: {
  scope: Scope;
  cwd: string;
  type?: TypeFilter;
  q?: string;
  limit?: number;
  cursor?: number;
}): Promise<{ items: AssetRow[]; nextCursor?: number }> {
  const limit = Math.min(Math.max(1, opts.limit ?? 60), 500);
  const items =
    opts.scope === "project"
      ? await listProject(opts.cwd, opts.type ?? "all", opts.q ?? "", limit, opts.cursor)
      : await listAccount(opts.type ?? "all", opts.q ?? "", limit, opts.cursor);
  const last = items[items.length - 1];
  return { items, nextCursor: items.length === limit && last ? last.lastSeenMs : undefined };
}

export type UseRow = {
  sessionId: string;
  messageUuid: string;
  ordinal: number;
  occurredMs: number;
};

export async function listUses(cwd: string, hash: string): Promise<UseRow[]> {
  let db: import("./db").DB;
  try {
    db = await openDb(cwd);
  } catch {
    return [];
  }
  const rows = db
    .prepare<[string], { session_id: string; message_uuid: string; ordinal: number; occurred_ms: number }>(
      `SELECT session_id, message_uuid, ordinal, occurred_ms
       FROM asset_uses WHERE asset_hash = ? ORDER BY occurred_ms DESC`,
    )
    .all(hash);
  return rows.map((r) => ({
    sessionId: r.session_id,
    messageUuid: r.message_uuid,
    ordinal: r.ordinal,
    occurredMs: r.occurred_ms,
  }));
}

export async function getAssetMeta(cwd: string, hash: string): Promise<AssetRow | null> {
  let db: import("./db").DB;
  try {
    db = await openDb(cwd);
  } catch {
    return null;
  }
  const row = db
    .prepare<[string], DbRow | undefined>(
      `SELECT a.hash AS hash,
              a.media_type AS media_type,
              a.size_bytes AS size_bytes,
              a.width AS width,
              a.height AS height,
              a.first_seen_ms AS first_seen_ms,
              a.last_seen_ms AS last_seen_ms,
              (SELECT COUNT(*) FROM asset_uses u WHERE u.asset_hash = a.hash) AS uses
       FROM assets a WHERE a.hash = ?`,
    )
    .get(hash);
  if (!row) return null;
  return rowToAsset(row, cwd);
}

export async function deleteAssetRow(cwd: string, hash: string): Promise<boolean> {
  let db: import("./db").DB;
  try {
    db = await openDb(cwd);
  } catch {
    return false;
  }
  const info = db.prepare("DELETE FROM assets WHERE hash = ?").run(hash);
  return info.changes > 0;
}
