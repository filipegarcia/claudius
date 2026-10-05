"use client";

import { useEffect, useState } from "react";
import type { ClaudeSettings } from "@/lib/server/settings";
import { resolveClockOptions, type ClockOptions } from "@/lib/shared/time-format";

/**
 * The user-scope `timeFormat` / `timeZone` settings (CC 2.1.257), resolved to
 * the `Intl.DateTimeFormat` overrides Claudius's own clocks apply. Read from
 * user scope, matching the sibling setting hooks (`useMaxEffortLevel`,
 * `useProseMaxWidth`, spellcheck, emoji). Empty until the fetch resolves (and
 * when nothing is set) → the locale-default formatters, i.e. pre-F4 behavior.
 */
export function useClockOptions(cwd: string | null): ClockOptions {
  const [opts, setOpts] = useState<ClockOptions>({});

  useEffect(() => {
    if (cwd == null) return;
    const controller = new AbortController();
    fetch(`/api/settings?scope=user&cwd=${encodeURIComponent(cwd)}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) return;
        const data = (await res.json()) as { settings: ClaudeSettings };
        setOpts(resolveClockOptions(data.settings.timeFormat, data.settings.timeZone));
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
      });
    return () => controller.abort();
  }, [cwd]);

  return opts;
}
