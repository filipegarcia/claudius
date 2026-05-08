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
  if (current >= last) return;
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
