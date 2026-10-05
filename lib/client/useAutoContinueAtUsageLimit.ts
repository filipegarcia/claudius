"use client";

import { useEffect, useState } from "react";
import type { ClaudeSettings } from "@/lib/server/settings";

/**
 * Whether the session should continue automatically once the claude.ai usage
 * limit resets, per the user-scope `autoContinueAtUsageLimit` setting (CC
 * 2.1.234). Off by default (absent/false) — opt-in, matching the SDK.
 *
 * User scope, same reasoning as the other personal toggles: it's a per-user
 * preference, not something a project forces on every contributor.
 */
export function useAutoContinueAtUsageLimit(cwd: string | null): boolean {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    if (cwd == null) return;
    const controller = new AbortController();
    fetch(`/api/settings?scope=user&cwd=${encodeURIComponent(cwd)}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) return;
        const data = (await res.json()) as { settings: ClaudeSettings };
        setEnabled(data.settings.autoContinueAtUsageLimit === true);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
      });
    return () => controller.abort();
  }, [cwd]);

  return enabled;
}
