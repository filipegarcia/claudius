"use client";

import { useEffect, useState } from "react";
import type { SdkSlashCommandInfo } from "@/lib/shared/slash-commands";

/**
 * Fetch the SDK's rich slash-command list (name + description + argumentHint
 * + aliases) for a session via `GET /api/sessions/[id]/commands`. Richer than
 * the bare command names in the system:init message, so the picker can show
 * real help text for SDK/plugin-provided commands.
 *
 * Returns `undefined` while loading, on error, or when there's no session —
 * callers fall back to the curated static registry + init names, so the picker
 * always works even if this fetch fails.
 *
 * Staleness is guarded at render (the stored value is tagged with the session
 * it was fetched for) so a session switch never briefly shows another
 * session's commands, and no synchronous setState runs inside the effect.
 */
export function useSdkCommands(sessionId: string | null): SdkSlashCommandInfo[] | undefined {
  const [state, setState] = useState<{
    for: string | null;
    list: SdkSlashCommandInfo[] | undefined;
  }>({ for: null, list: undefined });

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/commands`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { commands?: SdkSlashCommandInfo[] } | null) => {
        if (cancelled) return;
        setState({
          for: sessionId,
          list: d && Array.isArray(d.commands) ? d.commands : undefined,
        });
      })
      .catch(() => {
        if (!cancelled) setState({ for: sessionId, list: undefined });
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // Only surface data fetched for the *current* session id.
  return state.for === sessionId ? state.list : undefined;
}
