"use client";

import { useEffect, useState } from "react";
import type { ClaudeSettings } from "@/lib/server/settings";

/**
 * Whether the prompt composer underlines misspelled words as you type, per
 * the user-scope `spellcheck` setting (Claude Code 2.1.235 parity: "Added an
 * optional spellcheck setting that underlines misspelled words in the prompt
 * input as you type").
 *
 * Unlike the CLI (which defaults this OFF — a terminal has no native
 * spellcheck), Claudius's composer is a real `<textarea>` that browsers
 * already spellcheck for free. Defaulting to `true` (on) preserves that
 * existing behavior instead of silently regressing it; see `settings.ts` and
 * the 2.1.237 run-notes for the full reasoning.
 *
 * Defaults to `true` until the fetch resolves, matching the setting's
 * "absent or true = enabled" contract — same optimistic-default shape as
 * `useEmojiCompletionEnabled`.
 *
 * User scope only, same reasoning as `useEmojiCompletionEnabled`: a personal
 * composer preference, not something a project should force on/off for
 * every contributor.
 */
export function useSpellcheckEnabled(cwd: string | null): boolean {
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
        setEnabled(data.settings.spellcheck !== false);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
      });
    return () => controller.abort();
  }, [cwd]);

  return enabled;
}
