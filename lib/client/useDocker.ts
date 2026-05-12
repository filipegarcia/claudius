"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Container, DockerResponse } from "@/app/api/docker/containers/route";

/**
 * Polls `/api/docker/containers` on a 5-second cadence and exposes the
 * current state to the /docker page.
 *
 * Cadence rationale: `docker stats --no-stream` samples CPU for ~1s, so we
 * keep the tick at 5s and pause polling when `document.hidden` is true.
 *
 * The initial fetch is scheduled via `setTimeout(_, 0)` so the first
 * `setState` happens off the synchronous render path — matches the pattern
 * the customize/[id]/page.tsx uses to keep the
 * `react-hooks/set-state-in-effect` rule quiet.
 */

const POLL_MS = 5000;

export type DockerState = {
  status: DockerResponse["status"];
  reason?: Extract<DockerResponse, { status: "unavailable" }>["reason"];
  detail?: string;
  containers: Container[];
  loading: boolean;
  error: string | null;
  /** Timestamp of the most recent successful sample (ms since epoch). */
  sampledAt: number | null;
  /** Manual refresh — used by the toolbar button. */
  refresh: () => Promise<void>;
};

export function useDocker(): DockerState {
  const [status, setStatus] = useState<DockerResponse["status"]>("ok");
  const [reason, setReason] = useState<DockerState["reason"]>(undefined);
  const [detail, setDetail] = useState<string | undefined>(undefined);
  const [containers, setContainers] = useState<Container[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sampledAt, setSampledAt] = useState<number | null>(null);
  const aliveRef = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/docker/containers", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as DockerResponse;
      if (!aliveRef.current) return;
      setStatus(body.status);
      setContainers(body.containers);
      if (body.status === "unavailable") {
        setReason(body.reason);
        setDetail(body.detail);
      } else {
        setReason(undefined);
        setDetail(undefined);
        setSampledAt(body.sampledAt);
      }
      setError(null);
    } catch (err) {
      if (!aliveRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    const initial = setTimeout(() => void refresh(), 0);
    const tick = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      void refresh();
    }, POLL_MS);
    return () => {
      aliveRef.current = false;
      clearTimeout(initial);
      clearInterval(tick);
    };
  }, [refresh]);

  return { status, reason, detail, containers, loading, error, sampledAt, refresh };
}
