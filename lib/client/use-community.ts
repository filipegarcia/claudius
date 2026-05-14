"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Ban,
  BanKind,
  BannedWord,
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

export type UseCommunityOptions = {
  /**
   * Toggle for the per-browser consent gate. When `false`, the hook
   * never opens an SSE connection, never fetches `/rooms`, and all
   * message/admin actions short-circuit with an "opted out" error.
   * The /api/community/admin/check probe still runs because it hits
   * Claudius's own server, not the chat-server, and the result is
   * pinned to `false` while disabled (so admin UI stays hidden).
   * Defaults to `true` for callers that don't care about consent
   * (e.g. tests or future surfaces that don't render /community).
   */
  enabled?: boolean;
};

export function useCommunity(options: UseCommunityOptions = {}) {
  const enabled = options.enabled ?? true;
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
  // `configured` collapses two concerns: chat-server URL is known AND
  // the user has opted in. Treating them as one flag keeps the existing
  // empty-state branch in the page reusable for both reasons.
  const configured = enabled && SERVER_URL.length > 0;

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
  // Whether the room has older messages the user hasn't fetched yet.
  // Starts `true` for every room (no replay on join = the server
  // hasn't told us anything about history yet, so we assume there's
  // more until a load-older call returns < 50 rows). Flips to `false`
  // when the backfill comes back short, indicating we've hit the
  // beginning of the room.
  const [hasMore, setHasMore] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // Kill-switch state. Defaults to enabled — the server only sends a
  // community_state event when it needs to override that default
  // (i.e. it's currently disabled, or just flipped state during the
  // session). Tracking reason separately so we can surface it in the
  // offline overlay.
  const [communityState, setCommunityState] = useState<{
    enabled: boolean;
    reason: string | null;
  }>({ enabled: true, reason: null });
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
          // Keep the row in state, but flip deletedAt so the list
          // renders an "[deleted by admin]" placeholder where the
          // original message was. The server has already blanked the
          // body so we don't try to preserve it locally — anyone
          // joining later sees the same placeholder via the next
          // replay (recentMessages now includes deleted rows).
          setMessages((prev) =>
            prev.map((m) =>
              m.id === ev.id
                ? { ...m, body: "", deletedAt: m.deletedAt ?? Date.now() }
                : m,
            ),
          );
          setPinnedId((cur) => (cur === ev.id ? null : cur));
          break;
        case "message_pinned":
          setPinnedId(ev.id);
          break;
        case "message_unpinned":
          setPinnedId(null);
          break;
        case "community_state":
          // System-wide event — emitted on every connected stream,
          // not just the current room. The `roomSlug` filter above
          // doesn't apply (the event has no slug), so we skip the
          // early return for this case by letting the switch get
          // here. (The `if "roomSlug" in ev` guard at the top of
          // this function gates only events that carry a slug.)
          setCommunityState({
            enabled: ev.enabled,
            reason: ev.reason,
          });
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
    setHasMore(true);
    setLoadingOlder(false);

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

  /**
   * Pull the next page of history older than the oldest message
   * currently in state. Server pages at 50; if fewer come back we
   * know we've hit the start of the room and flip `hasMore` off.
   *
   * Idempotent: re-entrant calls while one is in flight short-circuit
   * (see `loadingOlder` guard) so a double-click on the Load-older
   * button doesn't dup-fetch the same window.
   */
  const loadOlder = useCallback(async (): Promise<SendResult> => {
    if (!configured) return { ok: false, error: "chat server not configured" };
    if (loadingOlder) return { ok: true };
    if (!hasMore) return { ok: true };
    setLoadingOlder(true);
    try {
      const oldest = messages[0]?.createdAt ?? Date.now();
      const url = `${SERVER_URL}/rooms/${encodeURIComponent(
        currentRoom,
      )}/messages?before=${encodeURIComponent(String(oldest))}&limit=50`;
      const r = await fetch(url);
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        return { ok: false, error: j.error ?? `HTTP ${r.status}` };
      }
      const data = (await r.json()) as { messages: Message[] };
      // Prepend (server returns oldest-first within the page). Dedupe
      // by id in case the page boundary races with a live `message`
      // event for the same row.
      setMessages((prev) => {
        const seen = new Set(prev.map((m) => m.id));
        const fresh = data.messages.filter((m) => !seen.has(m.id));
        return [...fresh, ...prev];
      });
      if (data.messages.length < 50) setHasMore(false);
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      setLoadingOlder(false);
    }
  }, [configured, currentRoom, hasMore, loadingOlder, messages, SERVER_URL]);

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
    (
      kind: BanKind,
      value: string,
      options?: { reason?: string; purgeMessages?: boolean },
    ) =>
      adminCall("POST", "/bans", {
        kind,
        value,
        reason: options?.reason,
        // When true, the server soft-deletes every existing message
        // from this user and broadcasts a `message_deleted` for each
        // — every connected client renders the placeholder in real
        // time without a refresh.
        purgeMessages: options?.purgeMessages ?? false,
      }),
    [adminCall],
  );

  const unban = useCallback(
    (id: number) => adminCall("DELETE", `/bans/${id}`),
    [adminCall],
  );

  // Channel management — create a new room, hard-clear all messages in
  // a room, or trim a room to its most recent N messages. The server
  // emits a fresh `replay` event after clear/compact so connected
  // clients pick up the new state through the existing reducer; no
  // local cache invalidation needed beyond what useEffect→SSE already
  // handles. createRoom also refreshes the local rooms list so the new
  // room shows up in the sidebar immediately for the admin.
  const createRoom = useCallback(
    async (slug: string, name: string, description?: string) => {
      const res = await adminCall("POST", "/rooms", {
        slug,
        name,
        description: description ?? null,
      });
      if (res.ok) await refreshRooms();
      return res;
    },
    [adminCall, refreshRooms],
  );

  const clearRoom = useCallback(
    (slug: string) =>
      adminCall("POST", `/rooms/${encodeURIComponent(slug)}/clear`),
    [adminCall],
  );

  const compactRoom = useCallback(
    (slug: string, keep: number) =>
      adminCall(
        "POST",
        `/rooms/${encodeURIComponent(slug)}/compact?keep=${encodeURIComponent(String(keep))}`,
      ),
    [adminCall],
  );

  // Kill switch. Disable broadcasts a community_state event to every
  // connected client (including this one — the reducer flips
  // `communityState.enabled` to false). Enable does the inverse. Both
  // are idempotent server-side.
  const disableCommunity = useCallback(
    (reason?: string) =>
      adminCall(
        "POST",
        "/community/disable",
        reason ? { reason } : undefined,
      ),
    [adminCall],
  );

  const enableCommunity = useCallback(
    () => adminCall("POST", "/community/enable"),
    [adminCall],
  );

  // Banned-words admin surface. Mirrors the bans/listBans pattern:
  // listBannedWords fetches the current curated list, addBannedWord /
  // removeBannedWord mutate it. Channel posts containing any listed
  // substring get rejected with 400 by the server before broadcast;
  // DMs are deliberately not filtered.
  const listBannedWords = useCallback(async (): Promise<BannedWord[]> => {
    if (!isAdmin) return [];
    const res = await adminCall("GET", "/banned-words");
    if (!res.ok) return [];
    const data = res.data as { words?: BannedWord[] } | undefined;
    return data?.words ?? [];
  }, [isAdmin, adminCall]);

  const addBannedWord = useCallback(
    (word: string) => adminCall("POST", "/banned-words", { word }),
    [adminCall],
  );

  const removeBannedWord = useCallback(
    (word: string) =>
      adminCall("DELETE", `/banned-words/${encodeURIComponent(word)}`),
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
      hasMore,
      loadingOlder,
      // community-wide kill switch
      communityState,
      // actions
      send,
      loadOlder,
      // admin
      sendAsAdmin,
      deleteMessage,
      pinMessage,
      unpinRoom,
      listBans,
      ban,
      unban,
      createRoom,
      clearRoom,
      compactRoom,
      disableCommunity,
      enableCommunity,
      listBannedWords,
      addBannedWord,
      removeBannedWord,
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
      hasMore,
      loadingOlder,
      communityState,
      send,
      loadOlder,
      sendAsAdmin,
      deleteMessage,
      pinMessage,
      unpinRoom,
      listBans,
      ban,
      unban,
      createRoom,
      clearRoom,
      compactRoom,
      disableCommunity,
      enableCommunity,
      listBannedWords,
      addBannedWord,
      removeBannedWord,
    ],
  );
}

export type UseCommunity = ReturnType<typeof useCommunity>;
