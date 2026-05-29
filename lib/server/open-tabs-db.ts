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
 *
 * `active_tab` records the id of the last-active tab so a fresh page load
 * can resume that conversation instead of spawning a brand-new session on
 * top of the persisted strip.
 */

const KEY = "open_tabs";
const ACTIVE_KEY = "active_tab";
const TAB_LABEL_MAX_WIDTH_KEY = "tab_label_max_width";

/** Bounds for the tab-label max width (px). Mirror these in the UI. */
export const TAB_LABEL_MIN = 60;
export const TAB_LABEL_MAX = 600;
export const TAB_LABEL_DEFAULT = 180;

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

export async function getActiveTab(cwd: string): Promise<string | null> {
  const db = await openDb(cwd, "readonly").catch(() => null);
  if (!db) return null;
  let row: { value: string } | undefined;
  try {
    row = db
      .prepare<[string], { value: string } | undefined>(
        "SELECT value FROM ui_state WHERE key = ?",
      )
      .get(ACTIVE_KEY);
  } catch {
    return null;
  }
  if (!row?.value) return null;
  try {
    const parsed = JSON.parse(row.value) as unknown;
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return null;
  }
}

export async function setActiveTab(cwd: string, id: string | null): Promise<void> {
  const db = await openDb(cwd);
  if (id === null) {
    db.prepare("DELETE FROM ui_state WHERE key = ?").run(ACTIVE_KEY);
    return;
  }
  db.prepare(
    `INSERT INTO ui_state(key, value) VALUES(?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(ACTIVE_KEY, JSON.stringify(id));
}

/**
 * Per-cwd max width applied to every session-tab label. Lives in the same
 * `ui_state` table so closing the browser doesn't drop the user's preferred
 * tab size. Returns null when nothing has been saved yet (caller picks a
 * sensible default).
 */
export async function getTabLabelMaxWidth(cwd: string): Promise<number | null> {
  const db = await openDb(cwd, "readonly").catch(() => null);
  if (!db) return null;
  let row: { value: string } | undefined;
  try {
    row = db
      .prepare<[string], { value: string } | undefined>(
        "SELECT value FROM ui_state WHERE key = ?",
      )
      .get(TAB_LABEL_MAX_WIDTH_KEY);
  } catch {
    return null;
  }
  if (!row?.value) return null;
  try {
    const parsed = JSON.parse(row.value) as unknown;
    if (typeof parsed !== "number" || !Number.isFinite(parsed)) return null;
    return clampLabelWidth(parsed);
  } catch {
    return null;
  }
}

export async function setTabLabelMaxWidth(cwd: string, width: number): Promise<void> {
  const db = await openDb(cwd);
  const v = clampLabelWidth(width);
  db.prepare(
    `INSERT INTO ui_state(key, value) VALUES(?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(TAB_LABEL_MAX_WIDTH_KEY, JSON.stringify(v));
}

function clampLabelWidth(n: number): number {
  if (!Number.isFinite(n)) return TAB_LABEL_DEFAULT;
  return Math.min(TAB_LABEL_MAX, Math.max(TAB_LABEL_MIN, Math.round(n)));
}
