"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ConversationSummary,
  DM,
  DMStreamEvent,
} from "@/lib/shared/community";
import { getCommunityServerUrl } from "@/lib/client/community-server-url";
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

export type DMSendResult = { ok: true } | { ok: false; error: string };

export function useDMs() {
  // Same `enabled` plumbing as useCommunity: only open SSE / fetch
  // when the user has consented to the community in this browser.
  const [serverUrl, setServerUrl] = useState<string>(() =>
    getCommunityServerUrl(),
  );
  useEffect(() => {
    setServerUrl(getCommunityServerUrl());
  }, []);

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

  // Nick is mirrored from useCommunity's localStorage key — DMs are
  // identified by nick, so we need it to subscribe to the right SSE
  // stream. Refresh on the `storage` event so a nick change in the
  // chat surface propagates here without a reload.
  const [nick, setNick] = useState<string | null>(null);
  useEffect(() => {
    try {
      setNick(window.localStorage.getItem(LS_NICK));
    } catch {
      // ignore
    }
    const onStorage = (e: StorageEvent) => {
      if (e.key === LS_NICK) {
        try {
          setNick(window.localStorage.getItem(LS_NICK));
        } catch {
          // ignore
        }
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const SERVER_URL = serverUrl;
  const configured = hasConsent && SERVER_URL.length > 0 && !!nick;

  // ── Conversations list ───────────────────────────────────────────
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const refreshConversations = useCallback(async () => {
    if (!configured || !nick) return;
    try {
      const r = await fetch(
        `${SERVER_URL}/dms/conversations?for=${encodeURIComponent(nick)}`,
      );
      if (!r.ok) return;
      const data = (await r.json()) as { conversations: ConversationSummary[] };
      setConversations(data.conversations);
    } catch {
      // best-effort
    }
  }, [configured, nick, SERVER_URL]);

  useEffect(() => {
    if (!configured) {
      setConversations([]);
      return;
    }
    void refreshConversations();
  }, [configured, refreshConversations]);

  // ── Current conversation ─────────────────────────────────────────
  const [currentPeer, setCurrentPeerState] = useState<string | null>(null);
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
      const url =
        `${SERVER_URL}/dms/conversation` +
        `?for=${encodeURIComponent(nick)}` +
        `&with=${encodeURIComponent(currentPeer)}` +
        `&before=${encodeURIComponent(String(oldest))}` +
        `&limit=50`;
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

  useEffect(() => {
    if (!configured || !nick) {
      setConnected(false);
      return;
    }
    setConnected(false);
    const es = new EventSource(
      `${SERVER_URL}/dms/stream?for=${encodeURIComponent(nick)}`,
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
          void refreshConversations();
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
      const r = await fetch(`${SERVER_URL}/dms`, {
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
