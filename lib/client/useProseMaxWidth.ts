"use client";

import { useEffect, useState } from "react";
import type { ClaudeSettings } from "@/lib/server/settings";
import { proseMaxWidthCss } from "@/lib/client/prose-width";

/**
 * The user-scope `maxProseWidth` cap (CC 2.1.282), resolved to a CSS length
 * for the `--prose-max-width` variable (e.g. `"80ch"`), or `null` when unset
 * (no cap). Read from user scope, matching the sibling setting hooks
 * (`useMaxEffortLevel`, spellcheck, emoji). The caller sets the variable on the
 * chat area so the Markdown prose renderers inherit it; tables and code blocks
 * opt out and keep full width.
 */
export function useProseMaxWidth(cwd: string | null): string | null {
  const [css, setCss] = useState<string | null>(null);

  useEffect(() => {
    if (cwd == null) return;
    const controller = new AbortController();
    fetch(`/api/settings?scope=user&cwd=${encodeURIComponent(cwd)}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) return;
        const data = (await res.json()) as { settings: ClaudeSettings };
        setCss(proseMaxWidthCss(data.settings.maxProseWidth));
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
      });
    return () => controller.abort();
  }, [cwd]);

  return css;
}
