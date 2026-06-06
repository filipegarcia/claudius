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
// The server emits exactly one `replay` on connect (carrying the most
// recent window — see REPLAY_LIMIT in server.ts), then a stream of
// incremental events. `replay` is ADDITIVE on the client side: the
// browser merges it into whatever is already in the local buffer so
// that a parallel "load older" pull, and any messages that arrived
// between an SSE disconnect and the reconnect's fresh replay, are
// preserved. For authoritative DESTRUCTIVE state changes (admin clear,
// admin compact) the server emits the distinct `room_replaced` event —
// the client blind-replaces on that one.

export type ReplayEvent = {
  type: "replay";
  roomSlug: string;
  messages: Message[];
  pinnedMessageId: string | null;
};

/**
 * Authoritative room-state replacement. Used by the admin "clear room"
 * and "compact room" actions to push the post-action state to every
 * connected subscriber. Same payload shape as `replay`, but the client
 * applies it with a blind replace rather than a merge — that's the
 * whole reason it's a separate event tag.
 */
export type RoomReplacedEvent = {
  type: "room_replaced";
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

// ── Presence (admin-only HTTP, not SSE) ────────────────────────────
//
// The per-room "who's here" sidebar is admin-only and intentionally
// kept off the public SSE stream — a chatty room would otherwise leak
// the full nick roster to anyone with the wire, including curl. The
// admin client polls `GET /admin/rooms/:slug/presence` every few
// seconds to refresh the list; near-real-time is good enough for the
// moderation surface.
//
// Trust model: still anyone-can-claim-a-nick at the SSE handshake.
// The admin-only surface is access control on *who can read the
// roster*, not authenticity of individual nicks.

/** Snapshot returned by `GET /admin/rooms/:slug/presence`. */
export type PresenceSnapshot = {
  nicks: string[];
};

export type ChatEvent =
  | ReplayEvent
  | RoomReplacedEvent
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
