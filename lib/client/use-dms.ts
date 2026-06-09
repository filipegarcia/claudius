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
  ConversationSummary,
  DM,
  DMStreamEvent,
} from "@/lib/shared/community";
import { getCommunityServerUrl } from "@/lib/client/community-server-url";
import { withCommunityClientParam } from "@/lib/shared/community-client";
import {
  COMMUNITY_CONSENT_EVENT,
  LS_COMMUNITY_CONSENT_KEY,
  readCommunityConsent,
} from "@/lib/client/use-community-consent";

/**
 * Hook for direct messages.
 *
 * Lives separately from `useCommunity` because DMs travel on their
 * own per-nick SSE stream (`GET /dms/stream?for=<nick>`) and the
 * caller's "current peer" is a different selection state from the
 * "current room" — folding them would muddy both surfaces.
 *
 * State surface:
 *   - `conversations` — peer list with last-message previews
 *   - `currentPeer` — the conversation the user is actively viewing
 *   - `messages` — DMs for the current peer thread
 *   - `connected` — true once the per-nick SSE handshake completes
 *   - `hasMore` / `loadingOlder` — pagination state for the thread
 *
 * Action surface:
 *   - `setCurrentPeer(peer | null)` — open / close a thread
 *   - `sendDm(to, body)` — POST to /dms
 *   - `loadOlder()` — pull next 50 older DMs in the current thread
 *   - `refreshConversations()` — re-fetch the conversation list
 *
 * Trust model is identical to channels — anyone can claim any nick;
 * the server can't tell whether the `for=alice` caller really is
 * Alice. Acceptable for a small trusted community; documented in
 * chat-server/README.md.
 */

const LS_NICK = "claudius.community.nick";
const NICK_CHANGED_EVENT = "claudius.community.nick-changed";
// Last-opened DM peer nick. Persisted so a return visit to /community
// re-opens the same DM thread the user was last reading. When the
// user closes a DM (or hasn't opened one yet) the key is removed,
// so `currentPeer` falls back to `null` and the channel view shows.
// Local-only — same reasoning as `LS_CURRENT_ROOM` in use-community.
const LS_CURRENT_PEER = "claudius.community.currentPeer";

export type DMSendResult = { ok: true } | { ok: false; error: string };

// ── External-store snapshots ──────────────────────────────────────────

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

function readConsentSnapshot(): boolean {
  return readCommunityConsent() === "yes";
}

function subscribeConsent(cb: () => void) {
  if (typeof window === "undefined") return () => {};
  const onStorage = (e: StorageEvent) => {
    if (e.key === LS_COMMUNITY_CONSENT_KEY) cb();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(COMMUNITY_CONSENT_EVENT, cb);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(COMMUNITY_CONSENT_EVENT, cb);
  };
}

/**
 * Read the last-opened DM peer from localStorage. Returns `null` when
 * the key is missing, empty, or storage is unavailable — that's the
 * "no DM open, show the channel" state. Lazy initializer for the
 * `currentPeer` state; safe on SSR because `<CommunityChat>` only
 * mounts client-side after the consent gate flips.
 */
function readInitialPeer(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = window.localStorage.getItem(LS_CURRENT_PEER);
    return stored && stored.length > 0 ? stored : null;
  } catch {
    return null;
  }
}

export function useDMs() {
  // Build-time chat-server URL. SSR + client read the same value (no
  // localStorage override), so a plain function call is fine.
  const SERVER_URL = getCommunityServerUrl();
  // Cross-tab consent + nick are read via `useSyncExternalStore` — same
  // pattern as `useTheme` / `use-community-consent`. SSR snapshots
  // intentionally return "no consent" / "no nick" so the first frame
  // doesn't open SSE.
  const hasConsent = useSyncExternalStore(subscribeConsent, readConsentSnapshot, () => false);
  const nick = useSyncExternalStore(subscribeNick, readNickSnapshot, () => null);
  const configured = hasConsent && SERVER_URL.length > 0 && !!nick;

  // ── Conversations list ───────────────────────────────────────────
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationsRefetchTrigger, setConversationsRefetchTrigger] = useState(0);

  useEffect(() => {
    if (!configured || !nick) return;
    const controller = new AbortController();

    fetch(
      withCommunityClientParam(
        `${SERVER_URL}/dms/conversations?for=${encodeURIComponent(nick)}`,
      ),
      { signal: controller.signal },
    )
      .then(async (r) => {
        if (!r.ok) return null;
        return (await r.json()) as { conversations: ConversationSummary[] };
      })
      .then((data) => {
        if (data) setConversations(data.conversations);
      })
      .catch(() => {
        // best-effort
      });

    return () => controller.abort();
  }, [configured, nick, SERVER_URL, conversationsRefetchTrigger]);

  const refreshConversations = useCallback(() => {
    setConversationsRefetchTrigger((n) => n + 1);
  }, []);

  // Clear conversations when the user opts out / clears their nick.
  // Stored via "previous props in state" so the reset happens during
  // render rather than in an effect body.
  const [prevConfigured, setPrevConfigured] = useState(configured);
  if (prevConfigured !== configured) {
    setPrevConfigured(configured);
    if (!configured) setConversations([]);
  }

  // ── Current conversation ─────────────────────────────────────────
  // Lazy initializer reads the persisted peer so a return visit drops
  // the user back into the same DM they last had open. A null result
  // (no DM was open, or never opened one) falls through to channel
  // view via `dms.currentPeer ? <DMThread/> : <channel>` in the page.
  const [currentPeer, setCurrentPeerState] = useState<string | null>(
    readInitialPeer,
  );
  const [messages, setMessages] = useState<DM[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);

  const setCurrentPeer = useCallback((peer: string | null) => {
    setCurrentPeerState(peer);
    // Reset thread state on switch — fresh fetch via loadOlder.
    setMessages([]);
    setHasMore(true);
    setLoadingOlder(false);
  }, []);

  // Persist the active peer (or clear the key when null) so a return
  // visit re-opens the same DM. Effect over wrapping the setter
  // catches every mutation site, and `localStorage.setItem` is not
  // setState so this doesn't trip `react-hooks/set-state-in-effect`.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      if (currentPeer && currentPeer.length > 0) {
        window.localStorage.setItem(LS_CURRENT_PEER, currentPeer);
      } else {
        window.localStorage.removeItem(LS_CURRENT_PEER);
      }
    } catch {
      // best-effort — private mode etc.
    }
  }, [currentPeer]);

  /**
   * Pull the next page of conversation history. Uses the existing
   * /dms/conversation backfill endpoint. Pages of 50; flips `hasMore`
   * off when we hit the start of the conversation.
   */
  const loadOlder = useCallback(async (): Promise<DMSendResult> => {
    if (!configured || !nick || !currentPeer) {
      return { ok: false, error: "not configured" };
    }
    if (loadingOlder || !hasMore) return { ok: true };
    setLoadingOlder(true);
    try {
      const oldest = messages[0]?.createdAt ?? Date.now();
      const url = withCommunityClientParam(
        `${SERVER_URL}/dms/conversation` +
          `?for=${encodeURIComponent(nick)}` +
          `&with=${encodeURIComponent(currentPeer)}` +
          `&before=${encodeURIComponent(String(oldest))}` +
          `&limit=50`,
      );
      const r = await fetch(url);
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        return { ok: false, error: j.error ?? `HTTP ${r.status}` };
      }
      const data = (await r.json()) as { messages: DM[] };
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
  }, [
    configured,
    nick,
    currentPeer,
    hasMore,
    loadingOlder,
    messages,
    SERVER_URL,
  ]);

  // Auto-load the first page when the user opens a conversation.
  // Tracked with a ref so re-renders triggered by message arrivals
  // don't re-trigger the fetch.
  const autoLoadedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!currentPeer) {
      autoLoadedFor.current = null;
      return;
    }
    if (autoLoadedFor.current === currentPeer) return;
    autoLoadedFor.current = currentPeer;
    void loadOlder();
  }, [currentPeer, loadOlder]);

  // ── SSE stream ───────────────────────────────────────────────────
  const [connected, setConnected] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  // Reset `connected` to false on any config / nick change — done during
  // render via the "store previous props" pattern so the effect below
  // contains no sync setState in its body.
  // https://react.dev/reference/react/useState#storing-information-from-previous-renders
  const [streamKey, setStreamKey] = useState<string | null>(
    configured && nick ? `${SERVER_URL}|${nick}` : null,
  );
  const nextStreamKey = configured && nick ? `${SERVER_URL}|${nick}` : null;
  if (streamKey !== nextStreamKey) {
    setStreamKey(nextStreamKey);
    setConnected(false);
  }

  useEffect(() => {
    if (!configured || !nick) return;
    const es = new EventSource(
      withCommunityClientParam(
        `${SERVER_URL}/dms/stream?for=${encodeURIComponent(nick)}`,
      ),
    );
    esRef.current = es;
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (msg) => {
      try {
        const ev = JSON.parse(msg.data) as DMStreamEvent;
        if (ev.type === "dm") {
          // Append to the open thread if it matches; always refresh
          // the conversation list (cheap — a single JSON fetch).
          const m = ev.message;
          const peer =
            m.fromNick.toLowerCase() === nick.toLowerCase()
              ? m.toNick
              : m.fromNick;
          if (
            currentPeer &&
            peer.toLowerCase() === currentPeer.toLowerCase()
          ) {
            setMessages((prev) =>
              prev.some((x) => x.id === m.id) ? prev : [...prev, m],
            );
          }
          refreshConversations();
        } else if (ev.type === "dm_deleted") {
          setMessages((prev) =>
            prev.map((x) =>
              x.id === ev.id
                ? { ...x, body: "", deletedAt: x.deletedAt ?? Date.now() }
                : x,
            ),
          );
        }
      } catch {
        // ignore malformed
      }
    };
    return () => {
      es.close();
      esRef.current = null;
    };
  }, [configured, nick, SERVER_URL, currentPeer, refreshConversations]);

  // ── Send ─────────────────────────────────────────────────────────
  const sendDm = useCallback(
    async (to: string, body: string): Promise<DMSendResult> => {
      if (!configured) return { ok: false, error: "chat not configured" };
      if (!nick) return { ok: false, error: "pick a nickname first" };
      const r = await fetch(withCommunityClientParam(`${SERVER_URL}/dms`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: nick, to, body }),
      });
      if (r.ok) return { ok: true };
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      return { ok: false, error: j.error ?? `HTTP ${r.status}` };
    },
    [configured, nick, SERVER_URL],
  );

  return useMemo(
    () => ({
      configured,
      nick,
      conversations,
      refreshConversations,
      currentPeer,
      setCurrentPeer,
      messages,
      hasMore,
      loadingOlder,
      loadOlder,
      connected,
      sendDm,
    }),
    [
      configured,
      nick,
      conversations,
      refreshConversations,
      currentPeer,
      setCurrentPeer,
      messages,
      hasMore,
      loadingOlder,
      loadOlder,
      connected,
      sendDm,
    ],
  );
}

export type UseDMs = ReturnType<typeof useDMs>;
