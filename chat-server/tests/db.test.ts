// DB-layer tests for the chat-server.
//
// Why focus here:
//   - The DB module is the only piece of the server that's pure-ish:
//     no HTTP, no SSE, no Bun.serve plumbing. Cheap to exercise.
//   - It owns the wire-visibility rules (which deleted rows reach
//     subscribers, which stay buried) that are the trickiest part of
//     the moderation surface to get right by inspection.
//   - The bus + admin handlers are thin wrappers over these helpers,
//     so good coverage here implies the route handlers are correct
//     too (modulo their own JSON parsing, which is trivial).
//
// Isolation strategy: one shared :memory: db (see tests/_setup.ts),
// `beforeEach` truncates the per-table data and resets the kill
// switch. The banned-words clean-up goes through the public API so
// the in-process cache stays in sync with the table.

import { beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  addBannedWord,
  clearRoomMessages,
  compactRoomMessages,
  containsBannedWord,
  conversationBefore,
  createRoom,
  db,
  getCommunityState,
  getRoom,
  insertDm,
  insertMessage,
  isCommunityDisabled,
  listBannedWords,
  listConversationsFor,
  messagesBefore,
  recentLiveMessages,
  recentMessages,
  removeBannedWord,
  setCommunityDisabled,
  setCommunityEnabled,
  softDeleteMessage,
  softDeleteMessagesByIp,
  softDeleteMessagesByNick,
} from "../src/db.ts";

// ── Test helpers ─────────────────────────────────────────────────

const ROOM = "general"; // seeded by migration 001

function insertN(
  count: number,
  opts: { nick?: string; ip?: string; isAdmin?: boolean; roomSlug?: string } = {},
): string[] {
  const nick = opts.nick ?? "alice";
  const ip = opts.ip ?? "10.0.0.1";
  const isAdmin = opts.isAdmin ?? false;
  const roomSlug = opts.roomSlug ?? ROOM;
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = randomUUID();
    insertMessage({ id, roomSlug, nick, ip, body: `msg #${i}`, isAdmin });
    ids.push(id);
  }
  return ids;
}

/**
 * Insert with explicit `created_at`, bypassing insertMessage()'s
 * `Date.now()`. Used by the `before`-boundary tests where multiple
 * inserts within a single millisecond would all tie and the strict
 * `<` cutoff couldn't be observed. Real traffic has natural spacing
 * between messages so this is purely a test-determinism aid.
 */
function insertWithTimestamp(
  roomSlug: string,
  createdAt: number,
  nick = "alice",
): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO messages (id, room_slug, nick, ip, body, is_admin, created_at)
     VALUES (?, ?, ?, '10.0.0.1', 'msg', 0, ?)`,
  ).run(id, roomSlug, nick, createdAt);
  return id;
}

function insertDmWithTimestamp(
  from: string,
  to: string,
  createdAt: number,
): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO dms (id, from_nick, from_ip, to_nick, body, created_at)
     VALUES (?, ?, '1.2.3.4', ?, 'hi', ?)`,
  ).run(id, from, to, createdAt);
  return id;
}

beforeEach(() => {
  db.exec("DELETE FROM messages");
  db.exec("DELETE FROM bans");
  db.exec("DELETE FROM dms");
  db.exec(
    "DELETE FROM rooms WHERE slug NOT IN ('general', 'bugs', 'ideas')",
  );
  // Banned-words: drain through the public API so the in-process
  // cache invalidates with the row deletes.
  for (const w of listBannedWords()) removeBannedWord(w.word);
  setCommunityEnabled();
});

// ── recentMessages / wire visibility ─────────────────────────────

describe("recentMessages — visibility by deletion_reason", () => {
  test("returns live rows in chronological order", () => {
    const ids = insertN(3);
    const out = recentMessages(ROOM, 100);
    expect(out.map((m) => m.id)).toEqual(ids);
    expect(out.every((m) => m.deletedAt === null)).toBe(true);
    expect(out.every((m) => m.body !== "")).toBe(true);
  });

  test("admin-deleted rows reach the wire with body blanked", () => {
    const [a, b, c] = insertN(3);
    softDeleteMessage(b!, "admin");
    const out = recentMessages(ROOM, 100);
    expect(out.map((m) => m.id)).toEqual([a!, b!, c!]);
    const deleted = out.find((m) => m.id === b!)!;
    expect(deleted.deletedAt).not.toBeNull();
    expect(deleted.body).toBe("");
  });

  test("banned-purge rows reach the wire (moderation placeholder)", () => {
    const [a, b] = insertN(2);
    softDeleteMessage(b!, "banned");
    const out = recentMessages(ROOM, 100);
    expect(out).toHaveLength(2);
    expect(out.find((m) => m.id === b!)?.deletedAt).not.toBeNull();
    expect(a).toBeDefined();
  });

  test("bulk-cleared rows are HIDDEN from the wire (audit only)", () => {
    const ids = insertN(3);
    softDeleteMessage(ids[1]!, "cleared");
    const out = recentMessages(ROOM, 100);
    expect(out.map((m) => m.id)).toEqual([ids[0]!, ids[2]!]);
  });

  test("bulk-compacted rows are HIDDEN from the wire (audit only)", () => {
    const ids = insertN(3);
    softDeleteMessage(ids[0]!, "compacted");
    const out = recentMessages(ROOM, 100);
    expect(out.map((m) => m.id)).toEqual([ids[1]!, ids[2]!]);
  });

  test("limit clamps the result set (newest kept, oldest-first within page)", () => {
    const ids = insertN(5);
    const out = recentMessages(ROOM, 2);
    expect(out.map((m) => m.id)).toEqual([ids[3]!, ids[4]!]);
  });
});

describe("recentLiveMessages — excludes ALL deletions", () => {
  test("admin-deleted rows are also excluded (unlike recentMessages)", () => {
    const ids = insertN(3);
    softDeleteMessage(ids[1]!, "admin");
    const out = recentLiveMessages(ROOM, 100);
    expect(out.map((m) => m.id)).toEqual([ids[0]!, ids[2]!]);
  });

  test("post-compact callers see only the kept live rows", () => {
    const ids = insertN(5);
    compactRoomMessages(ROOM, 2); // soft-deletes oldest 3 as 'compacted'
    const live = recentLiveMessages(ROOM, 100);
    expect(live.map((m) => m.id)).toEqual([ids[3]!, ids[4]!]);
  });
});

// ── clearRoomMessages ────────────────────────────────────────────

describe("clearRoomMessages", () => {
  test("soft-deletes every live row with reason 'cleared'", () => {
    const ids = insertN(3);
    const removed = clearRoomMessages(ROOM);
    expect(removed).toBe(3);

    // Wire is empty (cleared rows are hidden):
    expect(recentMessages(ROOM, 100)).toEqual([]);

    // But rows still in the table for admin review:
    const remaining = db
      .query("SELECT id, deletion_reason FROM messages WHERE room_slug = ?")
      .all(ROOM) as Array<{ id: string; deletion_reason: string }>;
    expect(remaining).toHaveLength(3);
    expect(remaining.every((r) => r.deletion_reason === "cleared")).toBe(true);
    expect(new Set(remaining.map((r) => r.id))).toEqual(new Set(ids));
  });

  test("is idempotent — second clear is a no-op", () => {
    insertN(2);
    expect(clearRoomMessages(ROOM)).toBe(2);
    expect(clearRoomMessages(ROOM)).toBe(0);
  });

  test("clears the pinned message reference on the room", () => {
    const [id] = insertN(1);
    db.prepare("UPDATE rooms SET pinned_message_id = ? WHERE slug = ?").run(
      id!,
      ROOM,
    );
    clearRoomMessages(ROOM);
    expect(getRoom(ROOM)?.pinnedMessageId).toBeNull();
  });
});

// ── compactRoomMessages ──────────────────────────────────────────

describe("compactRoomMessages", () => {
  test("trims to the most recent N live rows", () => {
    const ids = insertN(5);
    const removed = compactRoomMessages(ROOM, 2);
    expect(removed).toBe(3);
    expect(recentLiveMessages(ROOM, 100).map((m) => m.id)).toEqual([
      ids[3]!,
      ids[4]!,
    ]);
  });

  test("keeping 0 trims everything (same shape as clear, different reason)", () => {
    insertN(3);
    expect(compactRoomMessages(ROOM, 0)).toBe(3);
    expect(recentLiveMessages(ROOM, 100)).toEqual([]);
    const reasons = db
      .query(
        "SELECT DISTINCT deletion_reason FROM messages WHERE room_slug = ?",
      )
      .all(ROOM) as Array<{ deletion_reason: string }>;
    expect(reasons.map((r) => r.deletion_reason)).toEqual(["compacted"]);
  });

  test("doesn't touch already-deleted rows (admin/banned reasons preserved)", () => {
    const ids = insertN(3);
    softDeleteMessage(ids[0]!, "admin");
    compactRoomMessages(ROOM, 1);
    const r = db
      .query("SELECT id, deletion_reason FROM messages WHERE room_slug = ?")
      .all(ROOM) as Array<{ id: string; deletion_reason: string | null }>;
    const byId = new Map(r.map((row) => [row.id, row.deletion_reason]));
    expect(byId.get(ids[0]!)).toBe("admin");
    // One row stays live, the other was bumped from live to compacted:
    expect(byId.get(ids[2]!)).toBeNull(); // kept live
    expect(byId.get(ids[1]!)).toBe("compacted");
  });
});

// ── softDeleteMessagesByNick / byIp ──────────────────────────────

describe("ban-and-purge bulk delete", () => {
  test("byNick is case-insensitive and tags rows with reason 'banned'", () => {
    const ids = insertN(2, { nick: "Alice" });
    insertN(1, { nick: "bob" });
    const out = softDeleteMessagesByNick("ALICE");
    expect(out.map((r) => r.id).sort()).toEqual([...ids].sort());

    const wire = recentMessages(ROOM, 100);
    // 'banned' rows STAY on the wire as placeholders:
    expect(wire).toHaveLength(3);
    const alice = wire.filter((m) => m.nick === "Alice");
    expect(alice.every((m) => m.deletedAt !== null)).toBe(true);
    expect(alice.every((m) => m.body === "")).toBe(true);

    const reasons = db
      .query("SELECT deletion_reason FROM messages WHERE deleted_at IS NOT NULL")
      .all() as Array<{ deletion_reason: string }>;
    expect(reasons.every((r) => r.deletion_reason === "banned")).toBe(true);
  });

  test("byIp matches the ip column exactly", () => {
    insertN(1, { nick: "alice", ip: "10.0.0.1" });
    insertN(1, { nick: "bob", ip: "10.0.0.2" });
    const out = softDeleteMessagesByIp("10.0.0.1");
    expect(out).toHaveLength(1);
  });

  test("returns only rows that actually flipped (idempotent re-run)", () => {
    insertN(2, { nick: "alice" });
    expect(softDeleteMessagesByNick("alice")).toHaveLength(2);
    expect(softDeleteMessagesByNick("alice")).toHaveLength(0);
  });
});

// ── messagesBefore ───────────────────────────────────────────────

describe("messagesBefore — paginated history", () => {
  test("filters by before-timestamp and applies the same visibility rule", () => {
    const ids = insertN(5);
    softDeleteMessage(ids[1]!, "cleared"); // should be hidden
    softDeleteMessage(ids[2]!, "admin"); // should appear as placeholder

    const everything = messagesBefore(ROOM, Date.now() + 1, 100);
    expect(everything.map((m) => m.id)).toEqual([
      ids[0]!,
      ids[2]!,
      ids[3]!,
      ids[4]!,
    ]);
    expect(everything.find((m) => m.id === ids[2]!)?.deletedAt).not.toBeNull();
  });

  test("respects the limit and excludes the exact `before` boundary", () => {
    // Distinct timestamps so the strict `<` cutoff has something to
    // discriminate on (insertN would tie all three within one ms).
    const a = insertWithTimestamp(ROOM, 1_000);
    const b = insertWithTimestamp(ROOM, 2_000);
    insertWithTimestamp(ROOM, 3_000);
    // before = b's timestamp → excludes b and the row after it.
    const out = messagesBefore(ROOM, 2_000, 100);
    expect(out.map((m) => m.id)).toEqual([a]);
    expect(b).toBeDefined();
  });
});

// ── createRoom ───────────────────────────────────────────────────

describe("createRoom", () => {
  test("inserts and returns the room", () => {
    const r = createRoom({ slug: "x", name: "#x", description: null });
    expect(r).not.toBeNull();
    expect(r?.slug).toBe("x");
    expect(getRoom("x")?.name).toBe("#x");
  });

  test("returns null on slug conflict (room not overwritten)", () => {
    createRoom({ slug: "x", name: "#x", description: "first" });
    const second = createRoom({
      slug: "x",
      name: "#x-renamed",
      description: "second",
    });
    expect(second).toBeNull();
    expect(getRoom("x")?.description).toBe("first");
  });
});

// ── Banned words filter ──────────────────────────────────────────

describe("banned words", () => {
  test("empty list never flags anything", () => {
    expect(containsBannedWord("hello world")).toBeNull();
  });

  test("add → containsBannedWord matches case-insensitively as substring", () => {
    addBannedWord("spam");
    expect(containsBannedWord("This is SPAM!")).toBe("spam");
    expect(containsBannedWord("spammers gonna spam")).toBe("spam");
    expect(containsBannedWord("eat your eggs")).toBeNull();
  });

  test("addBannedWord on a duplicate (case-insensitive) is a no-op", () => {
    expect(addBannedWord("Spam")).toBe(true);
    expect(addBannedWord("SPAM")).toBe(false);
    expect(listBannedWords()).toHaveLength(1);
    // Display form is the first one inserted, not subsequent attempts:
    expect(listBannedWords()[0]?.word).toBe("Spam");
  });

  test("addBannedWord refreshes the in-process cache immediately", () => {
    expect(containsBannedWord("hello")).toBeNull();
    addBannedWord("hello");
    expect(containsBannedWord("HELLO world")).toBe("hello");
  });

  test("removeBannedWord clears the row + cache", () => {
    addBannedWord("spam");
    expect(removeBannedWord("SPAM")).toBe(true);
    expect(listBannedWords()).toEqual([]);
    expect(containsBannedWord("spam")).toBeNull();
  });

  test("removeBannedWord on a missing word returns false", () => {
    expect(removeBannedWord("nope")).toBe(false);
  });

  test("addBannedWord with empty/whitespace-only input is rejected", () => {
    expect(addBannedWord("   ")).toBe(false);
    expect(listBannedWords()).toEqual([]);
  });
});

// ── Community kill switch ────────────────────────────────────────

describe("community kill switch", () => {
  test("default state is enabled, no reason", () => {
    const s = getCommunityState();
    expect(s.enabled).toBe(true);
    expect(s.reason).toBeNull();
    expect(s.disabledAt).toBeNull();
    expect(isCommunityDisabled()).toBe(false);
  });

  test("setCommunityDisabled flips enabled + records reason + timestamp", () => {
    const s = setCommunityDisabled("maintenance");
    expect(s.enabled).toBe(false);
    expect(s.reason).toBe("maintenance");
    expect(s.disabledAt).toBeGreaterThan(0);
    expect(isCommunityDisabled()).toBe(true);
  });

  test("disable then enable returns to the live state", () => {
    setCommunityDisabled("test");
    const s = setCommunityEnabled();
    expect(s.enabled).toBe(true);
    expect(s.reason).toBeNull();
    expect(s.disabledAt).toBeNull();
  });

  test("disable with null reason still flips the switch", () => {
    const s = setCommunityDisabled(null);
    expect(s.enabled).toBe(false);
    expect(s.reason).toBeNull();
  });
});

// ── Direct messages ──────────────────────────────────────────────

describe("DMs", () => {
  function dm(from: string, to: string, body = "hi"): string {
    const id = randomUUID();
    insertDm({ id, fromNick: from, fromIp: "1.2.3.4", toNick: to, body });
    return id;
  }

  test("insertDm returns the wire shape with deletedAt: null", () => {
    const id = randomUUID();
    const out = insertDm({
      id,
      fromNick: "alice",
      fromIp: "1.2.3.4",
      toNick: "bob",
      body: "yo",
    });
    expect(out.id).toBe(id);
    expect(out.fromNick).toBe("alice");
    expect(out.toNick).toBe("bob");
    expect(out.body).toBe("yo");
    expect(out.deletedAt).toBeNull();
    expect(out.createdAt).toBeGreaterThan(0);
  });

  test("conversationBefore returns both directions (alice↔bob) chronologically", () => {
    const id1 = dm("alice", "bob", "first");
    const id2 = dm("bob", "alice", "second");
    const id3 = dm("alice", "bob", "third");

    const out = conversationBefore("alice", "bob", Date.now() + 1, 100);
    expect(out.map((m) => m.id)).toEqual([id1, id2, id3]);

    // Same conversation, asked for from the other side: identical result.
    const mirror = conversationBefore("bob", "alice", Date.now() + 1, 100);
    expect(mirror.map((m) => m.id)).toEqual([id1, id2, id3]);
  });

  test("conversationBefore is case-insensitive on both nick params", () => {
    dm("Alice", "Bob");
    const out = conversationBefore("ALICE", "BOB", Date.now() + 1, 100);
    expect(out).toHaveLength(1);
  });

  test("conversationBefore respects the limit and the `before` boundary", () => {
    // Distinct timestamps so the strict `<` cutoff is observable.
    const a = insertDmWithTimestamp("alice", "bob", 1_000);
    const b = insertDmWithTimestamp("alice", "bob", 2_000);
    const c = insertDmWithTimestamp("alice", "bob", 3_000);
    // Limit — newest two
    const limited = conversationBefore("alice", "bob", Date.now() + 1, 2);
    expect(limited.map((m) => m.id)).toEqual([b, c]);
    // Boundary (exclusive) — `before = 2000` returns only the row at t=1000
    const older = conversationBefore("alice", "bob", 2_000, 100);
    expect(older.map((m) => m.id)).toEqual([a]);
  });

  test("listConversationsFor groups by peer and surfaces the latest message", () => {
    dm("alice", "bob", "older bob msg");
    const latestBob = dm("alice", "bob", "latest bob msg");
    const latestCarol = dm("carol", "alice", "from carol");

    const out = listConversationsFor("alice");
    // newest-first
    const peers = out.map((c) => c.peerNick.toLowerCase());
    expect(peers).toEqual(["carol", "bob"]);

    const bobThread = out.find((c) => c.peerNick.toLowerCase() === "bob");
    expect(bobThread?.lastMessage.id).toBe(latestBob);

    const carolThread = out.find((c) => c.peerNick.toLowerCase() === "carol");
    expect(carolThread?.lastMessage.id).toBe(latestCarol);
  });

  test("listConversationsFor for a nick with no DMs returns []", () => {
    dm("alice", "bob");
    expect(listConversationsFor("ghost")).toEqual([]);
  });
});
