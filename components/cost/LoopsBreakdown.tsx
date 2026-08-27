"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { LoopBreakdownRow } from "@/lib/server/loop-ticks-db";

function fmtTok(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function fmtRel(ms: number): string {
  if (!ms) return "—";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(ms).toLocaleDateString();
}

/**
 * "Loops" section on the Cost page — Claude Code 2.1.243 parity ("Added a
 * Loops breakdown to /usage: per-loop run count, total tokens, tokens per
 * run, and last run, so runaway or chatty /loop tasks are easy to spot").
 *
 * Grouped by session (one row per session that has armed a dynamic `/loop`
 * wake-up), not by individual loop invocation — see `loop-ticks-db.ts` and
 * the 2.1.245 run-notes for why. Self-fetching (own endpoint,
 * `/api/cost/loops`) rather than folded into `useCost`, since it's backed
 * by a different table (`loop_ticks`, not the JSONL-derived cost cache) and
 * changes on a different cadence.
 */
export function LoopsBreakdown({ cwd }: { cwd: string | null }) {
  const [rows, setRows] = useState<LoopBreakdownRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (cwd == null) return;
    const controller = new AbortController();
    const qs = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
    fetch(`/api/cost/loops${qs}`, { signal: controller.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as { loops: LoopBreakdownRow[] };
      })
      .then((d) => {
        setRows(d.loops);
        setError(null);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => controller.abort();
  }, [cwd]);

  if (error) {
    return (
      <div
        data-testid="loops-breakdown-error"
        className="rounded-md border border-[var(--border)] bg-[var(--panel)]/40 px-4 py-6 text-center text-sm text-red-400"
      >
        {error}
      </div>
    );
  }

  if (rows != null && rows.length === 0) {
    return (
      <div
        data-testid="loops-breakdown-empty"
        className="rounded-md border border-[var(--border)] bg-[var(--panel)]/40 px-4 py-6 text-center text-sm text-[var(--muted)]"
      >
        No dynamic loops (/loop) recorded yet.
      </div>
    );
  }

  return (
    <div
      data-testid="loops-breakdown-table"
      className="rounded-lg border border-[var(--border)] bg-[var(--panel)]/40"
    >
      <div className="overflow-x-auto scroll-thin">
        <table className="w-full text-xs">
          <thead className="border-b border-[var(--border)] text-[10px] uppercase tracking-wide text-[var(--muted)]">
            <tr>
              <th className="px-3 py-1.5 text-left">Session</th>
              <th className="px-3 py-1.5 text-right">Runs</th>
              <th className="px-3 py-1.5 text-right">Total tokens</th>
              <th className="px-3 py-1.5 text-right">Tokens / run</th>
              <th className="px-3 py-1.5 text-left">Last run</th>
            </tr>
          </thead>
          <tbody>
            {(rows ?? []).map((r) => (
              <tr
                key={r.sessionId}
                data-testid="loops-breakdown-row"
                className="border-b border-[var(--border)] last:border-b-0 hover:bg-[var(--panel-2)]/40"
              >
                <td className="px-3 py-1.5">
                  <Link
                    href={`/?session=${r.sessionId}`}
                    className="inline-flex flex-col leading-tight hover:text-[var(--accent)]"
                    title={r.lastPrompt || r.sessionId}
                  >
                    {r.sessionTitle ? (
                      <>
                        <span className="max-w-[220px] truncate">{r.sessionTitle}</span>
                        <span className="font-mono text-[10px] text-[var(--muted)]">
                          {r.sessionId.slice(0, 8)}
                        </span>
                      </>
                    ) : (
                      <span className="font-mono">{r.sessionId.slice(0, 8)}</span>
                    )}
                  </Link>
                </td>
                <td className="px-3 py-1.5 text-right font-mono">{r.runCount}</td>
                <td className="px-3 py-1.5 text-right font-mono">{fmtTok(r.totalTokens)}</td>
                <td className="px-3 py-1.5 text-right font-mono">{fmtTok(r.tokensPerRun)}</td>
                <td className="px-3 py-1.5">{fmtRel(r.lastRun)}</td>
              </tr>
            ))}
            {rows == null && (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-[var(--muted)]">
                  Loading…
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
