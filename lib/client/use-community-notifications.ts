"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatEvent, Message, Room } from "@/lib/shared/community";
import { getCommunityServerUrl } from "@/lib/client/community-server-url";
import {
  COMMUNITY_CONSENT_EVENT,
  LS_COMMUNITY_CONSENT_KEY,
  readCommunityConsent,
} from "@/lib/client/use-community-consent";

/**
 * Background subscriber for the community chat. Mirrors the role of
 * `useNotifications` (per-workspace) for the /community surface:
 *
 *   • Holds a global on/off toggle, persisted in localStorage.
 *   • When enabled, opens one EventSource per known room against the
 *     external chat-server. The chat-server stream is per-room, so we fan
 *     out — there's no aggregate stream. Room counts are tiny (a handful)
 *     so this is fine in practice.
 *   • Tracks unread per-room. Each room has its own "last seen" watermark
 *     (epoch ms) persisted as a JSON map. Landing on a room advances *that
 *     room's* watermark only, so other channels keep their unread badge
 *     until the user actually visits them.
 *   • Fires a browser `Notification` for new messages in rooms the user
 *     is not currently viewing.
 *   • Honours existing `Notification.permission`. We never re-prompt
 *     unless the user explicitly toggles ON from the "default" state.
 *
 * State is owned at the hook level; a thin provider wraps the app with a
 * Context so the WorkspaceSwitcher can read the unread badge without each
 * consumer opening its own connections. The community page tells this
 * hook which room it's actively viewing via `setViewingRoom(slug)` — that
 * advances the watermark and silences badges for that one room.
 */

const LS_ENABLED = "claudius.community.notifications.enabled";
const LS_LAST_SEEN_BY_ROOM = "claudius.community.notifications.lastSeenByRoom";
// Older builds wrote a single global watermark to this key. We read it
// once on mount as a migration floor (so users don't get a flood of fake
// unreads on upgrade), then drop the key.
const LS_LEGACY_LAST_SEEN = "claudius.community.notifications.lastSeen";

export type CommunityNotifyState =
  | "default"
  | "granted"
  | "denied"
  | "unsupported";

export type UseCommunityNotifications = {
  /** True iff NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL is set. */
  configured: boolean;
  /** User-facing toggle. */
  enabled: boolean;
  /** Browser permission state. */
  permissionState: CommunityNotifyState;
  /** Sum of unread messages across all rooms. */
  unreadCount: number;
  /** Per-room unread counts; missing entries mean zero. */
  unreadByRoom: Record<string, number>;
  /** Flip the toggle. Returns the resolved enabled state. */
  setEnabled: (next: boolean) => Promise<boolean>;
  /**
   * Set the room the user is actively looking at. `null` when the user
   * is off the community page or has the tab in the background. Setting
   * a slug clears that room's unread + advances its watermark so future
   * messages there don't badge until the user looks away again.
   */
  setViewingRoom: (slug: string | null) => void;
  /**
   * Tell the hook which nick is "us." Messages with this nick never
   * count toward unread — they're our own sends being echoed back over
   * SSE, and badging the user for their own message is nonsense.
   */
  setMyNick: (nick: string | null) => void;
};

export function useCommunityNotificationsState(): UseCommunityNotifications {
  // SSR-safe snapshot, refreshed on mount. Mirrors useCommunity — the
  // extra useEffect-driven re-render is load-bearing on soft-nav into
  // /community; without it the dependent fetch/EventSource effects
  // don't reliably fire.
  const [serverUrl, setServerUrl] = useState<string>(() => getCommunityServerUrl());
  useEffect(() => {
    setServerUrl(getCommunityServerUrl());
  }, []);
  const SERVER_URL = serverUrl;

  // Consent gate. The notifications provider mounts at the layout level
  // and would otherwise keep open SSE connections to the chat-server
  // regardless of whether the user has opted in on /community. Reading
  // the same localStorage key as useCommunityConsent (plus listening for
  // the cross-hook custom event for same-tab updates) keeps the two
  // surfaces in lock-step.
  const [hasConsent, setHasConsent] = useState(false);
  useEffect(() => {
    const read = () => setHasConsent(readCommunityConsent() === "yes");
    read();
    const onStorage = (e: StorageEvent) => {
      if (e.key === LS_COMMUNITY_CONSENT_KEY) read();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener(COMMUNITY_CONSENT_EVENT, read);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(COMMUNITY_CONSENT_EVENT, read);
    };
  }, []);

  // `configured` collapses three concerns: URL is known, the user has
  // opted in to the community at all, and they've toggled notifications
  // on. Treating them as one boolean keeps the gating logic in the SSE
  // fanout effect simple.
  const configured = SERVER_URL.length > 0 && hasConsent;

  // ── Toggle (persisted) ──────────────────────────────────────────────
  const [enabled, setEnabledState] = useState(false);
  const [permissionState, setPermissionState] =
    useState<CommunityNotifyState>("unsupported");

  useEffect(() => {
    try {
      setEnabledState(window.localStorage.getItem(LS_ENABLED) === "1");
    } catch {
      // private mode etc — leave default
    }
    if (typeof window !== "undefined" && "Notification" in window) {
      setPermissionState(Notification.permission as CommunityNotifyState);
    }
  }, []);

  const setEnabled = useCallback(async (next: boolean): Promise<boolean> => {
    if (next && typeof Notification !== "undefined") {
      // Only request permission when toggling ON. Repeated requests get
      // suppressed by the browser anyway, but skipping the call when the
      // permission is already known keeps the prompt UX clean.
      if (Notification.permission === "default") {
        const r = await Notification.requestPermission();
        setPermissionState(r as CommunityNotifyState);
        if (r !== "granted") {
          // Persist intent regardless — the user can grant later.
          try {
            window.localStorage.setItem(LS_ENABLED, "1");
          } catch {}
          setEnabledState(true);
          return true;
        }
      } else {
        setPermissionState(Notification.permission as CommunityNotifyState);
      }
    }
    try {
      window.localStorage.setItem(LS_ENABLED, next ? "1" : "0");
    } catch {}
    setEnabledState(next);
    return next;
  }, []);

  // ── Per-room watermark (persisted) ─────────────────────────────────
  // Map slug → epoch ms. Default for an unknown room is `mountFloor` (see
  // below) so a brand-new install / brand-new room doesn't flood the user
  // with replay-as-unread on first paint.
  const mountFloor = useMemo(() => Date.now(), []);
  const [lastSeenByRoom, setLastSeenByRoomState] = useState<Record<string, number>>({});
  // Legacy single watermark, used as a fallback floor only until each room
  // has its own entry. Read once on mount; the key is then removed.
  const [legacyFloor, setLegacyFloor] = useState<number | null>(null);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(LS_LAST_SEEN_BY_ROOM);
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          // Keep only numeric values — defensively, in case the JSON drifted.
          const cleaned: Record<string, number> = {};
          for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
            if (typeof v === "number" && Number.isFinite(v)) cleaned[k] = v;
          }
          setLastSeenByRoomState(cleaned);
        }
      }
      const legacy = window.localStorage.getItem(LS_LEGACY_LAST_SEEN);
      if (legacy) {
        const n = Number(legacy);
        if (Number.isFinite(n)) setLegacyFloor(n);
        window.localStorage.removeItem(LS_LEGACY_LAST_SEEN);
      }
    } catch {
      // ignore — defaults are fine
    }
  }, []);

  // Refs so the EventSource handlers can read the latest values without
  // re-binding (which would close + reopen every connection).
  const lastSeenByRoomRef = useRef(lastSeenByRoom);
  lastSeenByRoomRef.current = lastSeenByRoom;
  const legacyFloorRef = useRef(legacyFloor);
  legacyFloorRef.current = legacyFloor;

  const watermarkFor = useCallback(
    (slug: string): number => {
      const stored = lastSeenByRoomRef.current[slug];
      if (typeof stored === "number") return stored;
      if (legacyFloorRef.current !== null) return legacyFloorRef.current;
      return mountFloor;
    },
    [mountFloor],
  );

  const advanceWatermark = useCallback((slug: string, ts: number) => {
    setLastSeenByRoomState((prev) => {
      if ((prev[slug] ?? 0) >= ts) return prev;
      const next = { ...prev, [slug]: ts };
      try {
        window.localStorage.setItem(LS_LAST_SEEN_BY_ROOM, JSON.stringify(next));
      } catch {}
      return next;
    });
  }, []);

  // ── Rooms list ─────────────────────────────────────────────────────
  // Refresh on enable so we know which rooms to subscribe to. We refetch
  // every 5 minutes so newly-created rooms get picked up without a full
  // reload — cheap, since rooms is a small JSON list.
  const [rooms, setRooms] = useState<Room[]>([]);
  useEffect(() => {
    if (!configured || !enabled) {
      setRooms([]);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch(`${SERVER_URL}/rooms`);
        if (!r.ok) return;
        const data = (await r.json()) as { rooms: Room[] };
        if (!cancelled) setRooms(data.rooms);
      } catch {
        // Best effort — we'll retry on the next interval / toggle.
      }
    };
    void load();
    const id = setInterval(load, 5 * 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [configured, enabled, SERVER_URL]);

  // ── Unread tracking ────────────────────────────────────────────────
  const [unreadByRoom, setUnreadByRoom] = useState<Record<string, number>>({});

  const setRoomUnread = useCallback(
    (slug: string, updater: (n: number) => number) => {
      setUnreadByRoom((prev) => {
        const cur = prev[slug] ?? 0;
        const next = updater(cur);
        if (next === cur) return prev;
        if (next === 0) {
          const { [slug]: _drop, ...rest } = prev;
          void _drop;
          return rest;
        }
        return { ...prev, [slug]: next };
      });
    },
    [],
  );

  const clearRoomUnread = useCallback((slug: string) => {
    setUnreadByRoom((prev) => {
      if (!(slug in prev)) return prev;
      const { [slug]: _drop, ...rest } = prev;
      void _drop;
      return rest;
    });
  }, []);

  // ── Viewing-room signal ────────────────────────────────────────────
  // Set by the community page so we know which room (if any) to treat as
  // "actively being looked at." State (not just a ref) so the SSE fanout
  // effect below can re-run when it changes — when a room is being
  // viewed, the page already streams it directly, and we *skip* opening
  // a duplicate EventSource here. That saves one HTTP/1.1 slot per visit,
  // which matters because browsers cap concurrent connections at 6 per
  // origin and the chat-server runs plain HTTP/1.1.
  const [viewingRoom, setViewingRoomState] = useState<string | null>(null);
  const viewingRoomRef = useRef<string | null>(null);
  viewingRoomRef.current = viewingRoom;

  const setViewingRoom = useCallback(
    (slug: string | null) => {
      setViewingRoomState(slug);
      if (slug) {
        advanceWatermark(slug, Date.now());
        clearRoomUnread(slug);
      }
    },
    [advanceWatermark, clearRoomUnread],
  );

  // Caller (the community page) tells us which nick is ours. Stored in a
  // ref so the SSE handler reads the current value without re-binding the
  // EventSource fanout. `null` means "we don't know" — in which case no
  // message is treated as our own.
  const myNickRef = useRef<string | null>(null);
  const setMyNick = useCallback((nick: string | null) => {
    myNickRef.current = nick;
  }, []);
  // Seed from localStorage so the provider knows our nick even before the
  // /community page has mounted (e.g. a background tab receiving SSE
  // replays from another device-side send). Matches the key useCommunity
  // writes to.
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem("claudius.community.nick");
      if (stored) myNickRef.current = stored;
    } catch {
      // ignore
    }
  }, []);

  // ── SSE fanout ─────────────────────────────────────────────────────
  const handleNewMessage = useCallback(
    (msg: Message, source: "live" | "replay") => {
      const wm = watermarkFor(msg.roomSlug);
      // Only count messages strictly newer than the per-room watermark.
      // Replay frames resend the recent window on every reconnect — without
      // this guard we'd double-count old messages.
      if (msg.createdAt <= wm) return;

      // Our own message echoed back over SSE — never badge for ourselves.
      // Treat it as seen so a later reconnect/replay doesn't badge it
      // either (the watermark will be ahead of its createdAt).
      if (myNickRef.current && msg.nick === myNickRef.current) {
        advanceWatermark(msg.roomSlug, msg.createdAt);
        return;
      }

      // If the user is actively viewing this room, treat the message as
      // immediately seen: advance the watermark, skip the badge + toast.
      if (viewingRoomRef.current === msg.roomSlug) {
        advanceWatermark(msg.roomSlug, msg.createdAt);
        return;
      }

      // Advance the watermark to this message's time *before* badging.
      // The provider re-opens the room's SSE every time `viewingRoom`
      // changes, and each reopen replays the recent window. Without
      // advancing here, those replays would re-count messages we've
      // already badged — every nav cycle would double the unread count.
      advanceWatermark(msg.roomSlug, msg.createdAt);
      setRoomUnread(msg.roomSlug, (n) => n + 1);

      // OS notification — only for live arrivals. Replay backlogs from a
      // reconnect could fan out dozens of toasts, which is worse than
      // silence; the badge already tells the user they have unread.
      if (source !== "live") return;
      if (
        typeof Notification !== "undefined" &&
        Notification.permission === "granted"
      ) {
        try {
          const n = new Notification(`#${msg.roomSlug} — ${msg.nick}`, {
            body: truncate(msg.body, 140),
            icon: "/icon.svg",
            tag: `community:${msg.id}`,
          });
          n.onclick = () => {
            window.focus();
            n.close();
            window.location.href = "/community";
          };
        } catch {
          // Some browsers throw on tag re-use or quota — swallow.
        }
      }
    },
    [advanceWatermark, setRoomUnread, watermarkFor],
  );

  const handleNewMessageRef = useRef(handleNewMessage);
  handleNewMessageRef.current = handleNewMessage;

  // One EventSource per known room *except* the one the community page
  // is currently rendering — that one is already streamed by useCommunity
  // (on the page), and opening a duplicate burns an HTTP/1.1 slot. With
  // a few rooms + the in-page stream + the workspace notifications
  // stream, the 6-connection per-origin cap is reachable; skipping the
  // viewed room keeps us comfortably under it.
  useEffect(() => {
    if (!configured || !enabled || rooms.length === 0) return;
    const sources: EventSource[] = [];
    for (const room of rooms) {
      if (room.slug === viewingRoom) continue;
      const url = `${SERVER_URL}/rooms/${encodeURIComponent(room.slug)}/stream`;
      const es = new EventSource(url);
      es.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data) as ChatEvent;
          if (data.type === "message") {
            handleNewMessageRef.current(data.message, "live");
          } else if (data.type === "replay") {
            // Backlog from the chat-server's recent window. The watermark
            // guard inside handleNewMessage filters out anything we've
            // already seen.
            for (const msg of data.messages) {
              handleNewMessageRef.current(msg, "replay");
            }
          }
        } catch {
          // ignore malformed
        }
      };
      // No onerror — the browser auto-reconnects EventSource. Surfacing
      // a state would just be noise here.
      sources.push(es);
    }
    return () => {
      for (const es of sources) es.close();
    };
  }, [configured, enabled, rooms, SERVER_URL, viewingRoom]);

  const unreadCount = useMemo(
    () => Object.values(unreadByRoom).reduce((a, b) => a + b, 0),
    [unreadByRoom],
  );

  return useMemo(
    () => ({
      configured,
      enabled,
      permissionState,
      unreadCount,
      unreadByRoom,
      setEnabled,
      setViewingRoom,
      setMyNick,
    }),
    [
      configured,
      enabled,
      permissionState,
      unreadCount,
      unreadByRoom,
      setEnabled,
      setViewingRoom,
      setMyNick,
    ],
  );
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
