"use client";

import type { SessionUsage } from "@/lib/client/types";
import { fmtTokens, fmtUsd } from "./format";

export function TokenMeter({ usage }: { usage: SessionUsage | null }) {
  const inT = usage?.inputTokens ?? 0;
  const outT = usage?.outputTokens ?? 0;
  const cacheT = usage?.cacheReadInputTokens ?? 0;
  const cost = usage?.totalCostUsd ?? 0;
  return (
    <div className="mb-3 grid grid-cols-4 gap-1">
      <Tile label="in" value={fmtTokens(inT)} />
      <Tile label="out" value={fmtTokens(outT)} />
      <Tile label="cache" value={fmtTokens(cacheT)} />
      <Tile label="$" value={fmtUsd(cost)} accent />
    </div>
  );
}

function Tile({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div
      className={`rounded-md border px-1.5 py-1 ${
        accent ? "border-[var(--accent)]/30 bg-[var(--accent)]/5" : "border-[var(--border)] bg-[var(--panel-2)]/50"
      }`}
    >
      <div className="text-[8px] uppercase tracking-wide text-[var(--muted)]">{label}</div>
      <div className="font-mono text-[11px] leading-none">{value}</div>
    </div>
  );
}
