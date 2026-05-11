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

export type ChatEvent =
  | ReplayEvent
  | NewMessageEvent
  | MessageDeletedEvent
  | MessagePinnedEvent
  | MessageUnpinnedEvent;
