import { promises as fs } from "node:fs";
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { encodeProjectDir } from "./auto-memory";

export type DB = Database.Database;

const handles = new Map<string, DB>();

function dbPath(cwd: string): string {
  return join(homedir(), ".claude", "projects", encodeProjectDir(cwd), ".claudius.db");
}

const MIGRATIONS_DIR = join(process.cwd(), "lib", "server", "db-migrations");

function listMigrations(): { id: number; sql: string }[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(MIGRATIONS_DIR);
  } catch {
    return [];
  }
  const out: { id: number; sql: string }[] = [];
  for (const name of entries) {
    const m = /^(\d+)_/.exec(name);
    if (!m || !name.endsWith(".sql")) continue;
    const id = Number(m[1]);
    const sql = readFileSync(join(MIGRATIONS_DIR, name), "utf8");
    out.push({ id, sql });
  }
  out.sort((a, b) => a.id - b.id);
  return out;
}

function applyMigrations(db: DB): void {
  // schema_meta may not exist on first open — create it minimally first.
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
  );
  const stmt = db.prepare<[string], { value: string } | undefined>(
    "SELECT value FROM schema_meta WHERE key = ?",
  );
  const row = stmt.get("version");
  const current = row ? Number(row.value) : 0;
  const migrations = listMigrations();
  const last = migrations.length > 0 ? migrations[migrations.length - 1].id : 0;
  if (current >= last) {
    applyPostMigrationCleanups(db);
    return;
  }
  const trx = db.transaction(() => {
    for (const m of migrations) {
      if (m.id <= current) continue;
      db.exec(m.sql);
    }
    db.prepare(
      "INSERT INTO schema_meta(key, value) VALUES('version', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).run(String(last));
  });
  trx();
  applyPostMigrationCleanups(db);
}

/**
 * One-shot data fixups that don't belong in a numbered migration because
 * they target rows the app produced under buggy logic, not a schema change.
 * Each cleanup is guarded by a `schema_meta` flag so it runs exactly once
 * per workspace DB across the lifetime of the project.
 *
 * Keep this list small and append-only — every entry pays the cost of a
 * SELECT on every `openDb` call. If a fixup grows complex, promote it to
 * a real numbered migration instead.
 */
function applyPostMigrationCleanups(db: DB): void {
  // Cleanup v1: clear the phantom "Claude Code process aborted by user" rows
  // that piled up before the bus learned to suppress them. Both the reaper
  // (`SessionManager.end()` → `abortController.abort()`) and the user-stop
  // path (`Session.interrupt()`) make the SDK throw with that exact string;
  // neither is a real error worth surfacing. New rows are filtered at the
  // bus (`isAbortSentinel` in notification-bus.ts) so this targets only the
  // backlog. Idempotent via the flag below.
  const flagged = db
    .prepare<[string], { value: string } | undefined>(
      "SELECT value FROM schema_meta WHERE key = ?",
    )
    .get("notifications_abort_cleanup_v1");
  if (flagged?.value === "1") return;
  // The `notifications` table only exists once migration 005 has run. Skip
  // gracefully if the table is missing — a fresh DB hits the cleanup before
  // any rows could exist anyway.
  const hasTable = db
    .prepare<[], { name: string } | undefined>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='notifications'",
    )
    .get();
  if (hasTable) {
    db.prepare(
      `UPDATE notifications SET read_at = ?
         WHERE read_at IS NULL
           AND kind = 'session_error'
           AND body = 'Claude Code process aborted by user'`,
    ).run(Date.now());
  }
  db.prepare(
    "INSERT INTO schema_meta(key, value) VALUES('notifications_abort_cleanup_v1', '1') ON CONFLICT(key) DO UPDATE SET value='1'",
  ).run();
}

/**
 * Synchronous lookup against the handle cache. Returns null when no handle
 * is open for the (cwd, mode) pair — caller must fall back to `openDb` (or
 * accept the null and skip the operation).
 *
 * The bus uses this on its hot emit path so it can read counts without a
 * microtask-yielding `await openDb(...)`. Safe because the insert path
 * always opens the DB with `readwrite` first, which populates the cache.
 */
export function getCachedDb(
  cwd: string,
  mode: "readwrite" | "readonly" = "readwrite",
): DB | null {
  return handles.get(`${mode}:${cwd}`) ?? null;
}

export async function openDb(cwd: string, mode: "readwrite" | "readonly" = "readwrite"): Promise<DB> {
  const key = `${mode}:${cwd}`;
  const cached = handles.get(key);
  if (cached) return cached;
  const path = dbPath(cwd);
  await fs.mkdir(dirname(path), { recursive: true });
  const opts = mode === "readonly" ? { readonly: true, fileMustExist: true } : {};
  let db: DB;
  try {
    db = new Database(path, opts);
  } catch (err) {
    if (mode === "readonly") throw err;
    throw err;
  }
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  if (mode === "readwrite") applyMigrations(db);
  handles.set(key, db);
  return db;
}

export function closeAll(): void {
  for (const db of handles.values()) {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
  handles.clear();
}

/** Project root for `~/.claude/projects/<encoded-cwd>/` (used by callers needing the same dir for sibling files). */
export function projectRoot(cwd: string): string {
  return join(homedir(), ".claude", "projects", encodeProjectDir(cwd));
}
