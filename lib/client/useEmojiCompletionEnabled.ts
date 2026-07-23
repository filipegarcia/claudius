"use client";

import { useEffect, useState } from "react";
import type { ClaudeSettings } from "@/lib/server/settings";

/**
 * Whether `:shortcode:` emoji autocomplete is active in the prompt composer,
 * per the user-scope `emojiCompletionEnabled` setting (Claude Code 2.1.217
 * parity: "Added emoji shortcode autocomplete in the prompt input... disable
 * with the `emojiCompletionEnabled` setting").
 *
 * Defaults to `true` (on) until the fetch resolves, matching the setting's
 * documented "absent or true = enabled" contract — same optimistic-default
 * shape as the composer's other on-by-default toggles
 * (`promptSuggestionEnabled`, `sessionRecapEnabled`).
 *
 * User scope only, same reasoning as `useDisableAutoMode`: this is a
 * personal composer preference, not something a project should be able to
 * force on/off for every contributor.
 */
export function useEmojiCompletionEnabled(cwd: string | null): boolean {
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    if (cwd == null) return;
    const controller = new AbortController();
    fetch(`/api/settings?scope=user&cwd=${encodeURIComponent(cwd)}`, {
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) return;
        const data = (await res.json()) as { settings: ClaudeSettings };
        setEnabled(data.settings.emojiCompletionEnabled !== false);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
      });
    return () => controller.abort();
  }, [cwd]);

  return enabled;
}
