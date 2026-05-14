// bun:sqlite wrapper for the chat server.
//
// Uses Bun's built-in SQLite binding (no native compile step required).
// API mirrors better-sqlite3 closely but with `.query()` for cached
// prepared statements and `.run()/.get()/.all()` for execution.
//
// Mirrors the (much larger) Claudius pattern: one process-wide
// singleton Database, prepared-statement queries, raw SQL migrations
// run on boot. Schema lives in ../migrations/NNN_*.sql — bump the
// number rather than editing an existing file.
//
// Storage:
//   - CHAT_DB_PATH env var, default "./data/chat.db". Fly volumes
//     mount at /data so the default works there too.
//   - WAL mode for concurrent reads while we write.

import { Database, type SQLQueryBindings, type Statement } from "bun:sqlite";
import { readFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Ban, BanKind, Message, Room } from "./types.ts";

const DB_PATH = process.env.CHAT_DB_PATH ?? "./data/chat.db";
const HERE = dirname(fileURLToPath(import.meta.url));

function openDb(): Database {
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const db = new Database(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

function runMigrations(db: Database): void {
  // Track applied migrations in a tiny meta table; this lets us add
  // 002_*.sql etc. later without re-running 001.
  db.exec(
    `CREATE TABLE IF NOT EXISTS _migrations (
       id TEXT PRIMARY KEY,
       applied_at INTEGER NOT NULL
     )`,
  );
  const appliedRows = db
    .query("SELECT id FROM _migrations")
    .all() as Array<{ id: string }>;
  const applied = new Set(appliedRows.map((r) => r.id));
  const dir = join(HERE, "..", "migrations");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const insert = db.prepare(
    "INSERT INTO _migrations(id, applied_at) VALUES (?, ?)",
  );
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = readFileSync(join(dir, f), "utf8");
    db.transaction(() => {
      db.exec(sql);
      insert.run(f, Date.now());
    })();
    console.log(`[chat-server] applied migration ${f}`);
  }
}

const db = openDb();
runMigrations(db);

// ── Mappers (DB row → wire shape) ──────────────────────────────────
//
// SQLite has no boolean; `is_admin` is stored 0/1. The wire shape uses
// booleans. We also drop `ip` here — it's needed server-side for ban
// enforcement but never leaves the process.

type RoomRow = {
  slug: string;
  name: string;
  description: string | null;
  pinned_message_id: string | null;
};
type MessageRow = {
  id: string;
  room_slug: string;
  nick: string;
  body: string;
  is_admin: number;
  created_at: number;
  deleted_at: number | null;
};
type BanRow = {
  id: number;
  kind: BanKind;
  value: string;
  reason: string | null;
  created_at: number;
};

const toRoom = (r: RoomRow): Room => ({
  slug: r.slug,
  name: r.name,
  description: r.description,
  pinnedMessageId: r.pinned_message_id,
});

const toMessage = (m: MessageRow): Message => ({
  id: m.id,
  roomSlug: m.room_slug,
  nick: m.nick,
  // Blank the body for deleted rows so the original content doesn't
  // leak to subscribers. The client renders a placeholder when
  // deletedAt is set; the body field is ignored in that branch.
  body: m.deleted_at === null ? m.body : "",
  isAdmin: m.is_admin === 1,
  createdAt: m.created_at,
  deletedAt: m.deleted_at,
});

const toBan = (b: BanRow): Ban => ({
  id: b.id,
  kind: b.kind,
  value: b.value,
  reason: b.reason,
  createdAt: b.created_at,
});

// Cast helper — bun:sqlite typed Statement<X, P> resolves with `unknown`
// on .get/.all unless we narrow. Centralised to keep call sites tidy.
function rows<R>(s: Statement<unknown, SQLQueryBindings[]>, params: SQLQueryBindings[] = []): R[] {
  return s.all(...params) as R[];
}
function row<R>(s: Statement<unknown, SQLQueryBindings[]>, params: SQLQueryBindings[] = []): R | undefined {
  return s.get(...params) as R | undefined;
}

// ── Rooms ──────────────────────────────────────────────────────────

const stmtListRooms = db.prepare(
  "SELECT slug, name, description, pinned_message_id FROM rooms ORDER BY slug",
);
export function listRooms(): Room[] {
  return rows<RoomRow>(stmtListRooms).map(toRoom);
}

const stmtGetRoom = db.prepare(
  "SELECT slug, name, description, pinned_message_id FROM rooms WHERE slug = ?",
);
export function getRoom(slug: string): Room | null {
  const r = row<RoomRow>(stmtGetRoom, [slug]);
  return r ? toRoom(r) : null;
}

// ── Messages ───────────────────────────────────────────────────────

const stmtInsertMessage = db.prepare(
  `INSERT INTO messages (id, room_slug, nick, ip, body, is_admin, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?)`,
);
export function insertMessage(input: {
  id: string;
  roomSlug: string;
  nick: string;
  ip: string;
  body: string;
  isAdmin: boolean;
}): Message {
  const createdAt = Date.now();
  stmtInsertMessage.run(
    input.id,
    input.roomSlug,
    input.nick,
    input.ip,
    input.body,
    input.isAdmin ? 1 : 0,
    createdAt,
  );
  return {
    id: input.id,
    roomSlug: input.roomSlug,
    nick: input.nick,
    body: input.body,
    isAdmin: input.isAdmin,
    createdAt,
    deletedAt: null,
  };
}

const stmtRecentMessages = db.prepare(
  `SELECT id, room_slug, nick, body, is_admin, created_at, deleted_at
     FROM messages
    WHERE room_slug = ?
    ORDER BY created_at DESC
    LIMIT ?`,
);
/**
 * Returns the most recent N messages for a room, oldest-first. Deleted
 * rows are included so the client can render a placeholder in their
 * spot — `toMessage` blanks the body for those, so the wire surface
 * never carries the original content.
 */
export function recentMessages(roomSlug: string, limit = 100): Message[] {
  return rows<MessageRow>(stmtRecentMessages, [roomSlug, limit])
    .reverse()
    .map(toMessage);
}

const stmtMessagesBefore = db.prepare(
  `SELECT id, room_slug, nick, body, is_admin, created_at, deleted_at
     FROM messages
    WHERE room_slug = ? AND created_at < ?
    ORDER BY created_at DESC
    LIMIT ?`,
);
/** Backfill: messages older than `before`, oldest-first. Includes deleted. */
export function messagesBefore(
  roomSlug: string,
  before: number,
  limit = 100,
): Message[] {
  return rows<MessageRow>(stmtMessagesBefore, [roomSlug, before, limit])
    .reverse()
    .map(toMessage);
}

const stmtGetMessage = db.prepare(
  `SELECT id, room_slug, nick, body, is_admin, created_at, deleted_at
     FROM messages WHERE id = ?`,
);
export function getMessage(id: string): (Message & { deleted: boolean }) | null {
  const r = row<MessageRow>(stmtGetMessage, [id]);
  if (!r) return null;
  return { ...toMessage(r), deleted: r.deleted_at !== null };
}

const stmtSoftDelete = db.prepare(
  "UPDATE messages SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL",
);
/** Returns true if a row was actually deleted (i.e. existed and wasn't already deleted). */
export function softDeleteMessage(id: string): boolean {
  return stmtSoftDelete.run(Date.now(), id).changes > 0;
}

// ── Pins ───────────────────────────────────────────────────────────

const stmtSetPin = db.prepare(
  "UPDATE rooms SET pinned_message_id = ? WHERE slug = ?",
);
export function setRoomPin(slug: string, messageId: string | null): void {
  stmtSetPin.run(messageId, slug);
}

// ── Bans ───────────────────────────────────────────────────────────

const stmtIsBanned = db.prepare(
  "SELECT COUNT(*) AS c FROM bans WHERE kind = ? AND value = ?",
);
export function isBanned(kind: BanKind, value: string): boolean {
  const r = row<{ c: number }>(stmtIsBanned, [kind, value]);
  return (r?.c ?? 0) > 0;
}

const stmtInsertBan = db.prepare(
  `INSERT OR IGNORE INTO bans (kind, value, reason, created_at)
   VALUES (?, ?, ?, ?)`,
);
export function insertBan(
  kind: BanKind,
  value: string,
  reason: string | null,
): Ban | null {
  const createdAt = Date.now();
  const res = stmtInsertBan.run(kind, value, reason, createdAt);
  if (res.changes === 0) return null;
  return {
    id: Number(res.lastInsertRowid),
    kind,
    value,
    reason,
    createdAt,
  };
}

const stmtListBans = db.prepare(
  "SELECT id, kind, value, reason, created_at FROM bans ORDER BY created_at DESC",
);
export function listBans(): Ban[] {
  return rows<BanRow>(stmtListBans).map(toBan);
}

const stmtDeleteBan = db.prepare("DELETE FROM bans WHERE id = ?");
export function deleteBan(id: number): boolean {
  return stmtDeleteBan.run(id).changes > 0;
}

/**
 * Look up the most recent IP a given nick posted from. Used by the
 * "ban by nick" admin path to opportunistically ban the IP as well —
 * imperfect (CGNAT, VPN) but the standard lowest-bar moderation lever.
 */
const stmtIpForNick = db.prepare(
  `SELECT ip FROM messages
    WHERE LOWER(nick) = LOWER(?)
    ORDER BY created_at DESC
    LIMIT 1`,
);
export function lastIpForNick(nick: string): string | null {
  return row<{ ip: string }>(stmtIpForNick, [nick])?.ip ?? null;
}

// ── Room management ───────────────────────────────────────────────
//
// Three admin-only operations on the rooms table itself: create a new
// channel, hard-delete every message in a channel, and trim a channel
// down to the most recent N messages. All three are SQL one-liners
// with a tiny bit of validation; broadcast side-effects live in
// `server.ts` so this module stays storage-only.

const stmtInsertRoom = db.prepare(
  `INSERT INTO rooms (slug, name, description, created_at)
   VALUES (?, ?, ?, ?)`,
);
/**
 * Create a new room. Returns the inserted Room, or `null` if a room
 * with that slug already exists (uniqueness is enforced by the PK,
 * but we check up-front so the caller gets a clean error code rather
 * than catching a SQLITE_CONSTRAINT).
 */
export function createRoom(input: {
  slug: string;
  name: string;
  description: string | null;
}): Room | null {
  if (getRoom(input.slug)) return null;
  stmtInsertRoom.run(input.slug, input.name, input.description, Date.now());
  return getRoom(input.slug);
}

const stmtClearRoom = db.prepare("DELETE FROM messages WHERE room_slug = ?");
const stmtUnpinRoomSilently = db.prepare(
  "UPDATE rooms SET pinned_message_id = NULL WHERE slug = ?",
);
/**
 * Wipe every message in a room (hard delete, not soft). The pin is
 * cleared as a side effect since it'd otherwise dangle. Returns the
 * number of messages removed.
 */
export function clearRoomMessages(roomSlug: string): number {
  const res = stmtClearRoom.run(roomSlug);
  stmtUnpinRoomSilently.run(roomSlug);
  return Number(res.changes);
}

const stmtCompactRoom = db.prepare(
  `DELETE FROM messages
    WHERE room_slug = ?
      AND id NOT IN (
        SELECT id FROM messages
         WHERE room_slug = ?
         ORDER BY created_at DESC
         LIMIT ?
      )`,
);
/**
 * Trim a room down to the most recent `keep` messages (counts both
 * live and soft-deleted rows). Returns how many rows were deleted.
 * Pin handling: if the pinned message was among the trimmed rows,
 * `setRoomPin(slug, null)` should be called by the caller — kept out
 * of this function so the storage layer stays free of broadcast
 * side-effect coupling.
 */
export function compactRoomMessages(roomSlug: string, keep: number): number {
  const n = Math.max(0, Math.floor(keep));
  const res = stmtCompactRoom.run(roomSlug, roomSlug, n);
  return Number(res.changes);
}

// ── Bulk soft-delete (ban + purge) ─────────────────────────────────
//
// Returns the (id, room_slug) of every row actually toggled from live
// to deleted, so the caller can broadcast a `message_deleted` event for
// each. Already-deleted rows are skipped — we never re-emit the event
// twice for the same id, and the per-message guard `deleted_at IS NULL`
// keeps the operation idempotent across re-runs of the same ban.

const stmtFindMessagesByNick = db.prepare(
  `SELECT id, room_slug FROM messages
    WHERE LOWER(nick) = LOWER(?) AND deleted_at IS NULL`,
);
const stmtFindMessagesByIp = db.prepare(
  `SELECT id, room_slug FROM messages
    WHERE ip = ? AND deleted_at IS NULL`,
);

type PurgedRow = { id: string; roomSlug: string };

function purgeRows(rows: Array<{ id: string; room_slug: string }>): PurgedRow[] {
  const now = Date.now();
  const out: PurgedRow[] = [];
  for (const r of rows) {
    if (stmtSoftDelete.run(now, r.id).changes > 0) {
      out.push({ id: r.id, roomSlug: r.room_slug });
    }
  }
  return out;
}

/** Soft-delete every live message posted under `nick` (case-insensitive). */
export function softDeleteMessagesByNick(nick: string): PurgedRow[] {
  return purgeRows(
    rows<{ id: string; room_slug: string }>(stmtFindMessagesByNick, [nick]),
  );
}

/** Soft-delete every live message posted from `ip`. */
export function softDeleteMessagesByIp(ip: string): PurgedRow[] {
  return purgeRows(
    rows<{ id: string; room_slug: string }>(stmtFindMessagesByIp, [ip]),
  );
}

// ── Community kill switch ─────────────────────────────────────────
//
// One global flag stored in `system_state` (see migrations/002_*.sql).
// Reads happen on every public POST/stream, so they're cached via a
// prepared statement; writes are admin-only and rare.

const stmtReadSystemState = db.prepare(
  "SELECT disabled_at, disabled_reason FROM system_state WHERE singleton = 1",
);
const stmtSetDisabled = db.prepare(
  `UPDATE system_state
      SET disabled_at = ?, disabled_reason = ?
    WHERE singleton = 1`,
);

export type CommunityState = {
  enabled: boolean;
  reason: string | null;
  disabledAt: number | null;
};

export function getCommunityState(): CommunityState {
  const r = row<{
    disabled_at: number | null;
    disabled_reason: string | null;
  }>(stmtReadSystemState);
  if (!r) return { enabled: true, reason: null, disabledAt: null };
  return {
    enabled: r.disabled_at === null,
    reason: r.disabled_reason,
    disabledAt: r.disabled_at,
  };
}

export function isCommunityDisabled(): boolean {
  return !getCommunityState().enabled;
}

/**
 * Flip the kill switch. Idempotent — calling disable() on an already
 * disabled server just updates the reason. The caller is responsible
 * for broadcasting the resulting `community_state` event over the bus.
 */
export function setCommunityDisabled(reason: string | null): CommunityState {
  stmtSetDisabled.run(Date.now(), reason);
  return getCommunityState();
}

export function setCommunityEnabled(): CommunityState {
  stmtSetDisabled.run(null, null);
  return getCommunityState();
}

export { db };
