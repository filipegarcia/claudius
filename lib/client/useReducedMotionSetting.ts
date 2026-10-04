"use client";

import { useEffect } from "react";
import type { ClaudeSettings } from "@/lib/server/settings";
import { shouldForceReducedMotion } from "@/lib/shared/reduced-motion";

/**
 * CC 2.1.287 (F9) — apply the user-scope `prefersReducedMotion` setting by
 * toggling `data-reduced-motion="1"` on the document element, which the
 * globals.css reduced-motion rules target (alongside the OS
 * `prefers-reduced-motion: reduce` media query, which needs no JS). Read from
 * user scope, matching the sibling setting hooks (`useProseMaxWidth`,
 * `useClockOptions`). No-op until the fetch resolves and whenever the setting
 * is off.
 */
export function useReducedMotionSetting(cwd: string | null): void {
  useEffect(() => {
    if (cwd == null) return;
    const controller = new AbortController();
    fetch(`/api/settings?scope=user&cwd=${encodeURIComponent(cwd)}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) return;
        const data = (await res.json()) as { settings: ClaudeSettings };
        if (shouldForceReducedMotion(data.settings.prefersReducedMotion)) {
          document.documentElement.dataset.reducedMotion = "1";
        } else {
          delete document.documentElement.dataset.reducedMotion;
        }
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
      });
    return () => controller.abort();
  }, [cwd]);
}
