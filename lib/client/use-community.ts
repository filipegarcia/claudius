"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Ban,
  BanKind,
  ChatEvent,
  Message,
  Room,
} from "@/lib/shared/community";
import { getCommunityServerUrl } from "@/lib/client/community-server-url";

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
 *   - `nick` — persisted in localStorage
 *   - `isAdmin` — fetched from /api/community/admin/check (server-side
 *     decides based on CLAUDIUS_CHAT_ADMIN_TOKEN). The token never reaches
 *     this hook; admin calls go through /api/community/admin/* which the
 *     server proxies with the header injected.
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

const LS_NICK = "claudius.community.nick";
// Legacy key from when the admin token was pasted into the UI. We clean
// it up on mount so a stale token doesn't leak the previous trust model.
const LS_LEGACY_ADMIN_TOKEN = "claudius.community.adminToken";

export type SendResult = { ok: true } | { ok: false; error: string };

export function useCommunity() {
  // SSR-safe snapshot, refreshed on mount. The legacy version of this
  // hook had a localStorage override here; that's gone now, but keeping
  // the useState+useEffect dance is load-bearing — without the extra
  // re-render on mount, the dependent useEffects (rooms fetch, SSE
  // open) were not consistently triggered on soft-nav into /community.
  const [serverUrl, setServerUrl] = useState<string>(() => getCommunityServerUrl());
  useEffect(() => {
    setServerUrl(getCommunityServerUrl());
  }, []);
  const SERVER_URL = serverUrl;
  const configured = SERVER_URL.length > 0;

  // ── Identity (persisted) ──────────────────────────────────────────
  const [nick, setNickState] = useState<string | null>(null);
  // Admin status comes from the server-side proxy probe, not localStorage.
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    try {
      setNickState(localStorage.getItem(LS_NICK));
      // Drop the legacy admin token if it's still in storage — the new
      // model keeps the token server-side; the browser copy is dead weight
      // and we don't want it lying around.
      localStorage.removeItem(LS_LEGACY_ADMIN_TOKEN);
    } catch {
      // private mode etc — fall through with defaults
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/community/admin/check")
      .then((r) => (r.ok ? r.json() : { configured: false }))
      .then((d: { configured?: boolean }) => {
        if (!cancelled) setIsAdmin(!!d.configured);
      })
      .catch(() => {
        if (!cancelled) setIsAdmin(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setNick = useCallback((next: string) => {
    setNickState(next);
    try {
      localStorage.setItem(LS_NICK, next);
    } catch {}
  }, []);

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
  }, [configured, SERVER_URL]);

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
  }, [configured, currentRoom, applyEvent, SERVER_URL]);

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
    [configured, currentRoom, nick, SERVER_URL],
  );

  // ── Admin actions ────────────────────────────────────────────────
  //
  // Routed through Claudius' /api/community/admin/* proxy. The proxy
  // injects X-Admin-Token from the server env, so the browser never sees
  // it. Each returns a SendResult so callers can surface failures.

  const adminCall = useCallback(
    async (
      method: "GET" | "POST" | "DELETE",
      path: string,
      body?: unknown,
    ): Promise<SendResult & { data?: unknown }> => {
      if (!isAdmin) return { ok: false, error: "not admin on this install" };
      const r = await fetch(`/api/community/admin${path}`, {
        method,
        headers: body !== undefined ? { "Content-Type": "application/json" } : {},
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      if (r.ok) return { ok: true, data: j };
      const err = (j.error as string | undefined) ?? `HTTP ${r.status}`;
      return { ok: false, error: err };
    },
    [isAdmin],
  );

  const sendAsAdmin = useCallback(
    (slug: string, body: string) =>
      adminCall("POST", "/messages", { roomSlug: slug, body }),
    [adminCall],
  );

  const deleteMessage = useCallback(
    (id: string) =>
      adminCall("POST", `/messages/${encodeURIComponent(id)}/delete`),
    [adminCall],
  );

  const pinMessage = useCallback(
    (id: string) => adminCall("POST", `/messages/${encodeURIComponent(id)}/pin`),
    [adminCall],
  );

  const unpinRoom = useCallback(
    (slug: string) =>
      adminCall("POST", `/rooms/${encodeURIComponent(slug)}/unpin`),
    [adminCall],
  );

  const listBans = useCallback(async (): Promise<Ban[]> => {
    if (!isAdmin) return [];
    const res = await adminCall("GET", "/bans");
    if (!res.ok) return [];
    const data = res.data as { bans?: Ban[] } | undefined;
    return data?.bans ?? [];
  }, [isAdmin, adminCall]);

  const ban = useCallback(
    (kind: BanKind, value: string, reason?: string) =>
      adminCall("POST", "/bans", { kind, value, reason }),
    [adminCall],
  );

  const unban = useCallback(
    (id: number) => adminCall("DELETE", `/bans/${id}`),
    [adminCall],
  );

  // ── Public API ───────────────────────────────────────────────────

  return useMemo(
    () => ({
      configured,
      // identity
      nick,
      setNick,
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
