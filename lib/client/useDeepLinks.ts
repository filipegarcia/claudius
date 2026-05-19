"use client";

/**
 * Renderer-side handler for `claudius://` deep links.
 *
 * Phase 8 of docs/electron-conversion/PLAN.md.
 *
 * Subscribes to `bridge.deepLinks.onOpen(url)` and routes the parsed
 * URL via `next/navigation`'s router. Mounted from `app/layout.tsx`
 * so it's active on every route.
 *
 * Supported URL shapes:
 *   claudius://workspace/<wks_xxxxxxxxxxxx>?session=<id>
 *   claudius://session/<id>
 *
 * Unknown shapes are logged + ignored so an experimental URL can't
 * crash the renderer.
 */
import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { useClaudius } from "./useElectron";

const WORKSPACE_ID_RE = /^wks_[a-f0-9]{12}$/;

export function useDeepLinks(): void {
  const bridge = useClaudius();
  const router = useRouter();

  useEffect(() => {
    if (!bridge) return undefined;
    const unsubscribe = bridge.deepLinks.onOpen((rawUrl) => {
      try {
        const url = new URL(rawUrl);
        if (url.protocol !== "claudius:") return;
        const host = url.host;
        const [seg] = url.pathname.replace(/^\/+/, "").split("/");
        const sessionParam = url.searchParams.get("session");

        if (host === "workspace" && seg && WORKSPACE_ID_RE.test(seg)) {
          // Navigate to the workspace chat root; the chat page's
          // session-switching effect picks up the ?session query
          // param.
          const search = sessionParam
            ? `?session=${encodeURIComponent(sessionParam)}`
            : "";
          router.push(`/${seg}${search}`);
          return;
        }

        if (host === "session" && seg) {
          // Bare session id — let middleware resolve the active
          // workspace via cookie.
          router.push(`/?session=${encodeURIComponent(seg)}`);
          return;
        }

        console.warn("[deep-links] unhandled url:", rawUrl);
      } catch (err) {
        console.warn("[deep-links] parse failed:", rawUrl, err);
      }
    });
    return unsubscribe;
  }, [bridge, router]);
}
