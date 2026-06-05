// Per-room message cache for /community.
//
// Shared by `useCommunity` (the hook that drives the chat surface) and
// `useCommunityNotifications` (the layout-level provider that drives
// unread badges from a per-room SSE fanout). The notifications hook
// receives messages for rooms the user *isn't currently viewing*, and
// without this cache they'd be invisible when the user later opens
// that room — the join `replay` from older chat-server deployments is
// empty, so there'd be nothing to populate the buffer with.
//
// Storage shape: one `RoomCache` per room slug, JSON-serialized into a
// single localStorage key. A module-level singleton mirrors the
// localStorage state in memory so reads during render don't hit the
// storage API every time, and writes from both hooks coordinate
// through the same debounced persistence call.

import type { Message } from "@/lib/shared/community";

const LS_MESSAGES_CACHE = "claudius.community.messages";

// Per-room cap on persisted messages. The hook may hold more in memory
// (after multiple "Load older" pulls), but we only persist this much so
// localStorage doesn't grow unbounded across a long-running browser.
// Sized at 4× REPLAY_LIMIT — a comfortable buffer for "I scrolled up a
// bit" without becoming a storage hog with dozens of rooms.
const MESSAGES_CACHE_MAX_PER_ROOM = 200;

// Debounce window for localStorage writes. Each meaningful change
// schedules a persist; if more changes land within this window the
// timer resets and we batch them into one write. 500ms is tight
// enough that a user closing the tab won't typically lose state, and
// loose enough that a chatty channel doesn't thrash the storage API.
const PERSIST_DEBOUNCE_MS = 500;

export type RoomCache = {
  messages: Message[];
  pinnedId: string | null;
  hasMore: boolean;
};

function readFromStorage(): Record<string, RoomCache> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(LS_MESSAGES_CACHE);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    // Light-touch validation: keep entries whose shape matches what we
    // wrote. Anything stale or hand-edited gets dropped silently so the
    // hook always works against a sane in-memory model.
    const out: Record<string, RoomCache> = {};
    for (const [slug, val] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      if (
        val &&
        typeof val === "object" &&
        Array.isArray((val as RoomCache).messages)
      ) {
        const v = val as Partial<RoomCache>;
        out[slug] = {
          messages: (v.messages ?? []) as Message[],
          pinnedId: typeof v.pinnedId === "string" ? v.pinnedId : null,
          hasMore: typeof v.hasMore === "boolean" ? v.hasMore : true,
        };
      }
    }
    return out;
  } catch {
    return {};
  }
}

function writeToStorage(cache: Record<string, RoomCache>) {
  if (typeof window === "undefined") return;
  try {
    // Cap each room's persisted slice so a chatty channel can't push
    // localStorage past quota. The in-memory state can hold more.
    const capped: Record<string, RoomCache> = {};
    for (const [slug, entry] of Object.entries(cache)) {
      capped[slug] = {
        ...entry,
        messages:
          entry.messages.length > MESSAGES_CACHE_MAX_PER_ROOM
            ? entry.messages.slice(-MESSAGES_CACHE_MAX_PER_ROOM)
            : entry.messages,
      };
    }
    window.localStorage.setItem(LS_MESSAGES_CACHE, JSON.stringify(capped));
  } catch {
    // Quota exceeded / private mode — silently drop. The cache is a
    // UX nicety, not load-bearing for correctness.
  }
}

// Module-level singleton holding the in-memory mirror of the per-room
// cache. Lazy-loaded from localStorage on first read so the cost is
// paid once per tab, not once per hook mount. Shared by all consumers
// (useCommunity + the notifications provider) so writes from one are
// immediately visible to the other.
let singleton: Record<string, RoomCache> | null = null;

/** Lazy-loaded reference to the in-memory cache. */
export function getMessagesCache(): Record<string, RoomCache> {
  if (singleton === null) singleton = readFromStorage();
  return singleton;
}

// Debounced persistence — both hooks call `schedulePersist()` after
// mutating the cache, and the timer collapses the bursts into one
// localStorage write per debounce window.
let persistTimer: ReturnType<typeof setTimeout> | null = null;
export function schedulePersist(): void {
  if (typeof window === "undefined") return;
  if (persistTimer !== null) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    if (singleton) writeToStorage(singleton);
  }, PERSIST_DEBOUNCE_MS);
}

/**
 * Replace one room's cache entry wholesale and schedule a persist.
 * Used by `useCommunity` to mirror its current React state into the
 * cache as the user interacts with a room.
 */
export function setRoomCacheEntry(slug: string, entry: RoomCache): void {
  const cache = getMessagesCache();
  cache[slug] = entry;
  schedulePersist();
}

/**
 * Append a live message to a room's cached buffer. Used by the
 * notifications provider when a message arrives for a room the user
 * isn't currently viewing — without this, the user would get the
 * badge but, on opening the room, see only their previously-cached
 * messages (an un-upgraded chat-server's empty join `replay` doesn't
 * carry the new message either).
 *
 * Dedupes by id so a later replay redelivering the same row is a
 * no-op. Does NOT touch pinnedId / hasMore — those are owned by the
 * chat surface's own event reducer.
 */
export function appendMessageToCache(slug: string, msg: Message): void {
  const cache = getMessagesCache();
  const entry = cache[slug] ?? {
    messages: [],
    pinnedId: null,
    hasMore: true,
  };
  if (entry.messages.some((m) => m.id === msg.id)) return;
  cache[slug] = {
    ...entry,
    messages: [...entry.messages, msg],
  };
  schedulePersist();
}

/**
 * Flip a cached message's `deletedAt` timestamp in place. Mirrors the
 * server's `message_deleted` event so the cache reflects moderation
 * actions the notifications-side SSE saw, even if the user wasn't on
 * that room's chat surface when the event arrived.
 *
 * If the message isn't in the cache, this is a no-op — we don't
 * conjure a placeholder row just to mark it deleted.
 */
export function markMessageDeletedInCache(slug: string, id: string): void {
  const cache = getMessagesCache();
  const entry = cache[slug];
  if (!entry) return;
  let changed = false;
  const messages = entry.messages.map((m) => {
    if (m.id !== id || m.deletedAt !== null) return m;
    changed = true;
    return { ...m, body: "", deletedAt: Date.now() };
  });
  if (!changed) return;
  cache[slug] = {
    ...entry,
    messages,
    pinnedId: entry.pinnedId === id ? null : entry.pinnedId,
  };
  schedulePersist();
}
