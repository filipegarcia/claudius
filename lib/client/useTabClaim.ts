"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Per-tab session-claim coordination via BroadcastChannel.
 *
 * Protocol on channel `claudius.sessions`:
 *   { kind: "claim",   id, tab }   — broadcast on bind; ask other tabs to confirm if they hold this session.
 *   { kind: "held",    id, tab }   — sent by the holder in response to a claim.
 *   { kind: "evict",   id }        — broadcast by a tab that wants to take over.
 *   { kind: "release", id }        — broadcast on unload by the holder.
 *
 * Behavior:
 *   - On bind, post claim + start a 250 ms grace window. If no `held` arrives, become holder.
 *   - If a `held` arrives during the window → become read-only.
 *   - As holder: respond to `claim` with `held`; on `evict` for our session, demote.
 *   - As read-only: on `release`, re-attempt the claim.
 */
export function useTabClaim(sessionId: string | null): {
  readOnly: boolean;
  takeOver: () => void;
} {
  const [readOnly, setReadOnly] = useState(false);
  const channelRef = useRef<BroadcastChannel | null>(null);
  // Per-tab id pinned at first render. `useState` with a lazy initializer
  // gives us a stable value without triggering the ref-during-render rule
  // and without calling the impure `Math.random()` in the component body.
  // The setter is unused — this is "lazy const" not state.
  const [tabId] = useState(() => "tab-" + Math.random().toString(36).slice(2, 10));
  const heldRef = useRef(false);
  const claimTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const post = useCallback((msg: Record<string, unknown>) => {
    channelRef.current?.postMessage(msg);
  }, []);

  const becomeHolder = useCallback(() => {
    heldRef.current = true;
    setReadOnly(false);
  }, []);

  const demote = useCallback(() => {
    heldRef.current = false;
    setReadOnly(true);
  }, []);

  const tryClaim = useCallback(
    (id: string) => {
      heldRef.current = false;
      // Start the claim sequence: broadcast and wait 250ms for a `held` reply.
      post({ kind: "claim", id, tab: tabId });
      if (claimTimerRef.current) clearTimeout(claimTimerRef.current);
      claimTimerRef.current = setTimeout(() => {
        if (!heldRef.current) becomeHolder();
      }, 250);
    },
    [post, becomeHolder],
  );

  // Set up channel + per-session claim sequence.
  useEffect(() => {
    if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") return;
    if (!sessionId) {
      heldRef.current = false;
      setReadOnly(false);
      return;
    }
    const ch = new BroadcastChannel("claudius.sessions");
    channelRef.current = ch;
    ch.onmessage = (ev) => {
      const m = ev.data as { kind?: string; id?: string; tab?: string } | null;
      if (!m || m.id !== sessionId) return;
      if (m.kind === "claim" && heldRef.current && m.tab !== tabId) {
        // Someone else is asking; assert ownership.
        post({ kind: "held", id: sessionId, tab: tabId });
        return;
      }
      if (m.kind === "held" && m.tab !== tabId) {
        // Another tab claims this session — go read-only.
        if (claimTimerRef.current) {
          clearTimeout(claimTimerRef.current);
          claimTimerRef.current = null;
        }
        demote();
        return;
      }
      if (m.kind === "evict" && heldRef.current) {
        // We were the holder; the new tab took over.
        demote();
        return;
      }
      if (m.kind === "release" && !heldRef.current) {
        // The holder just left; try to claim.
        tryClaim(sessionId);
        return;
      }
    };

    tryClaim(sessionId);

    const onUnload = () => {
      if (heldRef.current) post({ kind: "release", id: sessionId });
    };
    window.addEventListener("pagehide", onUnload);
    window.addEventListener("beforeunload", onUnload);

    return () => {
      window.removeEventListener("pagehide", onUnload);
      window.removeEventListener("beforeunload", onUnload);
      onUnload();
      if (claimTimerRef.current) {
        clearTimeout(claimTimerRef.current);
        claimTimerRef.current = null;
      }
      ch.close();
      channelRef.current = null;
      heldRef.current = false;
    };
  }, [sessionId, post, demote, tryClaim]);

  const takeOver = useCallback(() => {
    if (!sessionId) return;
    // Tell the current holder to step down, then re-claim.
    post({ kind: "evict", id: sessionId });
    // Small delay so the prior holder demotes before we assert.
    setTimeout(() => tryClaim(sessionId), 50);
  }, [sessionId, post, tryClaim]);

  return { readOnly, takeOver };
}
