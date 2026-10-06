"use client";

import { useEffect, useState } from "react";
import type { ClaudeSettings } from "@/lib/server/settings";

/**
 * Whether chat bubbles always show their time, per the user-scope
 * `showMessageTimestamps` setting (CC 2.1.290 parity: "[VSCode] Changed
 * message timestamps to show by default (turn them off with the Claude Code:
 * Show Message Timestamps setting)"). `false` brings back the hover-only
 * stamps Claudius showed before.
 *
 * Defaults to `true` until the fetch resolves, matching the setting's
 * "absent or true = shown" contract — same optimistic-default shape as
 * `useEmojiCompletionEnabled`. User scope only: a personal display
 * preference, not something a project should force on every contributor.
 */
export function useShowMessageTimestamps(cwd: string | null): boolean {
  const [show, setShow] = useState(true);

  useEffect(() => {
    if (cwd == null) return;
    const controller = new AbortController();
    fetch(`/api/settings?scope=user&cwd=${encodeURIComponent(cwd)}`, {
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) return;
        const data = (await res.json()) as { settings: ClaudeSettings };
        setShow(data.settings.showMessageTimestamps !== false);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
      });
    return () => controller.abort();
  }, [cwd]);

  return show;
}
