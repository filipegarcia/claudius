// Wire types for the /community page.
//
// IMPORTANT: keep this in sync with `chat-server/src/types.ts`. The
// chat-server is a standalone deployable and can't import from this
// repo — these two files form a shared protocol that we keep aligned
// by hand. The surface is small enough that drift is easy to spot.

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
   * Soft-delete timestamp set by an admin. `null` for live messages.
   * When non-null, the server has blanked the body and the client
   * renders a `[deleted by admin]` placeholder in place of the
   * original content (audit trail without the leaked text).
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

/**
 * One entry in the admin-curated banned-words list. The server
 * matches `word` (case-insensitive substring) against channel posts
 * before insert and rejects with 400 on a hit. DM posts are
 * deliberately not filtered.
 */
export type BannedWord = {
  word: string;
  addedAt: number;
};

/**
 * Admin-only roster row for a channel. The chat-server has no
 * membership table — public rooms have no join/leave — so this list
 * is a union of two runtime sources:
 *
 *   1. Posters: everyone with a live (non-deleted) message in this
 *      room. Carries `messageCount` ≥ 1 and timestamps.
 *   2. Online: currently-subscribed SSE clients whose handshake
 *      carried a nick. A lurker — connected but never posted — shows
 *      up with `online: true`, `messageCount: 0`, and null timestamps.
 *
 * `online` reflects active SSE connections at the moment the admin
 * fetched the roster; it's a snapshot, not a subscription (the panel
 * has a manual refresh button).
 */
export type ChannelMember = {
  nick: string;
  online: boolean;
  messageCount: number;
  /** Null when the member has never posted (online lurker). */
  firstSeen: number | null;
  /** Null when the member has never posted (online lurker). */
  lastSeen: number | null;
};

// ── SSE wire envelope ──────────────────────────────────────────────

/**
 * Recent-window broadcast — sent once at stream open with the most
 * recent REPLAY_LIMIT messages (currently 50), and re-sent by the
 * server when an EventSource reconnects. The client treats this as
 * ADDITIVE: it merges into the existing buffer so a parallel
 * `loadOlder` fetch and messages received between disconnect and
 * reconnect aren't clobbered. See `mergeReplayMessages`.
 */
export type ReplayEvent = {
  type: "replay";
  roomSlug: string;
  messages: Message[];
  pinnedMessageId: string | null;
};

/**
 * Authoritative room-state replacement. Emitted by the server when an
 * admin "clears" or "compacts" a room — the payload IS the new visible
 * state for every connected client. Same shape as `ReplayEvent` but
 * the client blind-replaces on this one (so a clear actually clears
 * and a compact actually trims, even when the user has older messages
 * cached locally from a prior session).
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
 * Server-wide kill switch state. Emitted to every connected client
 * across every room when an admin disables or re-enables the
 * community, and once at stream-open whenever the server is currently
 * disabled so newcomers immediately render the offline overlay.
 */
export type CommunityStateEvent = {
  type: "community_state";
  enabled: boolean;
  reason: string | null;
};

// ── Presence (admin-only HTTP, not SSE) ────────────────────────────
//
// The per-room "who's here" sidebar is admin-only and intentionally
// kept off the public SSE stream — see the matching block in
// chat-server/src/types.ts for the protocol semantics; both files
// must stay in sync. The admin client polls `GET /admin/rooms/:slug/
// presence` every few seconds.

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
// DMs are 1:1 private messages. Same trust model as channels — anyone
// can claim a nick, no real auth — but routing only delivers each DM
// to the sender's and recipient's per-nick SSE streams, not room-wide.
//
// Endpoints live on the chat-server (no Claudius proxy involved):
//   POST   /dms                              — send  { from, to, body }
//   GET    /dms/stream?for=<nick>            — SSE   live { dm | dm_deleted }
//   GET    /dms/conversations?for=<nick>     — list of conversation summaries
//   GET    /dms/conversation?for=&with=&...  — paginated thread (50 per page)

export type DM = {
  id: string;
  fromNick: string;
  toNick: string;
  body: string;
  createdAt: number;
  deletedAt: number | null;
};

export type DMEvent = { type: "dm"; message: DM };
export type DMDeletedEvent = { type: "dm_deleted"; id: string };
export type DMStreamEvent = DMEvent | DMDeletedEvent;

export type ConversationSummary = {
  peerNick: string;
  lastMessage: DM;
};

// ── Browser-side validation helpers (must match server) ─────────────

export const NICK_RE = /^[A-Za-z0-9_-]{1,20}$/;
export const MAX_BODY_LEN = 2000;

const RESERVED_NICKS = new Set([
  "admin",
  "claudius",
  "system",
  "mod",
  "moderator",
  "root",
]);

export function isValidNick(nick: string): boolean {
  const trimmed = nick.trim();
  if (!NICK_RE.test(trimmed)) return false;
  if (RESERVED_NICKS.has(trimmed.toLowerCase())) return false;
  return true;
}
