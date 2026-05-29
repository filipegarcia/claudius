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
      <Tile label="in" value={fmtTokens(inT)} testid="token-tile-in" />
      <Tile label="out" value={fmtTokens(outT)} testid="token-tile-out" />
      <Tile label="cache" value={fmtTokens(cacheT)} testid="token-tile-cache" />
      <Tile label="$" value={fmtUsd(cost)} accent testid="token-tile-cost" />
    </div>
  );
}

function Tile({
  label,
  value,
  accent,
  testid,
}: {
  label: string;
  value: string;
  accent?: boolean;
  testid?: string;
}) {
  return (
    <div
      data-testid={testid}
      className={`rounded-md border px-1.5 py-1 ${
        accent ? "border-[var(--accent)]/30 bg-[var(--accent)]/5" : "border-[var(--border)] bg-[var(--panel-2)]/50"
      }`}
    >
      <div className="text-[8px] uppercase tracking-wide text-[var(--muted)]">{label}</div>
      <div className="font-mono text-[11px] leading-none" data-testid={testid ? `${testid}-value` : undefined}>{value}</div>
    </div>
  );
}
