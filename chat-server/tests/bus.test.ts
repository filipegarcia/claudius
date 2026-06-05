// Bus fan-out tests.
//
// The two buses (chatBus per-room, dmBus per-nick) are the only pieces
// of in-process state between the HTTP layer and the SSE writer. Both
// are tiny but easy to get wrong on edges:
//   - Subscriber that throws shouldn't tank the rest of the room.
//   - `broadcastAll` reaches every room (kill switch).
//   - DM fanout delivers to BOTH parties so the sender's other tabs
//     see their own outbound DM.
//   - Subscriber sets shouldn't leak after the last unsubscribe.

import { beforeEach, describe, expect, test } from "bun:test";
import { chatBus, dmBus } from "../src/bus.ts";
import type { ChatEvent, DMStreamEvent, Message } from "../src/types.ts";

function fakeMessage(roomSlug: string, id = "m1"): Message {
  return {
    id,
    roomSlug,
    nick: "alice",
    body: "hello",
    isAdmin: false,
    createdAt: Date.now(),
    deletedAt: null,
  };
}

// Helpers don't reset the bus between tests because there's no public
// "drop all subscribers" — each test instead carries its own
// unsubscribe handles via collected closures, and we use unique room
// slugs / nicks per test so cross-test bleed isn't possible.

let unsubs: Array<() => void> = [];

beforeEach(() => {
  for (const fn of unsubs) fn();
  unsubs = [];
});

function track(unsub: () => void) {
  unsubs.push(unsub);
}

// ── chatBus ──────────────────────────────────────────────────────

describe("chatBus.broadcast", () => {
  test("fans out to subscribers of the event's roomSlug only", () => {
    const r1: ChatEvent[] = [];
    const r2: ChatEvent[] = [];
    track(chatBus.subscribe("room-a", (e) => r1.push(e)));
    track(chatBus.subscribe("room-b", (e) => r2.push(e)));

    chatBus.broadcast({ type: "message", message: fakeMessage("room-a") });
    expect(r1).toHaveLength(1);
    expect(r2).toHaveLength(0);
  });

  test("resolves the slug for events that carry it at the top level", () => {
    const seen: ChatEvent[] = [];
    track(chatBus.subscribe("room-pin", (e) => seen.push(e)));

    chatBus.broadcast({
      type: "message_pinned",
      roomSlug: "room-pin",
      id: "x",
    });
    chatBus.broadcast({
      type: "message_deleted",
      roomSlug: "other-room",
      id: "y",
    });
    expect(seen.map((e) => e.type)).toEqual(["message_pinned"]);
  });

  test("one throwing subscriber doesn't drop delivery to the rest", () => {
    const ok: ChatEvent[] = [];
    track(
      chatBus.subscribe("room-throw", () => {
        throw new Error("boom");
      }),
    );
    track(chatBus.subscribe("room-throw", (e) => ok.push(e)));

    expect(() =>
      chatBus.broadcast({
        type: "message",
        message: fakeMessage("room-throw"),
      }),
    ).not.toThrow();
    expect(ok).toHaveLength(1);
  });

  test("unsubscribe removes only that listener", () => {
    const a: ChatEvent[] = [];
    const b: ChatEvent[] = [];
    const unsubA = chatBus.subscribe("room-unsub", (e) => a.push(e));
    track(chatBus.subscribe("room-unsub", (e) => b.push(e)));
    unsubA();

    chatBus.broadcast({
      type: "message",
      message: fakeMessage("room-unsub"),
    });
    expect(a).toHaveLength(0);
    expect(b).toHaveLength(1);
  });

  test("size() reflects subscriber count and goes to 0 after the last unsubscribe", () => {
    expect(chatBus.size("room-size")).toBe(0);
    const u1 = chatBus.subscribe("room-size", () => {});
    const u2 = chatBus.subscribe("room-size", () => {});
    expect(chatBus.size("room-size")).toBe(2);
    u1();
    expect(chatBus.size("room-size")).toBe(1);
    u2();
    expect(chatBus.size("room-size")).toBe(0);
  });
});

describe("chatBus.activeNicks", () => {
  test("empty when no one is subscribed", () => {
    expect(chatBus.activeNicks("an-empty")).toEqual([]);
  });

  test("returns claimed nicks from the handshake opts", () => {
    track(chatBus.subscribe("an-room", () => {}, { nick: "alice" }));
    track(chatBus.subscribe("an-room", () => {}, { nick: "bob" }));
    expect(chatBus.activeNicks("an-room").sort()).toEqual(["alice", "bob"]);
  });

  test("skips anonymous subscribers (no nick on handshake)", () => {
    track(chatBus.subscribe("an-anon", () => {}, { nick: "alice" }));
    track(chatBus.subscribe("an-anon", () => {}));
    track(chatBus.subscribe("an-anon", () => {}, { nick: null }));
    expect(chatBus.activeNicks("an-anon")).toEqual(["alice"]);
    // size() still counts every subscriber including anonymous ones —
    // diagnostics ≠ roster.
    expect(chatBus.size("an-anon")).toBe(3);
  });

  test("dedups case-insensitively, preserves first-seen casing", () => {
    track(chatBus.subscribe("an-case", () => {}, { nick: "Alice" }));
    track(chatBus.subscribe("an-case", () => {}, { nick: "alice" }));
    track(chatBus.subscribe("an-case", () => {}, { nick: "ALICE" }));
    const nicks = chatBus.activeNicks("an-case");
    expect(nicks).toEqual(["Alice"]);
  });

  test("scoped per-room — alice in room-x doesn't leak into room-y", () => {
    track(chatBus.subscribe("an-x", () => {}, { nick: "alice" }));
    track(chatBus.subscribe("an-y", () => {}, { nick: "bob" }));
    expect(chatBus.activeNicks("an-x")).toEqual(["alice"]);
    expect(chatBus.activeNicks("an-y")).toEqual(["bob"]);
  });

  test("unsubscribe drops the nick from the list", () => {
    const unsub = chatBus.subscribe("an-leave", () => {}, { nick: "alice" });
    track(chatBus.subscribe("an-leave", () => {}, { nick: "bob" }));
    expect(chatBus.activeNicks("an-leave").sort()).toEqual(["alice", "bob"]);
    unsub();
    expect(chatBus.activeNicks("an-leave")).toEqual(["bob"]);
  });
});

describe("chatBus.broadcastAll", () => {
  test("delivers system events to every subscribed room", () => {
    const r1: ChatEvent[] = [];
    const r2: ChatEvent[] = [];
    track(chatBus.subscribe("ba-room-1", (e) => r1.push(e)));
    track(chatBus.subscribe("ba-room-2", (e) => r2.push(e)));

    chatBus.broadcastAll({
      type: "community_state",
      enabled: false,
      reason: "maintenance",
    });
    expect(r1).toHaveLength(1);
    expect(r2).toHaveLength(1);
    expect(r1[0]).toEqual({
      type: "community_state",
      enabled: false,
      reason: "maintenance",
    });
  });

  test("a throwing subscriber doesn't block delivery to subsequent rooms", () => {
    const ok: ChatEvent[] = [];
    track(
      chatBus.subscribe("ba-throw", () => {
        throw new Error("boom");
      }),
    );
    track(chatBus.subscribe("ba-ok", (e) => ok.push(e)));

    expect(() =>
      chatBus.broadcastAll({
        type: "community_state",
        enabled: true,
        reason: null,
      }),
    ).not.toThrow();
    expect(ok).toHaveLength(1);
  });
});

// ── dmBus ────────────────────────────────────────────────────────

describe("dmBus.broadcastDm", () => {
  test("delivers to both `from` and `to` subscribers", () => {
    const alice: DMStreamEvent[] = [];
    const bob: DMStreamEvent[] = [];
    track(dmBus.subscribe("alice", (e) => alice.push(e)));
    track(dmBus.subscribe("bob", (e) => bob.push(e)));

    dmBus.broadcastDm(
      { from: "alice", to: "bob" },
      {
        type: "dm",
        message: {
          id: "d1",
          fromNick: "alice",
          toNick: "bob",
          body: "hi",
          createdAt: Date.now(),
          deletedAt: null,
        },
      },
    );
    expect(alice).toHaveLength(1);
    expect(bob).toHaveLength(1);
  });

  test("a self-DM (from === to, ignoring case) doesn't deliver twice", () => {
    const seen: DMStreamEvent[] = [];
    track(dmBus.subscribe("solo", (e) => seen.push(e)));

    dmBus.broadcastDm(
      { from: "Solo", to: "solo" },
      {
        type: "dm",
        message: {
          id: "d1",
          fromNick: "Solo",
          toNick: "solo",
          body: "hi",
          createdAt: Date.now(),
          deletedAt: null,
        },
      },
    );
    // Server-side validation rejects self-DMs at the handler level
    // anyway, but the bus must not duplicate-deliver if asked.
    expect(seen).toHaveLength(1);
  });

  test("subscribe routing key is case-insensitive (Alice == alice)", () => {
    const seen: DMStreamEvent[] = [];
    track(dmBus.subscribe("Alice", (e) => seen.push(e)));

    dmBus.broadcastDm(
      { from: "alice", to: "bob" },
      {
        type: "dm",
        message: {
          id: "d-case",
          fromNick: "alice",
          toNick: "bob",
          body: "x",
          createdAt: Date.now(),
          deletedAt: null,
        },
      },
    );
    expect(seen).toHaveLength(1);
  });

  test("unsubscribe stops further delivery", () => {
    const seen: DMStreamEvent[] = [];
    const unsub = dmBus.subscribe("ephemeral", (e) => seen.push(e));
    unsub();

    dmBus.broadcastDm(
      { from: "ephemeral", to: "other" },
      {
        type: "dm",
        message: {
          id: "d2",
          fromNick: "ephemeral",
          toNick: "other",
          body: "x",
          createdAt: Date.now(),
          deletedAt: null,
        },
      },
    );
    expect(seen).toHaveLength(0);
  });

  test("dm_deleted is fanned out same as dm", () => {
    const seen: DMStreamEvent[] = [];
    track(dmBus.subscribe("dela", (e) => seen.push(e)));
    track(dmBus.subscribe("delb", (e) => seen.push(e)));

    dmBus.broadcastDm(
      { from: "dela", to: "delb" },
      { type: "dm_deleted", id: "d3" },
    );
    expect(seen).toHaveLength(2);
    expect(seen.every((e) => e.type === "dm_deleted")).toBe(true);
  });
});
