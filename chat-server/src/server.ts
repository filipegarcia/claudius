// HTTP entrypoint for the chat server. Run with `bun src/server.ts`.
//
// The routes intentionally read like one straight column: a small
// dispatch table at the top, each handler is one short function. No
// framework — Bun's `serve()` plus URL pattern matching is enough at
// this scale and keeps the bundle / startup time tiny.
//
// SSE shape mirrors Claudius' /api/notifications/stream/route.ts:
//   1. open the ReadableStream
//   2. immediately push a `replay` event (last 100 messages)
//   3. subscribe to the room bus; every event becomes one `data:` frame
//   4. 15-second heartbeat comment line keeps proxies happy
//   5. on req.signal abort → unsubscribe + close
//
// CORS: the server is meant to be hit from a Claudius browser tab
// running on a different origin. Reads + writes are auth'd by app
// logic (nickname / admin token), no cookies, so `*` is safe for the
// origin header. Headers we accept are pinned to what the client
// actually sends (content-type + x-admin-token) so a malicious page
// can't probe arbitrary headers.

import { randomUUID } from "node:crypto";
import { isAdminRequest, isReservedNick } from "./admin.ts";
import { chatBus, dmBus } from "./bus.ts";
import {
  addBannedWord,
  clearRoomMessages,
  compactRoomMessages,
  containsBannedWord,
  conversationBefore,
  createRoom,
  deleteBan,
  getCommunityState,
  getMessage,
  getRoom,
  insertBan,
  insertDm,
  insertMessage,
  isBanned,
  isCommunityDisabled,
  lastIpForNick,
  listBannedWords,
  listBans,
  listConversationsFor,
  listRooms,
  messagesBefore,
  recentLiveMessages,
  recentMessages,
  removeBannedWord,
  setCommunityDisabled,
  setCommunityEnabled,
  setRoomPin,
  softDeleteMessage,
  softDeleteMessagesByIp,
  softDeleteMessagesByNick,
} from "./db.ts";
import { tryConsume } from "./rate-limit.ts";
import type { BanKind, ChatEvent, DMStreamEvent } from "./types.ts";

const PORT = Number(process.env.PORT ?? 8787);

// When the server runs behind a trusted reverse proxy (Caddy/nginx on
// the same box, optionally fronted by Cloudflare), the socket-level
// remote address is the proxy, not the user — so the IP-ban + rate
// limiter would treat everyone as one client. Set TRUST_PROXY_IP_HEADERS=1
// in that deploy to read the real client IP from CF-Connecting-IP
// (Cloudflare) or the first hop of X-Forwarded-For. Left off by
// default because trusting these headers when *not* behind a proxy
// lets anyone spoof an IP via curl.
const TRUST_PROXY_IP_HEADERS = process.env.TRUST_PROXY_IP_HEADERS === "1";

function getClientIp(
  req: Request,
  srv: { requestIP(req: Request): { address: string } | null },
): string {
  if (TRUST_PROXY_IP_HEADERS) {
    const cf = req.headers.get("cf-connecting-ip");
    if (cf) return cf.trim();
    const xff = req.headers.get("x-forwarded-for");
    if (xff) {
      const first = xff.split(",")[0]?.trim();
      if (first) return first;
    }
  }
  return srv.requestIP(req)?.address ?? "unknown";
}

// ── CORS ───────────────────────────────────────────────────────────

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Admin-Token",
  "Access-Control-Max-Age": "86400",
};

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
      ...(init.headers ?? {}),
    },
  });
}

function error(status: number, message: string): Response {
  return json({ error: message }, { status });
}

// ── Validation ─────────────────────────────────────────────────────

const NICK_RE = /^[A-Za-z0-9_-]{1,20}$/;
const MAX_BODY_LEN = 2000;

function validateNick(nick: unknown): string | null {
  if (typeof nick !== "string") return null;
  const trimmed = nick.trim();
  if (!NICK_RE.test(trimmed)) return null;
  if (isReservedNick(trimmed)) return null;
  return trimmed;
}

function validateBody(body: unknown): string | null {
  if (typeof body !== "string") return null;
  const trimmed = body.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_BODY_LEN) return null;
  return trimmed;
}

// ── Route handlers ─────────────────────────────────────────────────

function handleListRooms(): Response {
  return json({ rooms: listRooms() });
}

function handleStream(roomSlug: string, req: Request): Response {
  if (!getRoom(roomSlug)) return error(404, "no such room");
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (evt: ChatEvent) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(evt)}\n\n`));
        } catch {
          // controller closed — abort handler will clean up.
        }
      };

      // 1. Send an empty replay — newcomers see a clean room and
      //    pull history on demand via /rooms/:slug/messages?before=
      //    &limit=50 (see handleBackfill). We still emit the event
      //    (with messages: []) so the client knows the room's pin
      //    state and resets its local buffer to "fresh."
      const room = getRoom(roomSlug);
      send({
        type: "replay",
        roomSlug,
        messages: [],
        pinnedMessageId: room?.pinnedMessageId ?? null,
      });

      // 2. If the community is currently disabled, tell this client
      //    so it renders the offline overlay immediately. (Clients
      //    default to enabled, so we only send the event when we
      //    need to override that default.)
      const state = getCommunityState();
      if (!state.enabled) {
        send({
          type: "community_state",
          enabled: false,
          reason: state.reason,
        });
      }

      // 3. Subscribe for live updates.
      const unsubscribe = chatBus.subscribe(roomSlug, send);

      // 3. Heartbeat — comment lines are ignored by the EventSource
      //    spec but keep load balancers from killing the socket.
      const hb = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          // closed
        }
      }, 15_000);

      const cleanup = () => {
        clearInterval(hb);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      const signal = req.signal;
      if (signal) {
        if (signal.aborted) cleanup();
        else signal.addEventListener("abort", cleanup, { once: true });
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      ...CORS_HEADERS,
    },
  });
}

async function handleBackfill(roomSlug: string, url: URL): Promise<Response> {
  if (!getRoom(roomSlug)) return error(404, "no such room");
  const beforeRaw = url.searchParams.get("before");
  const before = beforeRaw ? Number(beforeRaw) : Date.now();
  if (!Number.isFinite(before)) return error(400, "bad before");
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 500);
  return json({ messages: messagesBefore(roomSlug, before, limit) });
}

async function handlePostMessage(
  roomSlug: string,
  req: Request,
  ip: string,
): Promise<Response> {
  if (!getRoom(roomSlug)) return error(404, "no such room");
  if (isCommunityDisabled()) {
    return error(503, "community is currently disabled by an admin");
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return error(400, "invalid JSON");
  }
  const { nick: rawNick, body: rawBody } = (payload ?? {}) as Record<string, unknown>;

  const nick = validateNick(rawNick);
  if (!nick) return error(400, "invalid nick (1-20 chars, [A-Za-z0-9_-], not reserved)");
  const body = validateBody(rawBody);
  if (!body) return error(400, `invalid body (1-${MAX_BODY_LEN} chars)`);

  if (isBanned("nick", nick.toLowerCase())) return error(403, "nick banned");
  if (isBanned("ip", ip)) return error(403, "ip banned");

  // Banned-words filter — channel posts only (DMs deliberately
  // bypass this; see migration 004_banned_words.sql for the rationale).
  // Reject before insert so the row never hits the bus.
  const offending = containsBannedWord(body);
  if (offending !== null) {
    return error(400, `message contains a banned word ("${offending}")`);
  }

  if (!tryConsume(ip)) return error(429, "slow down");

  const msg = insertMessage({
    id: randomUUID(),
    roomSlug,
    nick,
    ip,
    body,
    isAdmin: false,
  });
  chatBus.broadcast({ type: "message", message: msg });
  return json({ ok: true, message: msg });
}

// ── Admin route handlers ───────────────────────────────────────────

async function handleAdminPost(req: Request, ip: string): Promise<Response> {
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return error(400, "invalid JSON");
  }
  const { roomSlug: rawSlug, body: rawBody } = (payload ?? {}) as Record<string, unknown>;
  if (typeof rawSlug !== "string" || !getRoom(rawSlug)) {
    return error(400, "bad roomSlug");
  }
  const body = validateBody(rawBody);
  if (!body) return error(400, `invalid body (1-${MAX_BODY_LEN} chars)`);

  const msg = insertMessage({
    id: randomUUID(),
    roomSlug: rawSlug,
    nick: "admin",
    ip,
    body,
    isAdmin: true,
  });
  chatBus.broadcast({ type: "message", message: msg });
  return json({ ok: true, message: msg });
}

function handleAdminDelete(messageId: string): Response {
  const m = getMessage(messageId);
  if (!m) return error(404, "no such message");
  if (m.deleted) return json({ ok: true, alreadyDeleted: true });
  softDeleteMessage(messageId);
  // If the deleted message was pinned, unpin too.
  const room = getRoom(m.roomSlug);
  if (room?.pinnedMessageId === messageId) {
    setRoomPin(m.roomSlug, null);
    chatBus.broadcast({ type: "message_unpinned", roomSlug: m.roomSlug });
  }
  chatBus.broadcast({ type: "message_deleted", roomSlug: m.roomSlug, id: messageId });
  return json({ ok: true });
}

function handleAdminPin(messageId: string): Response {
  const m = getMessage(messageId);
  if (!m || m.deleted) return error(404, "no such message");
  setRoomPin(m.roomSlug, messageId);
  chatBus.broadcast({ type: "message_pinned", roomSlug: m.roomSlug, id: messageId });
  return json({ ok: true });
}

function handleAdminUnpin(roomSlug: string): Response {
  if (!getRoom(roomSlug)) return error(404, "no such room");
  setRoomPin(roomSlug, null);
  chatBus.broadcast({ type: "message_unpinned", roomSlug });
  return json({ ok: true });
}

async function handleAdminBan(req: Request): Promise<Response> {
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return error(400, "invalid JSON");
  }
  const {
    kind: rawKind,
    value: rawValue,
    reason: rawReason,
    purgeMessages: rawPurge,
  } = (payload ?? {}) as Record<string, unknown>;
  if (rawKind !== "nick" && rawKind !== "ip") return error(400, "kind must be 'nick' or 'ip'");
  if (typeof rawValue !== "string" || !rawValue.trim()) return error(400, "value required");
  const kind: BanKind = rawKind;
  const value = kind === "nick" ? rawValue.trim().toLowerCase() : rawValue.trim();
  const reason = typeof rawReason === "string" && rawReason.trim() ? rawReason.trim() : null;
  const purge = rawPurge === true;

  const ban = insertBan(kind, value, reason);

  // Bonus on nick-ban: also ban the IP this nick most recently posted
  // from. Imperfect (CGNAT/VPN) but it's the standard cheap doubling.
  if (kind === "nick") {
    const ip = lastIpForNick(value);
    if (ip) insertBan("ip", ip, reason ? `${reason} (via nick ${value})` : `via nick ${value}`);
  }

  // Optional purge — soft-delete every existing message from this user
  // and broadcast a message_deleted event per row so every connected
  // client renders the "[deleted by admin]" placeholder in real time.
  // We dedupe by id (a nick-ban that escalates to an ip-ban might pick
  // up the same messages twice if the ip-only path also matches them).
  let purged: Array<{ id: string; roomSlug: string }> = [];
  if (purge) {
    const byNick =
      kind === "nick" ? softDeleteMessagesByNick(value) : [];
    const byIp =
      kind === "ip"
        ? softDeleteMessagesByIp(value)
        : kind === "nick"
          ? (() => {
              const ip = lastIpForNick(value);
              return ip ? softDeleteMessagesByIp(ip) : [];
            })()
          : [];
    const seen = new Set<string>();
    purged = [...byNick, ...byIp].filter((r) => {
      if (seen.has(r.id)) return false;
      seen.add(r.id);
      return true;
    });
    for (const r of purged) {
      chatBus.broadcast({
        type: "message_deleted",
        roomSlug: r.roomSlug,
        id: r.id,
      });
    }
  }

  return json({ ok: true, ban, bans: listBans(), purgedCount: purged.length });
}

function handleAdminUnban(banId: number): Response {
  if (!Number.isFinite(banId)) return error(400, "bad ban id");
  const removed = deleteBan(banId);
  if (!removed) return error(404, "no such ban");
  return json({ ok: true, bans: listBans() });
}

function handleAdminListBans(): Response {
  return json({ bans: listBans() });
}

// ── Banned words (admin) ──────────────────────────────────────────

function handleAdminListBannedWords(): Response {
  return json({ words: listBannedWords() });
}

async function handleAdminAddBannedWord(req: Request): Promise<Response> {
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return error(400, "invalid JSON");
  }
  const { word: rawWord } = (payload ?? {}) as Record<string, unknown>;
  if (typeof rawWord !== "string" || !rawWord.trim()) {
    return error(400, "word required");
  }
  if (rawWord.trim().length > 100) {
    return error(400, "word too long (max 100 chars)");
  }
  const added = addBannedWord(rawWord);
  return json({ ok: true, added, words: listBannedWords() });
}

function handleAdminRemoveBannedWord(word: string): Response {
  const removed = removeBannedWord(decodeURIComponent(word));
  if (!removed) return error(404, "no such word");
  return json({ ok: true, words: listBannedWords() });
}

// ── Community kill switch (admin) ─────────────────────────────────

function handleAdminCommunityState(): Response {
  return json({ state: getCommunityState() });
}

async function handleAdminCommunityDisable(req: Request): Promise<Response> {
  let payload: unknown = {};
  try {
    if (req.headers.get("content-type")?.includes("application/json")) {
      payload = await req.json();
    }
  } catch {
    return error(400, "invalid JSON");
  }
  const { reason: rawReason } = (payload ?? {}) as Record<string, unknown>;
  const reason =
    typeof rawReason === "string" && rawReason.trim()
      ? rawReason.trim().slice(0, 200)
      : null;
  const state = setCommunityDisabled(reason);
  // Fan out to every connected subscriber across every room. Clients
  // render an offline overlay immediately; they stay connected so the
  // matching enable event later flips them back without a manual
  // reconnect.
  chatBus.broadcastAll({
    type: "community_state",
    enabled: false,
    reason: state.reason,
  });
  return json({ ok: true, state });
}

function handleAdminCommunityEnable(): Response {
  const state = setCommunityEnabled();
  chatBus.broadcastAll({
    type: "community_state",
    enabled: true,
    reason: null,
  });
  return json({ ok: true, state });
}

// ── Channel management (admin) ────────────────────────────────────

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,30}$/;
const ROOM_NAME_MAX = 80;
const ROOM_DESC_MAX = 200;

async function handleAdminCreateRoom(req: Request): Promise<Response> {
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return error(400, "invalid JSON");
  }
  const { slug: rawSlug, name: rawName, description: rawDesc } =
    (payload ?? {}) as Record<string, unknown>;

  if (typeof rawSlug !== "string" || !SLUG_RE.test(rawSlug.trim())) {
    return error(
      400,
      "slug must match [a-z0-9][a-z0-9_-]{0,30} (lowercase, no spaces)",
    );
  }
  if (typeof rawName !== "string" || !rawName.trim()) {
    return error(400, "name required");
  }
  const slug = rawSlug.trim();
  const name = rawName.trim().slice(0, ROOM_NAME_MAX);
  const description =
    typeof rawDesc === "string" && rawDesc.trim()
      ? rawDesc.trim().slice(0, ROOM_DESC_MAX)
      : null;

  const room = createRoom({ slug, name, description });
  if (!room) return error(409, "a room with that slug already exists");
  // No SSE broadcast here — the per-room streams only fan out to
  // already-subscribed clients. New rooms become visible to peers on
  // their next /rooms refresh (and immediately for the admin via
  // local refreshRooms() in the client hook).
  return json({ ok: true, room });
}

async function handleAdminClearRoom(roomSlug: string): Promise<Response> {
  const room = getRoom(roomSlug);
  if (!room) return error(404, "no such room");
  const removed = clearRoomMessages(roomSlug);
  // Tell every subscriber to drop their local message buffer by
  // emitting an empty replay. Reusing the existing replay event
  // shape means no new client-side reducer branch is needed.
  chatBus.broadcast({
    type: "replay",
    roomSlug,
    messages: [],
    pinnedMessageId: null,
  });
  return json({ ok: true, removed });
}

async function handleAdminCompactRoom(
  roomSlug: string,
  url: URL,
): Promise<Response> {
  const room = getRoom(roomSlug);
  if (!room) return error(404, "no such room");
  const keepRaw = url.searchParams.get("keep");
  const keep = keepRaw === null ? 100 : Number(keepRaw);
  if (!Number.isFinite(keep) || keep < 0 || keep > 10_000) {
    return error(400, "keep must be a number between 0 and 10000");
  }

  const removed = compactRoomMessages(roomSlug, keep);

  // Broadcast the post-trim state. `recentLiveMessages` excludes ALL
  // deletions (including the moderation ones), so the visible chat
  // is exactly the kept N — no placeholders for the compacted tail.
  // The trimmed rows are still in the DB with deletion_reason set
  // to 'compacted' (see clearRoomMessages / compactRoomMessages in
  // db.ts) so an admin can review them out-of-band.
  const fresh = recentLiveMessages(roomSlug, keep);
  let pinnedMessageId = room.pinnedMessageId;
  if (pinnedMessageId && !fresh.some((m) => m.id === pinnedMessageId)) {
    setRoomPin(roomSlug, null);
    pinnedMessageId = null;
  }

  chatBus.broadcast({
    type: "replay",
    roomSlug,
    messages: fresh,
    pinnedMessageId,
  });
  return json({ ok: true, removed, kept: fresh.length });
}

// ── Direct messages (public; same trust model as channel posts) ───
//
// "for" query param is the caller's claimed nick. There's no
// authentication — anyone who knows or guesses a nick can read its
// DMs. That's consistent with the rest of the chat (anyone can post
// as any nick); for a small trusted community it's the right
// trade-off. See chat-server/README.md for the threat model write-up.

function validateDmTo(to: unknown): string | null {
  if (typeof to !== "string") return null;
  const trimmed = to.trim();
  if (!NICK_RE.test(trimmed)) return null;
  if (isReservedNick(trimmed)) return null;
  return trimmed;
}

async function handlePostDm(req: Request, ip: string): Promise<Response> {
  if (isCommunityDisabled()) {
    return error(503, "community is currently disabled by an admin");
  }
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return error(400, "invalid JSON");
  }
  const { from: rawFrom, to: rawTo, body: rawBody } =
    (payload ?? {}) as Record<string, unknown>;

  const from = validateNick(rawFrom);
  if (!from) return error(400, "invalid from nick");
  const to = validateDmTo(rawTo);
  if (!to) return error(400, "invalid to nick");
  if (from.toLowerCase() === to.toLowerCase()) {
    return error(400, "can't DM yourself");
  }
  const body = validateBody(rawBody);
  if (!body) return error(400, `invalid body (1-${MAX_BODY_LEN} chars)`);

  // Bans still apply to DMs — a banned user can't reach others
  // privately either. Banned-words filter does NOT (DMs are private
  // moderation territory, see migration 004 rationale).
  if (isBanned("nick", from.toLowerCase())) return error(403, "nick banned");
  if (isBanned("ip", ip)) return error(403, "ip banned");

  if (!tryConsume(ip)) return error(429, "slow down");

  const msg = insertDm({
    id: randomUUID(),
    fromNick: from,
    fromIp: ip,
    toNick: to,
    body,
  });
  dmBus.broadcastDm(
    { from, to },
    { type: "dm", message: msg },
  );
  return json({ ok: true, message: msg });
}

function handleDmStream(req: Request, url: URL): Response {
  const forNick = url.searchParams.get("for");
  if (!forNick || !NICK_RE.test(forNick) || isReservedNick(forNick)) {
    return error(400, "missing or invalid `for` query param");
  }
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (evt: DMStreamEvent) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(evt)}\n\n`));
        } catch {
          // closed
        }
      };

      const unsubscribe = dmBus.subscribe(forNick, send);

      // 15s heartbeat — keep proxies / Cloudflare happy.
      const hb = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          // closed
        }
      }, 15_000);

      const cleanup = () => {
        clearInterval(hb);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      const signal = req.signal;
      if (signal) {
        if (signal.aborted) cleanup();
        else signal.addEventListener("abort", cleanup, { once: true });
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      ...CORS_HEADERS,
    },
  });
}

function handleDmConversations(url: URL): Response {
  const forNick = url.searchParams.get("for");
  if (!forNick || !NICK_RE.test(forNick) || isReservedNick(forNick)) {
    return error(400, "missing or invalid `for` query param");
  }
  return json({ conversations: listConversationsFor(forNick) });
}

function handleDmConversation(url: URL): Response {
  const forNick = url.searchParams.get("for");
  const peer = url.searchParams.get("with");
  if (!forNick || !NICK_RE.test(forNick) || isReservedNick(forNick)) {
    return error(400, "missing or invalid `for` query param");
  }
  if (!peer || !NICK_RE.test(peer) || isReservedNick(peer)) {
    return error(400, "missing or invalid `with` query param");
  }
  const beforeRaw = url.searchParams.get("before");
  const before = beforeRaw ? Number(beforeRaw) : Date.now();
  if (!Number.isFinite(before)) return error(400, "bad before");
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
  return json({ messages: conversationBefore(forNick, peer, before, limit) });
}

// ── Dispatcher ─────────────────────────────────────────────────────

const server = Bun.serve({
  port: PORT,
  idleTimeout: 0, // SSE streams must stay open
  async fetch(req, srv) {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(req.url);
    const path = url.pathname;
    const ip = getClientIp(req, srv);

    // Quick health probe for fly.io / uptime checks.
    if (path === "/health") return json({ ok: true });

    // ── Public ─────────────────────────────────────────────────────
    if (path === "/rooms" && req.method === "GET") return handleListRooms();

    // /rooms/:slug/stream
    let m = path.match(/^\/rooms\/([^/]+)\/stream$/);
    if (m && req.method === "GET") return handleStream(m[1]!, req);

    // /rooms/:slug/messages — GET (backfill) or POST (send)
    m = path.match(/^\/rooms\/([^/]+)\/messages$/);
    if (m) {
      if (req.method === "GET") return handleBackfill(m[1]!, url);
      if (req.method === "POST") return handlePostMessage(m[1]!, req, ip);
    }

    // ── DMs (public — same trust model as channel posts) ───────────
    if (path === "/dms" && req.method === "POST") return handlePostDm(req, ip);
    if (path === "/dms/stream" && req.method === "GET") {
      return handleDmStream(req, url);
    }
    if (path === "/dms/conversations" && req.method === "GET") {
      return handleDmConversations(url);
    }
    if (path === "/dms/conversation" && req.method === "GET") {
      return handleDmConversation(url);
    }

    // ── Admin (everything below requires the token) ────────────────
    if (path.startsWith("/admin/")) {
      if (!isAdminRequest(req)) return error(401, "admin token required");

      if (path === "/admin/messages" && req.method === "POST") {
        return handleAdminPost(req, ip);
      }
      if (path === "/admin/bans") {
        if (req.method === "GET") return handleAdminListBans();
        if (req.method === "POST") return handleAdminBan(req);
      }
      if (path === "/admin/rooms" && req.method === "POST") {
        return handleAdminCreateRoom(req);
      }
      if (path === "/admin/community/state" && req.method === "GET") {
        return handleAdminCommunityState();
      }
      if (path === "/admin/banned-words") {
        if (req.method === "GET") return handleAdminListBannedWords();
        if (req.method === "POST") return handleAdminAddBannedWord(req);
      }
      m = path.match(/^\/admin\/banned-words\/(.+)$/);
      if (m && req.method === "DELETE") {
        return handleAdminRemoveBannedWord(m[1]!);
      }
      if (path === "/admin/community/disable" && req.method === "POST") {
        return handleAdminCommunityDisable(req);
      }
      if (path === "/admin/community/enable" && req.method === "POST") {
        return handleAdminCommunityEnable();
      }

      m = path.match(/^\/admin\/messages\/([^/]+)\/delete$/);
      if (m && req.method === "POST") return handleAdminDelete(m[1]!);

      m = path.match(/^\/admin\/messages\/([^/]+)\/pin$/);
      if (m && req.method === "POST") return handleAdminPin(m[1]!);

      m = path.match(/^\/admin\/rooms\/([^/]+)\/unpin$/);
      if (m && req.method === "POST") return handleAdminUnpin(m[1]!);

      m = path.match(/^\/admin\/rooms\/([^/]+)\/clear$/);
      if (m && req.method === "POST") return handleAdminClearRoom(m[1]!);

      m = path.match(/^\/admin\/rooms\/([^/]+)\/compact$/);
      if (m && req.method === "POST") return handleAdminCompactRoom(m[1]!, url);

      m = path.match(/^\/admin\/bans\/(\d+)$/);
      if (m && req.method === "DELETE") return handleAdminUnban(Number(m[1]!));
    }

    return error(404, "not found");
  },
});

console.log(`[chat-server] listening on http://localhost:${server.port}`);
