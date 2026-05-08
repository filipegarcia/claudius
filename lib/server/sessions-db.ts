import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db";

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
