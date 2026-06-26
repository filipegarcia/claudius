"use client";

import { useState, useEffect, useCallback } from "react";

/** A single permission-denial entry from the session's in-memory ring buffer. */
export type RecentDenial = {
  /** The tool whose use was denied (e.g. "Bash", "Edit"). */
  toolName: string;
  /**
   * The reason code recorded by the SDK (e.g. "auto_deny", "user_denied").
   * Matches the `decision_reason_type` field on the SDK `permission_denied`
   * system message; may fall back to `decision_reason` or "unknown".
   */
  reasonType: string;
  /** Epoch ms when the denial was observed by the server. */
  at: number;
};

/**
 * Fetches the most-recent permission denials for a session from
 * `GET /api/sessions/[id]/denials`. Returns an empty array when the session
 * isn't found or has no recorded denials. Call `refresh()` to poll again.
 *
 * Follows the `useMcp` / `usePermissions` pattern: `useEffect` owns the
 * fetch and only calls setState inside async callbacks; `refresh()` bumps
 * a trigger counter so the effect re-runs.
 */
export function useRecentDenials(sessionId: string | null) {
  const [denials, setDenials] = useState<RecentDenial[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refetchTrigger, setRefetchTrigger] = useState(0);

  useEffect(() => {
    // No session in memory → leave the empty initial state; nothing to fetch.
    if (!sessionId) return;

    const controller = new AbortController();

    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/denials`, {
      signal: controller.signal,
    })
      .then(async (r) => {
        if (!r.ok) {
          if (r.status === 404) {
            // Session no longer in memory — treat as empty, not an error.
            setDenials([]);
            setError(null);
            return;
          }
          throw new Error(`HTTP ${r.status}`);
        }
        const body = (await r.json()) as { denials?: RecentDenial[] };
        setDenials(Array.isArray(body.denials) ? body.denials : []);
        setError(null);
      })
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [sessionId, refetchTrigger]);

  const refresh = useCallback(() => {
    setLoading(true);
    setRefetchTrigger((n) => n + 1);
  }, []);

  return { denials, loading, error, refresh };
}
