"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowDown, ArrowUp } from "lucide-react";
import type { BySession } from "@/lib/server/cost-aggregate";
import { cn } from "@/lib/utils/cn";

type SortKey = "lastSeenMs" | "firstSeenMs" | "numTurns" | "totalUsd";

const COLUMNS: { key: SortKey; label: string; align?: "right" }[] = [
  { key: "lastSeenMs", label: "Last activity" },
  { key: "firstSeenMs", label: "First seen" },
  { key: "numTurns", label: "Turns", align: "right" },
  { key: "totalUsd", label: "Cost", align: "right" },
];

function fmtUsd(n: number): string {
  if (n === 0) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(3)}`;
}

function fmtRel(ms: number): string {
  if (!ms) return "—";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(ms).toLocaleDateString();
}

export function SessionCostTable({ sessions }: { sessions: BySession[] }) {
  const [sortKey, setSortKey] = useState<SortKey>("totalUsd");
  const [dir, setDir] = useState<-1 | 1>(-1);
  const [page, setPage] = useState(0);
  const PAGE = 25;

  const sorted = useMemo(() => {
    const arr = [...sessions];
    arr.sort((a, b) => (a[sortKey] - b[sortKey]) * dir);
    return arr;
  }, [sessions, sortKey, dir]);

  const slice = sorted.slice(page * PAGE, (page + 1) * PAGE);
  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE));

  function toggle(k: SortKey) {
    if (k === sortKey) setDir((d) => (d === 1 ? -1 : 1));
    else {
      setSortKey(k);
      setDir(-1);
    }
  }

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)]/40">
      <div className="overflow-x-auto scroll-thin">
        <table className="w-full text-xs">
          <thead className="border-b border-[var(--border)] text-[10px] uppercase tracking-wide text-[var(--muted)]">
            <tr>
              <th className="px-3 py-1.5 text-left">Session</th>
              <th className="px-3 py-1.5 text-left">Model</th>
              {COLUMNS.map((c) => (
                <th
                  key={c.key}
                  className={cn("cursor-pointer px-3 py-1.5 select-none", c.align === "right" && "text-right")}
                  onClick={() => toggle(c.key)}
                >
                  <span className="inline-flex items-center gap-1">
                    {c.label}
                    {sortKey === c.key &&
                      (dir === 1 ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {slice.map((s) => (
              <tr key={s.sessionId} className="border-b border-[var(--border)] last:border-b-0 hover:bg-[var(--panel-2)]/40">
                <td className="px-3 py-1.5 font-mono">
                  <Link href={`/?session=${s.sessionId}`} className="hover:text-[var(--accent)]">
                    {s.sessionId.slice(0, 8)}
                  </Link>
                </td>
                <td className="px-3 py-1.5 font-mono text-[var(--muted)]">{s.model ?? "—"}</td>
                <td className="px-3 py-1.5">{fmtRel(s.lastSeenMs)}</td>
                <td className="px-3 py-1.5">{fmtRel(s.firstSeenMs)}</td>
                <td className="px-3 py-1.5 text-right font-mono">{s.numTurns}</td>
                <td className="px-3 py-1.5 text-right font-mono">{fmtUsd(s.totalUsd)}</td>
              </tr>
            ))}
            {slice.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-[var(--muted)]">
                  No sessions.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {totalPages > 1 && (
        <div className="flex items-center justify-between border-t border-[var(--border)] bg-[var(--panel-2)]/30 px-3 py-1.5 text-[11px]">
          <span>
            Page {page + 1} / {totalPages} · {sorted.length} sessions
          </span>
          <div className="flex gap-1">
            <button
              disabled={page === 0}
              onClick={() => setPage((p) => p - 1)}
              className="rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-0.5 hover:bg-[var(--panel)] disabled:opacity-40"
            >
              Prev
            </button>
            <button
              disabled={page >= totalPages - 1}
              onClick={() => setPage((p) => p + 1)}
              className="rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-0.5 hover:bg-[var(--panel)] disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
