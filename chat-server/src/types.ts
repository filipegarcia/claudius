// Shared types for the chat server.
//
// IMPORTANT: keep this in sync with `lib/shared/community.ts` in the
// Claudius repo — the SSE wire format flows between them. They live in
// two files (rather than a shared package) because chat-server is a
// standalone deployable that shouldn't carry the Next.js repo as a
// dependency. The surface is small enough that drift is easy to spot.

export type Room = {
  slug: string;
  name: string;
  description: string | null;
  pinnedMessageId: string | null;
};

export type Message = {
  id: string;
  roomSlug: string;
  nick: string;
  body: string;
  isAdmin: boolean;
  createdAt: number; // epoch ms
  /**
   * Soft-delete timestamp. `null` for live messages. When set, the
   * message stays on the wire so clients can render a "deleted by
   * admin" placeholder in place of the original body — historical
   * audit trail without leaking the original content (the server
   * still has it, but doesn't ship it on the wire).
   */
  deletedAt: number | null;
};

export type BanKind = "nick" | "ip";

export type Ban = {
  id: number;
  kind: BanKind;
  value: string;
  reason: string | null;
  createdAt: number;
};

// ── SSE wire envelope ──────────────────────────────────────────────
//
// The server emits exactly one `replay` on connect (which may be empty)
// then a stream of incremental events. The client treats `replay` as
// authoritative for the visible window and applies later events on top.

export type ReplayEvent = {
  type: "replay";
  roomSlug: string;
  messages: Message[];
  pinnedMessageId: string | null;
};

export type NewMessageEvent = {
  type: "message";
  message: Message;
};

export type MessageDeletedEvent = {
  type: "message_deleted";
  roomSlug: string;
  id: string;
};

export type MessagePinnedEvent = {
  type: "message_pinned";
  roomSlug: string;
  id: string;
};

export type MessageUnpinnedEvent = {
  type: "message_unpinned";
  roomSlug: string;
};

/**
 * Server-wide on/off signal. Emitted to every connected subscriber
 * (across all rooms) when an admin flips the community kill switch,
 * and once at the start of each new stream so newcomers learn the
 * current state. When `enabled` is `false`, posting is rejected with
 * 503 and the client renders an offline overlay.
 */
export type CommunityStateEvent = {
  type: "community_state";
  enabled: boolean;
  reason: string | null;
};

export type ChatEvent =
  | ReplayEvent
  | NewMessageEvent
  | MessageDeletedEvent
  | MessagePinnedEvent
  | MessageUnpinnedEvent
  | CommunityStateEvent;

// ── Direct messages ────────────────────────────────────────────────
//
// DMs travel on their own per-nick SSE stream (`GET /dms/stream?for=<nick>`)
// and have their own POST endpoint. Same trust model as channels —
// anyone can claim a nick — but the routing only delivers a message
// to the sender's and recipient's subscribers (not the whole room).

export type DM = {
  id: string;
  fromNick: string;
  toNick: string;
  body: string;
  createdAt: number; // epoch ms
  /**
   * Self-delete or admin ban-purge timestamp; `null` for live DMs.
   * Body is blanked on the wire when set; client renders a "[deleted]"
   * placeholder same shape as channel messages.
   */
  deletedAt: number | null;
};

/** Live DM arrival. */
export type DMEvent = {
  type: "dm";
  message: DM;
};

/** DM has been soft-deleted on the server. */
export type DMDeletedEvent = {
  type: "dm_deleted";
  id: string;
};

/** Tag union for the per-nick DM SSE stream. */
export type DMStreamEvent = DMEvent | DMDeletedEvent;
