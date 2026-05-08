import { openDb } from "./db";

/**
 * Per-cwd open-tab strip.
 *
 * The user's tab bar (session ids in their visible order) used to live only
 * in `sessionStorage`, so closing the browser dropped it. We now persist the
 * list as JSON in the per-project SQLite store so "leave and come back" finds
 * the same tabs — labels resolve through the existing `sessions` table, which
 * already holds custom titles.
 *
 * The DB file is itself keyed by cwd (see `lib/server/db.ts`), so a single
 * `ui_state` key (`open_tabs`) is enough — no extra cwd column needed.
 */

const KEY = "open_tabs";

export async function getOpenTabs(cwd: string): Promise<string[]> {
  const db = await openDb(cwd, "readonly").catch(() => null);
  if (!db) return [];
  // The migration that creates `ui_state` is v3; opening readonly skips
  // applyMigrations(), so an older DB file won't have the table yet. Treat
  // a missing table as "no saved tabs".
  let row: { value: string } | undefined;
  try {
    row = db
      .prepare<[string], { value: string } | undefined>(
        "SELECT value FROM ui_state WHERE key = ?",
      )
      .get(KEY);
  } catch {
    return [];
  }
  if (!row?.value) return [];
  try {
    const parsed = JSON.parse(row.value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

export async function setOpenTabs(cwd: string, ids: string[]): Promise<void> {
  // Sanitize: drop non-strings, dedupe in-order, cap length so a runaway
  // client can't bloat the row.
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const v of ids) {
    if (typeof v !== "string") continue;
    if (seen.has(v)) continue;
    seen.add(v);
    cleaned.push(v);
    if (cleaned.length >= 200) break;
  }
  const db = await openDb(cwd);
  db.prepare(
    `INSERT INTO ui_state(key, value) VALUES(?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(KEY, JSON.stringify(cleaned));
}
