import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db";
import { listWorkspaces } from "./workspaces-store";

/**
 * Per-project sessions index. The SDK owns the message JSONLs on disk; we
 * own this metadata layer for fast listing, persistent titles, and a place
 * to attach future session-level data (tags, archive flag, etc.) without
 * touching the JSONL format.
 *
 * Session ids match the SDK's ids on disk — `lib/server/session.ts` passes
 * `sessionId: this.id` to `query()` for new sessions, so the JSONL file in
 * `~/.claude/projects/<encoded-cwd>/<id>.jsonl` uses the same id we surface
 * on the URL. That means the TUI's `claude --resume <id>` resolves the same
 * conversation a Claudius web tab is bound to.
 */

type SessionRow = {
  id: string;
  cwd: string;
  title: string | null;
  model: string | null;
  created_at: number;
  updated_at: number;
  last_seen_at: number;
};

/**
 * Resolved per-session goal state. `goal === null` means no goal is set;
 * `achieved` is only meaningful when a goal exists and is sticky until the
 * goal is cleared or replaced.
 */
export type SessionGoal = {
  goal: string | null;
  achieved: boolean;
  summary: string | null;
  setAt: number | null;
  achievedAt: number | null;
};

const EMPTY_GOAL: SessionGoal = {
  goal: null,
  achieved: false,
  summary: null,
  setAt: null,
  achievedAt: null,
};

/** Write-or-update — call from Session.start() so every active session is indexed. */
export async function upsertSession(opts: {
  id: string;
  cwd: string;
  model?: string;
  title?: string;
}): Promise<void> {
  const db = await openDb(opts.cwd);
  const now = Date.now();
  db.prepare(
    `INSERT INTO sessions(id, cwd, title, model, created_at, updated_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       cwd          = excluded.cwd,
       model        = COALESCE(excluded.model, sessions.model),
       last_seen_at = excluded.last_seen_at`,
  ).run(
    opts.id,
    opts.cwd,
    opts.title ?? null,
    opts.model ?? null,
    now,
    now,
    now,
  );
}

export async function touchSession(cwd: string, id: string): Promise<void> {
  const db = await openDb(cwd);
  const now = Date.now();
  db.prepare("UPDATE sessions SET updated_at = ?, last_seen_at = ? WHERE id = ?").run(
    now,
    now,
    id,
  );
}

export async function getSessionTitle(cwd: string, id: string): Promise<string | null> {
  const db = await openDb(cwd, "readwrite");
  const row = db
    .prepare<[string], { title: string | null } | undefined>(
      "SELECT title FROM sessions WHERE id = ?",
    )
    .get(id);
  if (row?.title) return row.title;
  // Fallback: read from the legacy JSON store and migrate on the fly so
  // existing renames aren't lost across the cut-over.
  const legacy = await readLegacyTitle(id);
  if (legacy) {
    try {
      db.prepare(
        `INSERT INTO sessions(id, cwd, title, created_at, updated_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title`,
      ).run(id, cwd, legacy, Date.now(), Date.now(), Date.now());
    } catch {
      // not fatal — if the row insert fails, we just won't auto-migrate
    }
    return legacy;
  }
  return null;
}

export async function setSessionTitle(cwd: string, id: string, title: string): Promise<void> {
  const trimmed = title.trim();
  const db = await openDb(cwd);
  const now = Date.now();
  if (!trimmed) {
    db.prepare("UPDATE sessions SET title = NULL, updated_at = ? WHERE id = ?").run(now, id);
    return;
  }
  db.prepare(
    `INSERT INTO sessions(id, cwd, title, created_at, updated_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title      = excluded.title,
       updated_at = excluded.updated_at`,
  ).run(id, cwd, trimmed, now, now, now);
}

// ── Session goal ─────────────────────────────────────────────────────────
// A goal is a single user-stated objective, persisted so it survives reloads
// and session resume. Writes use the same INSERT … ON CONFLICT idiom as
// `setSessionTitle` so a goal set before the session's first turn (no JSONL
// yet) still lands a row.

type GoalRow = {
  goal: string | null;
  goal_achieved: number | null;
  goal_summary: string | null;
  goal_set_at: number | null;
  goal_achieved_at: number | null;
};

function rowToGoal(row: GoalRow | undefined): SessionGoal {
  if (!row || !row.goal) return { ...EMPTY_GOAL };
  return {
    goal: row.goal,
    achieved: row.goal_achieved === 1,
    summary: row.goal_summary ?? null,
    setAt: row.goal_set_at ?? null,
    achievedAt: row.goal_achieved_at ?? null,
  };
}

/** Read the current goal state for a session. Returns the empty goal when unset. */
export async function getSessionGoal(cwd: string, id: string): Promise<SessionGoal> {
  const db = await openDb(cwd, "readonly").catch(() => null);
  if (!db) return { ...EMPTY_GOAL };
  const row = db
    .prepare<[string], GoalRow | undefined>(
      `SELECT goal, goal_achieved, goal_summary, goal_set_at, goal_achieved_at
         FROM sessions WHERE id = ?`,
    )
    .get(id);
  return rowToGoal(row);
}

/**
 * Set (or replace) the session goal. Replacing a goal resets achievement —
 * the new objective hasn't been met yet — so `goal_achieved`, `goal_summary`,
 * and `goal_achieved_at` are cleared. Returns the resolved goal state.
 */
export async function setSessionGoal(
  cwd: string,
  id: string,
  goal: string,
): Promise<SessionGoal> {
  const trimmed = goal.trim();
  if (!trimmed) return clearSessionGoal(cwd, id);
  const db = await openDb(cwd);
  const now = Date.now();
  db.prepare(
    `INSERT INTO sessions(id, cwd, goal, goal_achieved, goal_summary, goal_set_at, goal_achieved_at, created_at, updated_at, last_seen_at)
     VALUES (?, ?, ?, 0, NULL, ?, NULL, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       goal             = excluded.goal,
       goal_achieved    = 0,
       goal_summary     = NULL,
       goal_set_at      = excluded.goal_set_at,
       goal_achieved_at = NULL,
       updated_at       = excluded.updated_at`,
  ).run(id, cwd, trimmed, now, now, now, now);
  return { goal: trimmed, achieved: false, summary: null, setAt: now, achievedAt: null };
}

/** Clear the session goal entirely (also clears any achievement). */
export async function clearSessionGoal(cwd: string, id: string): Promise<SessionGoal> {
  const db = await openDb(cwd);
  db.prepare(
    `UPDATE sessions
        SET goal = NULL, goal_achieved = 0, goal_summary = NULL,
            goal_set_at = NULL, goal_achieved_at = NULL, updated_at = ?
      WHERE id = ?`,
  ).run(Date.now(), id);
  return { ...EMPTY_GOAL };
}

/**
 * Mark the current goal achieved with a short summary. No-op (returns the
 * current state) when there's no goal to achieve. Returns the resolved state.
 */
export async function setGoalAchieved(
  cwd: string,
  id: string,
  summary: string,
): Promise<SessionGoal> {
  const db = await openDb(cwd);
  const now = Date.now();
  const cleanSummary = summary.trim() || null;
  db.prepare(
    `UPDATE sessions
        SET goal_achieved = 1, goal_summary = ?, goal_achieved_at = ?, updated_at = ?
      WHERE id = ? AND goal IS NOT NULL`,
  ).run(cleanSummary, now, now, id);
  // Read back through the same (write) connection so the returned state
  // reflects the row we just touched — including the no-op case where the
  // goal was cleared concurrently and the UPDATE matched nothing.
  const row = db
    .prepare<[string], GoalRow | undefined>(
      `SELECT goal, goal_achieved, goal_summary, goal_set_at, goal_achieved_at
         FROM sessions WHERE id = ?`,
    )
    .get(id);
  return rowToGoal(row);
}

/** List every indexed session for this cwd, newest activity first. */
export async function listIndexedSessions(cwd: string): Promise<SessionRow[]> {
  const db = await openDb(cwd, "readonly").catch(() => null);
  if (!db) return [];
  const rows = db
    .prepare(
      `SELECT id, cwd, title, model, created_at, updated_at, last_seen_at
       FROM sessions WHERE cwd = ? ORDER BY updated_at DESC`,
    )
    .all(cwd) as SessionRow[];
  return rows;
}

/**
 * Cross-workspace fan-out: list every indexed session row from every
 * known workspace's `.claudius.db`. Pass a `dir` to scope to a single
 * workspace; omit it for "everywhere" (used by `/api/sessions/all`).
 *
 * Why this exists: the SDK's `listSessions` only returns sessions that
 * have an on-disk JSONL. A freshly-created session that the user renamed
 * before its first turn flushed has a DB row (from `setSessionTitle`)
 * but no JSONL, so the SDK call leaves it invisible. The reaper then
 * evicts the in-memory copy and the user is left with a tab whose label
 * has fallen back to the id prefix. Surfacing DB-only rows here lets
 * `/api/sessions/all` synthesize entries for those sessions so the
 * client's tab strip can still find them.
 *
 * Workspaces with no `.claudius.db` yet (the `openDb` inside
 * `listIndexedSessions` returns empty) are silently skipped.
 */
export async function listAllIndexedSessions(dir?: string): Promise<SessionRow[]> {
  if (dir) return listIndexedSessions(dir);
  const workspaces = await listWorkspaces().catch(() => []);
  const all: SessionRow[] = [];
  for (const ws of workspaces) {
    if (!ws.rootPath) continue;
    const rows = await listIndexedSessions(ws.rootPath).catch(() => [] as SessionRow[]);
    all.push(...rows);
  }
  return all;
}

/**
 * Batch lookup: for every (cwd, sessionId) pair, return whatever title we
 * have persisted for that session. Used by `/api/sessions/all` to enrich
 * the SDK's cross-workspace listing with the names we've persisted
 * ourselves.
 *
 * Why we need this: `setSessionTitle` writes to our DB unconditionally,
 * but `renameSession` (SDK) only succeeds once the JSONL exists on disk
 * — which can be never for a session that was renamed before its first
 * turn landed. The SDK's `customTitle` field is therefore empty for a
 * lot of legitimately-renamed sessions; without this enrichment the
 * session list / tab strip would lose those names.
 *
 * Sources, in precedence:
 *   1. The cwd's `.claudius.db` `sessions.title` column (where every new
 *      rename writes).
 *   2. The legacy cross-cwd JSON store at
 *      `~/.claude/.claudius/session-titles.json` (where older renames
 *      live before the per-project DB migration sees them). Read once
 *      per call; cheap because it's a tiny JSON file.
 *
 * Returns a `cwd:id → title` map. Misses (cwd not indexed, no DB row,
 * legacy file missing) just don't appear in the map; callers treat
 * "not in map" as "no Claudius title."
 *
 * Groups by cwd so we open each `.claudius.db` exactly once. DB opens
 * that fail are skipped silently — better to surface partial titles
 * than to 500 the whole listing.
 */
export async function getSessionTitlesByCwd(
  pairs: ReadonlyArray<{ cwd: string | undefined; id: string }>,
): Promise<Map<string, string>> {
  // Group only the pairs we have a cwd for — these get the direct DB
  // probe at that cwd's `.claudius.db`. Pairs WITHOUT a cwd (the SDK
  // didn't write one into the JSONL header) get the fan-out path below.
  const byCwd = new Map<string, string[]>();
  const noCwdIds: string[] = [];
  for (const { cwd, id } of pairs) {
    if (!id) continue;
    if (!cwd) {
      noCwdIds.push(id);
      continue;
    }
    const list = byCwd.get(cwd) ?? [];
    list.push(id);
    byCwd.set(cwd, list);
  }
  // `out` is keyed `${cwd}:${id}` when we know the cwd, otherwise
  // `*:${id}` so the caller's "any title for this id?" probe still
  // finds it. The route handler tries both keys per session.
  const out = new Map<string, string>();
  for (const [cwd, ids] of byCwd) {
    await probeCwd(cwd, ids, out);
  }
  // Cwd-less sessions: fan out across every known workspace's DB.
  // Cheap because openDb keeps handles cached, and most users have a
  // handful of workspaces at most. If a session id appears in multiple
  // DBs (shouldn't happen — ids are UUIDs — but defensive), the first
  // hit wins.
  if (noCwdIds.length > 0) {
    const workspaces = await listWorkspaces().catch(() => []);
    for (const ws of workspaces) {
      if (!ws.rootPath) continue;
      const stillMissing = noCwdIds.filter((id) => !out.has(`*:${id}`));
      if (stillMissing.length === 0) break;
      await probeCwd(ws.rootPath, stillMissing, out, { unkeyed: true });
    }
  }
  // Legacy JSON fallback — older renames (pre per-project DB) live in
  // a single cross-cwd file keyed by session id. Patch any pairs we
  // still don't have a title for. `getSessionTitle` migrates these on
  // its first DB read; here we just shadow-read so the listing surface
  // sees them without forcing a write.
  const legacy = await readLegacyTitlesMap();
  if (legacy && Object.keys(legacy).length > 0) {
    for (const { cwd, id } of pairs) {
      if (!id) continue;
      const key = cwd ? `${cwd}:${id}` : `*:${id}`;
      if (out.has(key)) continue;
      const t = legacy[id];
      if (t && t.trim()) out.set(key, t);
    }
  }
  return out;
}

/**
 * Open the cwd's `.claudius.db` (readonly) and look up titles for the
 * given session ids. Writes into `out` keyed `${cwd}:${id}` by default,
 * or `*:${id}` when `unkeyed: true` (the fan-out path for sessions
 * whose JSONL doesn't carry a cwd — we just need ANY title for that id).
 */
async function probeCwd(
  cwd: string,
  ids: string[],
  out: Map<string, string>,
  opts: { unkeyed?: boolean } = {},
): Promise<void> {
  const db = await openDb(cwd, "readonly").catch(() => null);
  if (!db) return;
  // SQLite caps the IN clause at 999 by default; chunk just in case.
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT id, title FROM sessions WHERE title IS NOT NULL AND id IN (${placeholders})`,
      )
      .all(...chunk) as Array<{ id: string; title: string }>;
    for (const r of rows) {
      if (!r.title || !r.title.trim()) continue;
      const key = opts.unkeyed ? `*:${r.id}` : `${cwd}:${r.id}`;
      if (!out.has(key)) out.set(key, r.title);
    }
  }
}

async function readLegacyTitlesMap(): Promise<Record<string, string> | null> {
  const path = join(homedir(), ".claude", ".claudius", "session-titles.json");
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as { titles?: Record<string, string> };
    return parsed?.titles && typeof parsed.titles === "object" ? parsed.titles : null;
  } catch {
    return null;
  }
}

// ── Legacy migration helpers ────────────────────────────────────────────
// The session-titles.json file was the previous (cross-cwd) home for
// custom titles. We migrate entries on first read; nothing writes to it
// any more. Once the migration has been seen for a given id, the DB row
// supersedes it.

async function readLegacyTitle(id: string): Promise<string | null> {
  const path = join(homedir(), ".claude", ".claudius", "session-titles.json");
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as { titles?: Record<string, string> };
    const t = parsed?.titles?.[id];
    return typeof t === "string" && t.trim() ? t : null;
  } catch {
    return null;
  }
}
