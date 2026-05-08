"use client";

import type { ByModel } from "@/lib/server/cost-aggregate";

function fmtUsd(n: number): string {
  if (n === 0) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(3)}`;
}

function fmtTok(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function ModelBreakdown({ data }: { data: ByModel[] }) {
  if (data.length === 0) {
    return (
      <div className="rounded-md border border-[var(--border)] bg-[var(--panel)]/40 px-4 py-6 text-center text-sm text-[var(--muted)]">
        No model usage recorded.
      </div>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {data.map((m) => (
        <div key={m.model} className="rounded-lg border border-[var(--border)] bg-[var(--panel)]/40 p-3">
          <div className="flex items-baseline justify-between gap-2">
            <code className="font-mono text-xs">{m.model}</code>
            <span className="font-mono text-sm">{fmtUsd(m.usd)}</span>
          </div>
          <div className="mt-1.5 grid grid-cols-2 gap-1 text-[10px] text-[var(--muted)]">
            <div>
              <span className="opacity-70">in</span>{" "}
              <span className="font-mono">{fmtTok(m.inputTokens)}</span>
            </div>
            <div>
              <span className="opacity-70">out</span>{" "}
              <span className="font-mono">{fmtTok(m.outputTokens)}</span>
            </div>
            <div>
              <span className="opacity-70">cache read</span>{" "}
              <span className="font-mono">{fmtTok(m.cacheReadTokens)}</span>
            </div>
            <div>
              <span className="opacity-70">cache write</span>{" "}
              <span className="font-mono">{fmtTok(m.cacheWriteTokens)}</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
