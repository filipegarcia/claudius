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

/**
 * Parse a `claudius://...` URL into `{ host, seg, query }`.
 *
 * We avoid `new URL(rawUrl)` because `claudius:` is not in the WHATWG
 * "special scheme" list — under Chromium that means
 * `new URL("claudius://workspace/wks_xxx").host` returns `""` (with
 * everything stashed into `pathname` as `"//workspace/wks_xxx"`),
 * which broke our previous host-based dispatch. A direct regex on the
 * raw string is portable across runtimes and avoids the surprise.
 *
 * Returns `null` if the URL doesn't match the supported shapes.
 */
function parseDeepLink(rawUrl: string): {
  host: "workspace" | "session";
  seg: string;
  sessionParam: string | null;
} | null {
  const m = /^claudius:\/\/(workspace|session)\/([^?#]+)(?:\?([^#]*))?/i.exec(rawUrl);
  if (!m) return null;
  const host = m[1].toLowerCase() as "workspace" | "session";
  const seg = m[2];
  const query = m[3] ?? "";
  let sessionParam: string | null = null;
  if (query) {
    try {
      sessionParam = new URLSearchParams(query).get("session");
    } catch {
      sessionParam = null;
    }
  }
  return { host, seg, sessionParam };
}

export function useDeepLinks(): void {
  const bridge = useClaudius();
  const router = useRouter();

  useEffect(() => {
    if (!bridge) return undefined;
    const unsubscribe = bridge.deepLinks.onOpen((rawUrl) => {
      const parsed = parseDeepLink(rawUrl);
      if (!parsed) {
        console.warn("[deep-links] unhandled url:", rawUrl);
        return;
      }
      const { host, seg, sessionParam } = parsed;

      if (host === "workspace" && WORKSPACE_ID_RE.test(seg)) {
        // Navigate to the workspace chat root; the chat page's
        // session-switching effect picks up the ?session query
        // param.
        const search = sessionParam ? `?session=${encodeURIComponent(sessionParam)}` : "";
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
    });
    return unsubscribe;
  }, [bridge, router]);
}
