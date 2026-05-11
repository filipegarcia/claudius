"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Ban,
  BanKind,
  ChatEvent,
  Message,
  Room,
} from "@/lib/shared/community";

/**
 * Hook for the /community page.
 *
 * Mirrors `use-session.ts` in shape — one EventSource per active room,
 * native auto-reconnect, an applyEvent reducer that switches on the
 * server-side event tag. Diff from use-session: no SDK shenanigans, no
 * replay-done plumbing (the chat server's `replay` is the whole
 * authoritative window), no permission/plan/question side-channels.
 *
 * State surface:
 *   - `rooms` / `currentRoom` — room list + active room slug
 *   - `messages` / `pinnedId` — current room's view
 *   - `nick` / `adminToken` — persisted in localStorage
 *   - `connected` — true once SSE handshake completes
 *
 * Action surface:
 *   - send(body)            — POST as the current nick
 *   - sendAsAdmin(slug, b)  — POST /admin/messages
 *   - deleteMessage(id)     — admin
 *   - pinMessage(id)        — admin
 *   - unpinRoom(slug)       — admin
 *   - listBans()            — admin
 *   - banNick / banIp       — admin
 *   - unban(id)             — admin
 */

const SERVER_URL = process.env.NEXT_PUBLIC_CHAT_SERVER_URL ?? "";
const LS_NICK = "claudius.community.nick";
const LS_TOKEN = "claudius.community.adminToken";

export type SendResult = { ok: true } | { ok: false; error: string };

export function useCommunity() {
  const configured = SERVER_URL.length > 0;

  // ── Identity (persisted) ──────────────────────────────────────────
  const [nick, setNickState] = useState<string | null>(null);
  const [adminToken, setAdminTokenState] = useState<string>("");

  // Read from localStorage on mount. Done in an effect so SSR doesn't
  // crash trying to read window.
  useEffect(() => {
    try {
      setNickState(localStorage.getItem(LS_NICK));
      setAdminTokenState(localStorage.getItem(LS_TOKEN) ?? "");
    } catch {
      // private mode etc — fall through with defaults
    }
  }, []);

  const setNick = useCallback((next: string) => {
    setNickState(next);
    try {
      localStorage.setItem(LS_NICK, next);
    } catch {}
  }, []);

  const setAdminToken = useCallback((next: string) => {
    setAdminTokenState(next);
    try {
      if (next) localStorage.setItem(LS_TOKEN, next);
      else localStorage.removeItem(LS_TOKEN);
    } catch {}
  }, []);

  const isAdmin = adminToken.length > 0;

  // ── Rooms ────────────────────────────────────────────────────────
  const [rooms, setRooms] = useState<Room[]>([]);
  const [currentRoom, setCurrentRoom] = useState<string>("general");
  const [roomsError, setRoomsError] = useState<string | null>(null);

  const refreshRooms = useCallback(async () => {
    if (!configured) return;
    try {
      const r = await fetch(`${SERVER_URL}/rooms`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as { rooms: Room[] };
      setRooms(data.rooms);
      setRoomsError(null);
    } catch (err) {
      setRoomsError(err instanceof Error ? err.message : String(err));
    }
  }, [configured]);

  useEffect(() => {
    refreshRooms();
  }, [refreshRooms]);

  // ── Stream + messages ────────────────────────────────────────────
  const [messages, setMessages] = useState<Message[]>([]);
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  // applyEvent — pure-ish, swallows unknown event tags.
  const applyEvent = useCallback(
    (ev: ChatEvent, slug: string) => {
      // Filter cross-room broadcasts in case we ever multiplex.
      if ("roomSlug" in ev && ev.roomSlug !== slug) return;
      switch (ev.type) {
        case "replay":
          setMessages(ev.messages);
          setPinnedId(ev.pinnedMessageId);
          break;
        case "message":
          setMessages((prev) =>
            prev.some((m) => m.id === ev.message.id) ? prev : [...prev, ev.message],
          );
          break;
        case "message_deleted":
          setMessages((prev) => prev.filter((m) => m.id !== ev.id));
          // Also clear pin if it pointed at this message.
          setPinnedId((cur) => (cur === ev.id ? null : cur));
          break;
        case "message_pinned":
          setPinnedId(ev.id);
          break;
        case "message_unpinned":
          setPinnedId(null);
          break;
      }
    },
    [],
  );

  useEffect(() => {
    if (!configured || !currentRoom) return;
    setMessages([]);
    setPinnedId(null);
    setConnected(false);

    const url = `${SERVER_URL}/rooms/${encodeURIComponent(currentRoom)}/stream`;
    const es = new EventSource(url);
    esRef.current = es;

    es.onopen = () => setConnected(true);
    es.onmessage = (msg) => {
      try {
        const ev = JSON.parse(msg.data) as ChatEvent;
        applyEvent(ev, currentRoom);
      } catch {
        // ignore bad frames
      }
    };
    es.onerror = () => {
      // Browser handles reconnect; we just surface the disconnected state.
      setConnected(false);
    };

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [configured, currentRoom, applyEvent]);

  // ── Actions ──────────────────────────────────────────────────────

  const send = useCallback(
    async (body: string): Promise<SendResult> => {
      if (!configured) return { ok: false, error: "chat server not configured" };
      if (!nick) return { ok: false, error: "pick a nickname first" };
      const r = await fetch(
        `${SERVER_URL}/rooms/${encodeURIComponent(currentRoom)}/messages`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ nick, body }),
        },
      );
      if (r.ok) return { ok: true };
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      return { ok: false, error: j.error ?? `HTTP ${r.status}` };
    },
    [configured, currentRoom, nick],
  );

  // ── Admin actions ────────────────────────────────────────────────
  //
  // All routed through one tiny helper. Each returns a SendResult so
  // the admin panel can surface failures.

  const adminCall = useCallback(
    async (
      method: "POST" | "DELETE",
      path: string,
      body?: unknown,
    ): Promise<SendResult & { data?: unknown }> => {
      if (!configured) return { ok: false, error: "chat server not configured" };
      if (!adminToken) return { ok: false, error: "set admin token first" };
      const r = await fetch(`${SERVER_URL}${path}`, {
        method,
        headers: {
          "X-Admin-Token": adminToken,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      if (r.ok) return { ok: true, data: j };
      const err = (j.error as string | undefined) ?? `HTTP ${r.status}`;
      return { ok: false, error: err };
    },
    [configured, adminToken],
  );

  const sendAsAdmin = useCallback(
    (slug: string, body: string) =>
      adminCall("POST", "/admin/messages", { roomSlug: slug, body }),
    [adminCall],
  );

  const deleteMessage = useCallback(
    (id: string) => adminCall("POST", `/admin/messages/${encodeURIComponent(id)}/delete`),
    [adminCall],
  );

  const pinMessage = useCallback(
    (id: string) => adminCall("POST", `/admin/messages/${encodeURIComponent(id)}/pin`),
    [adminCall],
  );

  const unpinRoom = useCallback(
    (slug: string) => adminCall("POST", `/admin/rooms/${encodeURIComponent(slug)}/unpin`),
    [adminCall],
  );

  // GET /admin/bans — the `adminCall` helper above only does POST/DELETE,
  // so we issue this one directly.
  const listBans = useCallback(async (): Promise<Ban[]> => {
    if (!configured || !adminToken) return [];
    const r = await fetch(`${SERVER_URL}/admin/bans`, {
      headers: { "X-Admin-Token": adminToken },
    });
    if (!r.ok) return [];
    const j = (await r.json()) as { bans?: Ban[] };
    return j.bans ?? [];
  }, [configured, adminToken]);

  const ban = useCallback(
    (kind: BanKind, value: string, reason?: string) =>
      adminCall("POST", "/admin/bans", { kind, value, reason }),
    [adminCall],
  );

  const unban = useCallback(
    (id: number) => adminCall("DELETE", `/admin/bans/${id}`),
    [adminCall],
  );

  // ── Public API ───────────────────────────────────────────────────

  return useMemo(
    () => ({
      configured,
      // identity
      nick,
      setNick,
      adminToken,
      setAdminToken,
      isAdmin,
      // rooms
      rooms,
      roomsError,
      refreshRooms,
      currentRoom,
      setCurrentRoom,
      // messages
      messages,
      pinnedId,
      connected,
      // actions
      send,
      // admin
      sendAsAdmin,
      deleteMessage,
      pinMessage,
      unpinRoom,
      listBans,
      ban,
      unban,
    }),
    [
      configured,
      nick,
      setNick,
      adminToken,
      setAdminToken,
      isAdmin,
      rooms,
      roomsError,
      refreshRooms,
      currentRoom,
      messages,
      pinnedId,
      connected,
      send,
      sendAsAdmin,
      deleteMessage,
      pinMessage,
      unpinRoom,
      listBans,
      ban,
      unban,
    ],
  );
}

export type UseCommunity = ReturnType<typeof useCommunity>;
