"use client";

import { useEffect, useRef } from "react";
import type { RefObject } from "react";

import { readBridgeOnClient } from "./useElectron";

/**
 * Whether the user is actively attending to the app window *right now*.
 *
 * "Attending" = the document is visible AND — inside Electron — the window is
 * focused. The focus clause is the load-bearing part: `document.hidden` only
 * flips when the window is minimised or fully occluded, NOT when the user
 * Cmd-Tabs to another app while the Claudius window stays visible on screen.
 * In a regular browser tab that case never arises (switching tabs hides the
 * document), so the focus check is Electron-gated and web behaviour is left
 * byte-for-byte unchanged.
 *
 * Why this matters: the OS-notification suppression gate treats "attending"
 * as "the user is already looking at this session, don't ping the OS." Keying
 * that solely on `document.hidden` meant an Electron user who Cmd-Tabbed away
 * to wait for a turn never got the toast — the window was still "visible," so
 * the gate wrongly suppressed it. Folding window focus in fixes that.
 */
function computeAttending(): boolean {
  if (typeof document === "undefined") return true;
  if (document.hidden) return false;
  // Web tab: visibility is the whole story. Electron: a visible-but-blurred
  // window means the user is looking at another app — treat as not attending.
  return readBridgeOnClient() ? document.hasFocus() : true;
}

/**
 * Tracks "is the user attending to this window" as a ref, suitable for reading
 * inside long-lived event handlers (the SSE stream, the OS-notify callback)
 * that must not re-subscribe on every change.
 *
 * The ref updates on `visibilitychange` and — in Electron — on window
 * `focus`/`blur`. Read `.current` at the point of decision.
 */
export function useAttentionRef(): RefObject<boolean> {
  const ref = useRef<boolean>(computeAttending());

  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    const update = () => {
      ref.current = computeAttending();
    };
    update();
    document.addEventListener("visibilitychange", update);
    // Electron: a visible window can still lose user attention when another
    // app is focused — window-level `focus`/`blur` are the only signals for
    // that, since `document.hidden` won't flip. No-op subscription on web.
    const inElectron = readBridgeOnClient() !== null;
    if (inElectron) {
      window.addEventListener("focus", update);
      window.addEventListener("blur", update);
    }
    return () => {
      document.removeEventListener("visibilitychange", update);
      if (inElectron) {
        window.removeEventListener("focus", update);
        window.removeEventListener("blur", update);
      }
    };
  }, []);

  return ref;
}
