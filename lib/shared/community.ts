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

// ── SSE wire envelope ──────────────────────────────────────────────

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

export type ChatEvent =
  | ReplayEvent
  | NewMessageEvent
  | MessageDeletedEvent
  | MessagePinnedEvent
  | MessageUnpinnedEvent;

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
