"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type {
  Ban,
  BanKind,
  BannedWord,
  ChannelMember,
  ChatEvent,
  Message,
  Room,
} from "@/lib/shared/community";
import { getCommunityServerUrl } from "@/lib/client/community-server-url";
import { withCommunityClientParam } from "@/lib/shared/community-client";
import { mergeReplayMessages } from "@/lib/client/merge-replay-messages";
import {
  getMessagesCache,
  schedulePersist as scheduleCachePersist,
} from "@/lib/client/community-messages-cache";

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
// it up on first read so a stale token doesn't leak the previous trust
// model. Done at module load — runs once per tab regardless of how many
// `useCommunity` instances mount.
const LS_LEGACY_ADMIN_TOKEN = "claudius.community.adminToken";
// Same-tab nick-change broadcast. localStorage's `storage` event only
// fires for OTHER tabs, so we dispatch this when the user changes their
// nick in *this* tab to keep `useSyncExternalStore` re-snapshotting.
const NICK_CHANGED_EVENT = "claudius.community.nick-changed";

if (typeof window !== "undefined") {
  try {
    window.localStorage.removeItem(LS_LEGACY_ADMIN_TOKEN);
  } catch {
    // private mode etc — fall through
  }
}

function readNickSnapshot(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(LS_NICK);
  } catch {
    return null;
  }
}

function subscribeNick(cb: () => void) {
  if (typeof window === "undefined") return () => {};
  const onStorage = (e: StorageEvent) => {
    if (e.key === LS_NICK) cb();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(NICK_CHANGED_EVENT, cb);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(NICK_CHANGED_EVENT, cb);
  };
}

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
  // The chat-server URL is baked into the build (see
  // `getCommunityServerUrl`). The legacy version of this hook went through
  // a useState+useEffect dance to force a re-render on mount; that turned
  // out to be load-bearing only for an old localStorage-override path that
  // no longer exists. The plain function call is fine — SSR returns the
  // build-time default; client mount returns the same value.
  const SERVER_URL = getCommunityServerUrl();
  // `configured` collapses two concerns: chat-server URL is known AND
  // the user has opted in. Treating them as one flag keeps the existing
  // empty-state branch in the page reusable for both reasons.
  const configured = enabled && SERVER_URL.length > 0;

  // ── Identity (persisted) ──────────────────────────────────────────
  // Nick is read from localStorage via `useSyncExternalStore` — same
  // pattern as `useTheme`. SSR snapshot is `null`; client snapshot reads
  // the saved nick on subscribe (so cross-tab nick changes propagate).
  //
  // The canonical store is `~/.claude/settings.json` (`communityNick`).
  // localStorage is a fast-path cache — synchronous first paint, then a
  // GET reconciles. Writes hit both stores so a fresh install on the
  // same `~/.claude/` skips the nickname picker, but the in-tab UI
  // doesn't have to await the round trip.
  const nick = useSyncExternalStore(subscribeNick, readNickSnapshot, () => null);
  // Admin status comes from the server-side proxy probe, not localStorage.
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/community/admin/check", { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : { configured: false }))
      .then((d: { configured?: boolean }) => setIsAdmin(!!d.configured))
      .catch(() => {
        if (!controller.signal.aborted) setIsAdmin(false);
      });
    return () => controller.abort();
  }, []);

  // Hydrate the nickname from user-scope settings on mount. Mirrors
  // the reconciliation in `useCommunityConsent`: server wins ONLY for
  // a fresh device (local cache empty); a same-session pick made while
  // a stale GET is in flight is never clobbered. See the matching
  // comment in `use-community-consent.ts` for the race we're avoiding.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/community/prefs");
        if (!r.ok || cancelled) return;
        const data = (await r.json()) as { nick: string | null };
        const serverNick =
          typeof data.nick === "string" && data.nick.length > 0
            ? data.nick
            : null;
        // Re-read AFTER the await so we see any choice the user made
        // while the GET was in flight.
        const localNick = readNickSnapshot();
        if (cancelled) return;
        if (!localNick && serverNick) {
          // Fresh device — adopt the saved nick. This is what skips
          // the picker on a reinstall.
          try {
            localStorage.setItem(LS_NICK, serverNick);
          } catch {
            // ignore — fast path is best-effort
          }
          window.dispatchEvent(new Event(NICK_CHANGED_EVENT));
        } else if (localNick && !serverNick) {
          // Upgrade path: a nickname picked before this build wasn't
          // persisted to ~/.claude/settings.json. Sync it up.
          try {
            await fetch("/api/community/prefs", {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ nick: localNick }),
            });
          } catch {
            // Best-effort
          }
        }
      } catch {
        // Network errors non-fatal — local cache stands.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setNick = useCallback((next: string) => {
    try {
      localStorage.setItem(LS_NICK, next);
    } catch {
      // ignore
    }
    // `useSyncExternalStore` needs a hint to re-read the snapshot — the
    // native `storage` event only fires for OTHER tabs.
    window.dispatchEvent(new Event(NICK_CHANGED_EVENT));
    // Mirror to user-scope settings so a future install picks it up.
    // Empty string is the "change nickname" reset path (the header
    // button calls `setNick("")` to trigger the picker again); send
    // null to clear the persisted value too.
    const payload = next.length > 0 ? { nick: next } : { nick: null };
    void fetch("/api/community/prefs", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => {
      // Best-effort — local cache holds the in-tab state.
    });
  }, []);

  // ── Rooms ────────────────────────────────────────────────────────
  const [rooms, setRooms] = useState<Room[]>([]);
  const [currentRoom, setCurrentRoom] = useState<string>("general");
  const [roomsError, setRoomsError] = useState<string | null>(null);
  const [roomsRefetchTrigger, setRoomsRefetchTrigger] = useState(0);

  useEffect(() => {
    if (!configured) return;
    const controller = new AbortController();

    fetch(withCommunityClientParam(`${SERVER_URL}/rooms`), {
      signal: controller.signal,
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as { rooms: Room[] };
      })
      .then((data) => {
        setRooms(data.rooms);
        setRoomsError(null);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setRoomsError(err instanceof Error ? err.message : String(err));
      });

    return () => controller.abort();
  }, [configured, SERVER_URL, roomsRefetchTrigger]);

  const refreshRooms = useCallback(() => {
    setRoomsRefetchTrigger((n) => n + 1);
  }, []);

  // ── Stream + messages ────────────────────────────────────────────
  //
  // Per-room cache lives in a module-level singleton (see
  // `getMessagesCache`) so the hook can paint the last-seen state on
  // mount and on room switch without waiting for the SSE replay to
  // land. Each useState below uses a lazy initializer that reads from
  // the cache exactly once for the room the user lands on.
  const [messages, setMessages] = useState<Message[]>(
    () => getMessagesCache()[currentRoom]?.messages ?? [],
  );
  const [pinnedId, setPinnedId] = useState<string | null>(
    () => getMessagesCache()[currentRoom]?.pinnedId ?? null,
  );
  const [connected, setConnected] = useState(false);
  // Whether the room has older messages the user hasn't fetched yet.
  // Starts `true` for a fresh room — the server's join replay carries
  // the most recent window (REPLAY_LIMIT, currently 50) but says
  // nothing about whether older history exists, so we assume there's
  // more until a backfill call returns < 50 rows. Hydrated from the
  // per-room cache when available so a return visit keeps the "load
  // older" button hidden if the user already scrolled to the start.
  const [hasMore, setHasMore] = useState<boolean>(
    () => getMessagesCache()[currentRoom]?.hasMore ?? true,
  );
  const [loadingOlder, setLoadingOlder] = useState(false);
  // Per-room presence — currently-connected nicks for the admin
  // Members sidebar. Populated by polling `/admin/rooms/:slug/presence`
  // in the effect below (admin-only); non-admins never fill this and
  // the Members panel doesn't render for them. We pulled this off the
  // public SSE stream because broadcasting the roster to every
  // connected client (including forked / curl probes) leaked nicks
  // that the admin-only HTTP surface is meant to gate.
  const [members, setMembers] = useState<string[]>([]);
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

  // Reset per-room state when the room changes — what the React 19 docs
  // call the "store previous props in state" pattern. Doing this during
  // render (rather than in the SSE effect's body) is what
  // `react-hooks/set-state-in-effect` wants: the effect now does only
  // setup/teardown of the EventSource, with the reset already applied
  // before the effect runs.
  // https://react.dev/reference/react/useState#storing-information-from-previous-renders
  const [loadedRoom, setLoadedRoom] = useState(currentRoom);
  if (loadedRoom !== currentRoom) {
    // Snapshot the outgoing room into the cache so that returning to
    // it later paints instantly. We use the in-render `messages` /
    // `pinnedId` / `hasMore` values — they're the OLD room's state at
    // this point because the setMessages/setPinnedId calls below queue
    // updates that won't apply until the next render.
    const cache = getMessagesCache();
    cache[loadedRoom] = { messages, pinnedId, hasMore };
    // Hydrate the incoming room from cache (or defaults for a room the
    // user has never visited). The SSE replay will arrive shortly and
    // replace this with the server-authoritative window; until then,
    // the user sees their last-seen view instead of an empty flash.
    const cached = cache[currentRoom];
    setLoadedRoom(currentRoom);
    setMessages(cached?.messages ?? []);
    setPinnedId(cached?.pinnedId ?? null);
    setConnected(false);
    setHasMore(cached?.hasMore ?? true);
    setLoadingOlder(false);
    // Presence is admin-only and per-room. Reset on switch; the
    // admin polling effect below repopulates within the poll
    // interval. Non-admins never fill this — the panel isn't shown
    // for them so the empty value is fine.
    setMembers([]);
  }

  // applyEvent — pure-ish, swallows unknown event tags.
  const applyEvent = useCallback(
    (ev: ChatEvent, slug: string) => {
      // Filter cross-room broadcasts in case we ever multiplex.
      if ("roomSlug" in ev && ev.roomSlug !== slug) return;
      switch (ev.type) {
        case "replay":
          // Additive merge — see `mergeReplayMessages` for the rules.
          // The server emits `replay` on join with the most recent
          // window (REPLAY_LIMIT, currently 50) and again on every
          // EventSource auto-reconnect. Merging means:
          //
          //   • An empty payload (older chat-server that hadn't been
          //     upgraded to send recent context on join) leaves the
          //     local cache intact — no "flash of cached messages
          //     then empty state" when the user returns to a room.
          //   • A `loadOlder` fetch that resolved before this replay
          //     landed isn't clobbered.
          //   • Reconnect after a drop preserves messages that arrived
          //     between the disconnect and the new connection's first
          //     replay frame.
          //
          // Admin clear/compact use the distinct `room_replaced` event
          // below so they still apply as an authoritative replace.
          setMessages((prev) => mergeReplayMessages(prev, ev.messages));
          setPinnedId(ev.pinnedMessageId);
          break;
        case "room_replaced":
          // Authoritative replace from an admin action (clear room or
          // compact room). Blind-replace the local buffer with the
          // server's view — that's the whole reason this is a separate
          // event from `replay`. Also flip `hasMore` to false: after
          // a clear there's nothing older; after a compact the
          // trimmed tail is gone. Without this the "Load older"
          // button would stay visible until the next attempted fetch
          // self-flipped it.
          setMessages(ev.messages);
          setPinnedId(ev.pinnedMessageId);
          setHasMore(false);
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
    // Per-room state was cleared during the previous render (see the
    // `loadedRoom` block above). This effect's only job is to open the
    // EventSource and tear it down on switch.
    //
    // The `?nick=` query param registers this subscriber under the
    // user's claimed nick on the chat-server, so the admin Members
    // roster can surface lurkers (connected but never posted). The
    // chat-server treats it as advisory — invalid / missing nicks are
    // silently ignored, so older chat-servers without nick-aware
    // subscribers keep working with this URL unchanged.
    const nickParam = nick ? `?nick=${encodeURIComponent(nick)}` : "";
    const url = withCommunityClientParam(
      `${SERVER_URL}/rooms/${encodeURIComponent(currentRoom)}/stream${nickParam}`,
    );
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
  }, [configured, currentRoom, nick, applyEvent, SERVER_URL]);

  // Mirror the in-memory cache to localStorage on every meaningful
  // state change. Debouncing lives in `scheduleCachePersist` (module
  // level, shared with the notifications provider) — chatty rooms get
  // batched into one localStorage write per debounce window, and
  // mutations from either hook coordinate through the same timer.
  useEffect(() => {
    const cache = getMessagesCache();
    cache[currentRoom] = { messages, pinnedId, hasMore };
    scheduleCachePersist();
  }, [currentRoom, messages, pinnedId, hasMore]);

  // ── Admin presence polling ──────────────────────────────────────
  //
  // The per-room "who's here" sidebar is admin-only — see the matching
  // server-side note. We poll `/admin/rooms/:slug/presence` every 15s
  // while admin is on this room. Non-admins skip the effect entirely
  // (no HTTP, no state writes). Polling rather than SSE because we
  // want the roster off the public stream and a sub-minute refresh is
  // plenty for the moderation surface.
  useEffect(() => {
    if (!configured || !isAdmin || !currentRoom) return;
    let cancelled = false;
    const fetchPresence = async () => {
      try {
        const res = await fetch(
          `/api/community/admin/rooms/${encodeURIComponent(currentRoom)}/presence`,
        );
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { nicks?: string[] };
        if (cancelled) return;
        if (Array.isArray(data.nicks)) setMembers(data.nicks);
      } catch {
        // Best effort — the next interval will retry.
      }
    };
    void fetchPresence();
    const id = setInterval(fetchPresence, 15_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [configured, isAdmin, currentRoom]);

  // ── Actions ──────────────────────────────────────────────────────

  const send = useCallback(
    async (body: string): Promise<SendResult> => {
      if (!configured) return { ok: false, error: "chat server not configured" };
      if (!nick) return { ok: false, error: "pick a nickname first" };
      const r = await fetch(
        withCommunityClientParam(
          `${SERVER_URL}/rooms/${encodeURIComponent(currentRoom)}/messages`,
        ),
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
      const url = withCommunityClientParam(
        `${SERVER_URL}/rooms/${encodeURIComponent(
          currentRoom,
        )}/messages?before=${encodeURIComponent(String(oldest))}&limit=50`,
      );
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

  // Auto-fire `loadOlder` once per room visit if the SSE join replay
  // didn't land any content. Two cases this safety net covers:
  //
  //   1. The chat-server hasn't been upgraded to send a populated
  //      `replay` on connect — old deployments sent an empty replay
  //      and required a manual "Load older" click. The `/messages`
  //      backfill endpoint has always worked, so we just call it
  //      ourselves and the user sees the recent window with no extra
  //      interaction.
  //   2. Brand-new room with no history — `loadOlder` returns 0,
  //      `hasMore` flips false, and the "empty room" state shows as
  //      designed (no "Load older" button, no infinite retry).
  //
  // Per-room single-shot via `autoBackfilledRoomsRef`: a later admin
  // clear (live or via reload-after-recovery) won't loop back into
  // another backfill that resurrects the cleared content.
  //
  // Threshold is a recent-window size (not "any content") because the
  // shared cache may have just 1–2 messages — anything the
  // notifications provider appended for a room the user hadn't opened
  // yet. A bare "messages.length > 0" gate would then skip the
  // backfill and the user would see those 1–2 messages plus a "Load
  // older" button instead of the recent window they expect.
  const AUTO_BACKFILL_MIN_RECENT = 50;
  const autoBackfilledRoomsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!configured || !connected) return;
    if (autoBackfilledRoomsRef.current.has(currentRoom)) return;
    if (messages.length >= AUTO_BACKFILL_MIN_RECENT || !hasMore) {
      // Cache already covers (or exceeds) the recent window we'd
      // fetch, or the server has nothing older to give — mark this
      // room as handled and stop watching.
      autoBackfilledRoomsRef.current.add(currentRoom);
      return;
    }
    autoBackfilledRoomsRef.current.add(currentRoom);
    // `loadOlder` internally calls setMessages/setHasMore/setLoadingOlder.
    // That's the right thing here — the whole point of this effect is to
    // kick off a fetch whose result updates state — but the React 19
    // lint rule flags any transitive setState-in-effect. The Set guard
    // above prevents cascade re-runs, so this is safe.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadOlder();
  }, [configured, connected, currentRoom, messages.length, hasMore, loadOlder]);

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

  // Channel-members roster (admin-only): distinct posters in a room with
  // last-seen + message count. Mirrors the listBans / listBannedWords
  // shape — returns the unwrapped list directly because callers always
  // want the array, not the SendResult wrapper.
  const listChannelMembers = useCallback(
    async (slug: string): Promise<ChannelMember[]> => {
      if (!isAdmin) return [];
      const res = await adminCall(
        "GET",
        `/rooms/${encodeURIComponent(slug)}/members`,
      );
      if (!res.ok) return [];
      const data = res.data as { members?: ChannelMember[] } | undefined;
      return data?.members ?? [];
    },
    [isAdmin, adminCall],
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
      // IRC-style names list for the current room
      members,
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
      listChannelMembers,
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
      members,
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
      listChannelMembers,
    ],
  );
}

export type UseCommunity = ReturnType<typeof useCommunity>;
