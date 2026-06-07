"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Per-workspace splash chips + display-name override. Backed by
 * /api/splash-examples (per-cwd `ui_state` rows).
 *
 * Defaults are mirrored from the server so we can render something on
 * the first paint without waiting on the fetch — the API response
 * overwrites this once it lands.
 */

const FALLBACK_DEFAULTS = [
  "Check for security vulnerabilities in the latest git commit",
  "Improve test coverage",
  "Find TODO comments in the codebase",
  "Find performance bottlenecks and suggest fixes",
];

const FALLBACK_LIMITS = { maxLen: 240, maxCount: 12, nameMaxLen: 60 };

type Payload = {
  examples: string[];
  customized: boolean;
  defaults: string[];
  limits: { maxLen: number; maxCount: number; nameMaxLen: number };
  displayName: { override: string | null; fallback: string | null };
};

export type UseSplashExamples = {
  examples: string[];
  /** True after the initial fetch lands so callers can suppress an
   *  empty-state "no chips at all" flash during boot. */
  ready: boolean;
  customized: boolean;
  defaults: string[];
  limits: { maxLen: number; maxCount: number; nameMaxLen: number };
  /** User's typed override (rendered as-is when present). */
  displayNameOverride: string | null;
  /** Account-derived name shown when no override is set. */
  displayNameFallback: string | null;
  /** The string to actually render — override ?? fallback ?? null. */
  displayName: string | null;
  save: (next: { examples?: string[]; displayName?: string | null }) => Promise<void>;
  reset: () => Promise<void>;
  saving: boolean;
};

export function useSplashExamples(activeWorkspaceId: string | null): UseSplashExamples {
  const [examples, setExamples] = useState<string[]>(FALLBACK_DEFAULTS);
  const [defaults, setDefaults] = useState<string[]>(FALLBACK_DEFAULTS);
  const [customized, setCustomized] = useState(false);
  const [limits, setLimits] = useState(FALLBACK_LIMITS);
  const [displayNameOverride, setDisplayNameOverride] = useState<string | null>(null);
  const [displayNameFallback, setDisplayNameFallback] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);

  // "Store previous props in state" so the on-workspace-switch reset runs
  // during render instead of inside an effect — keeps
  // `react-hooks/set-state-in-effect` quiet without losing the behavior.
  // Without this guard, switching workspaces would paint the previous
  // workspace's chips until the new fetch lands.
  const [prevWorkspaceId, setPrevWorkspaceId] = useState(activeWorkspaceId);
  if (prevWorkspaceId !== activeWorkspaceId) {
    setPrevWorkspaceId(activeWorkspaceId);
    setReady(false);
  }

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/splash-examples", { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as Payload;
      })
      .then((d) => {
        if (controller.signal.aborted) return;
        setExamples(Array.isArray(d.examples) ? d.examples : FALLBACK_DEFAULTS);
        setDefaults(Array.isArray(d.defaults) ? d.defaults : FALLBACK_DEFAULTS);
        setCustomized(!!d.customized);
        if (
          d.limits &&
          typeof d.limits.maxLen === "number" &&
          typeof d.limits.maxCount === "number" &&
          typeof d.limits.nameMaxLen === "number"
        ) {
          setLimits({
            maxLen: d.limits.maxLen,
            maxCount: d.limits.maxCount,
            nameMaxLen: d.limits.nameMaxLen,
          });
        }
        setDisplayNameOverride(d.displayName?.override ?? null);
        setDisplayNameFallback(d.displayName?.fallback ?? null);
        setReady(true);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        // Fall back to the built-in defaults silently — the splash screen
        // should still render something useful even if the API is down.
        setReady(true);
      });
    return () => controller.abort();
  }, [activeWorkspaceId]);

  const save = useCallback(
    async (next: { examples?: string[]; displayName?: string | null }) => {
      setSaving(true);
      try {
        const res = await fetch("/api/splash-examples", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(next),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as {
          examples: string[];
          customized: boolean;
          displayName: { override: string | null; fallback: string | null };
        };
        if (Array.isArray(data.examples)) setExamples(data.examples);
        setCustomized(!!data.customized);
        setDisplayNameOverride(data.displayName?.override ?? null);
        setDisplayNameFallback(data.displayName?.fallback ?? null);
      } finally {
        setSaving(false);
      }
    },
    [],
  );

  const reset = useCallback(async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/splash-examples", { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as {
        examples: string[];
        customized: boolean;
        displayName: { override: string | null; fallback: string | null };
      };
      setExamples(Array.isArray(data.examples) ? data.examples : defaults);
      setCustomized(!!data.customized);
      setDisplayNameOverride(data.displayName?.override ?? null);
      setDisplayNameFallback(data.displayName?.fallback ?? null);
    } finally {
      setSaving(false);
    }
  }, [defaults]);

  return {
    examples,
    ready,
    customized,
    defaults,
    limits,
    displayNameOverride,
    displayNameFallback,
    displayName: displayNameOverride ?? displayNameFallback ?? null,
    save,
    reset,
    saving,
  };
}
