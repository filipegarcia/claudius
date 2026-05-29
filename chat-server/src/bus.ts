// Per-room pub/sub fan-out.
//
// Mirrors the shape of Claudius' NotificationBus
// (lib/server/notification-bus.ts) but scoped to rooms: a subscriber
// registers for a single room slug, and producers broadcast to that
// room's set. Cross-room traffic is rare (admin pin/delete from the
// admin panel), so we keep a Map<slug, Set<Subscriber>> rather than a
// global broadcast list.

import type { ChatEvent, DMStreamEvent } from "./types.ts";

type Subscriber = (event: ChatEvent) => void;
type DMSubscriber = (event: DMStreamEvent) => void;

class ChatBus {
  private subscribers = new Map<string, Set<Subscriber>>();

  /** Subscribe to one room. Returns the unsubscribe handle. */
  subscribe(roomSlug: string, fn: Subscriber): () => void {
    let set = this.subscribers.get(roomSlug);
    if (!set) {
      set = new Set();
      this.subscribers.set(roomSlug, set);
    }
    set.add(fn);
    return () => {
      const s = this.subscribers.get(roomSlug);
      if (!s) return;
      s.delete(fn);
      if (s.size === 0) this.subscribers.delete(roomSlug);
    };
  }

  /**
   * Fan out to every subscriber of the room named in the event payload.
   *
   * The "message" event shape nests `roomSlug` under `.message`, while
   * the other event shapes carry it at the top level. We resolve from
   * both places so callers don't have to think about it.
   */
  broadcast(event: ChatEvent): void {
    const slug = resolveSlug(event);
    if (!slug) return;
    const set = this.subscribers.get(slug);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(event);
      } catch (err) {
        // Per the NotificationBus convention: one bad subscriber must
        // not tank the rest. SSE writes can throw on closed sockets
        // before the abort handler runs; we just drop them.
        console.warn("[chat-server] subscriber threw", err);
      }
    }
  }

  /** Subscriber count for one room — handy for /health diagnostics. */
  size(roomSlug: string): number {
    return this.subscribers.get(roomSlug)?.size ?? 0;
  }

  /**
   * Fan out to every subscriber, regardless of room. Used for
   * system-wide events (the community_state kill switch) that aren't
   * scoped to a room. Keeping this separate from `broadcast()` keeps
   * the per-room routing path fast and free of branching on the
   * event-tag.
   */
  broadcastAll(event: ChatEvent): void {
    for (const set of this.subscribers.values()) {
      for (const fn of set) {
        try {
          fn(event);
        } catch (err) {
          console.warn("[chat-server] subscriber threw", err);
        }
      }
    }
  }
}

function resolveSlug(event: ChatEvent): string | null {
  // NewMessageEvent: slug is nested under message; system-wide events
  // (community_state) carry no slug. Everything else has it at top level.
  if (event.type === "message") return event.message.roomSlug;
  if (event.type === "community_state") return null;
  return event.roomSlug ?? null;
}

export const chatBus = new ChatBus();
export type { ChatBus };

/**
 * Per-nick DM bus. Subscribers register for their own nick (or the
 * recipient's, when watching incoming DMs); producers broadcast to
 * BOTH the sender's and recipient's subscriber sets so all of the
 * sender's open tabs see their own outbound DMs too (mirrors the
 * room model where your message echoes back over SSE).
 *
 * Routing key is the nick lowercased — same dedup convention as the
 * bans table — so case differences (Alice vs alice) don't split the
 * fanout.
 */
class DMBus {
  private subscribers = new Map<string, Set<DMSubscriber>>();

  subscribe(nick: string, fn: DMSubscriber): () => void {
    const key = nick.toLowerCase();
    let set = this.subscribers.get(key);
    if (!set) {
      set = new Set();
      this.subscribers.set(key, set);
    }
    set.add(fn);
    return () => {
      const s = this.subscribers.get(key);
      if (!s) return;
      s.delete(fn);
      if (s.size === 0) this.subscribers.delete(key);
    };
  }

  /**
   * Deliver to one nick's subscribers. Used internally by `broadcastDm`
   * which fans out to both ends of a conversation.
   */
  private fanOut(nick: string, event: DMStreamEvent): void {
    const set = this.subscribers.get(nick.toLowerCase());
    if (!set) return;
    for (const fn of set) {
      try {
        fn(event);
      } catch (err) {
        console.warn("[chat-server] dm subscriber threw", err);
      }
    }
  }

  /**
   * Deliver one DM event to both parties' subscribers. For an arriving
   * `dm`, pass {from, to} so the sender's other tabs and the recipient
   * both see it. For a `dm_deleted`, same — both ends update their
   * thread view.
   */
  broadcastDm(parties: { from: string; to: string }, event: DMStreamEvent): void {
    this.fanOut(parties.from, event);
    if (parties.from.toLowerCase() !== parties.to.toLowerCase()) {
      this.fanOut(parties.to, event);
    }
  }

  size(nick: string): number {
    return this.subscribers.get(nick.toLowerCase())?.size ?? 0;
  }
}

export const dmBus = new DMBus();
export type { DMBus };
