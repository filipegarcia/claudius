// Per-room pub/sub fan-out.
//
// Mirrors the shape of Claudius' NotificationBus
// (lib/server/notification-bus.ts) but scoped to rooms: a subscriber
// registers for a single room slug, and producers broadcast to that
// room's set. Cross-room traffic is rare (admin pin/delete from the
// admin panel), so we keep a Map<slug, Set<Subscriber>> rather than a
// global broadcast list.

import type { ChatEvent } from "./types.ts";

type Subscriber = (event: ChatEvent) => void;

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
