"use client";

import { useEffect, useState } from "react";
import type { ClaudeSettings } from "@/lib/server/settings";

/**
 * The user-scope `maxEffortLevel` cap (CC 2.1.267), used to hide effort tiers
 * above it from the model picker. Undefined when unset (no cap). Read from
 * user scope — the per-model `modelSettings.<model>.maxEffortLevel` override
 * isn't surfaced here (the top-level cap is the common case; the engine still
 * clamps either way).
 */
export function useMaxEffortLevel(cwd: string | null): string | undefined {
  const [cap, setCap] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (cwd == null) return;
    const controller = new AbortController();
    fetch(`/api/settings?scope=user&cwd=${encodeURIComponent(cwd)}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) return;
        const data = (await res.json()) as { settings: ClaudeSettings };
        setCap(data.settings.maxEffortLevel);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
      });
    return () => controller.abort();
  }, [cwd]);

  return cap;
}
