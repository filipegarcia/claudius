"use client";

import { Overlay } from "./Overlay";
import type { SessionUsage } from "@/lib/client/types";

type Props = {
  usage: SessionUsage | null;
  model: string | null;
  onClose: () => void;
};

function fmtUsd(n: number): string {
  if (n === 0) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(3)}`;
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${(s % 60).toFixed(0)}s`;
}

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function CostOverlay({ usage, model, onClose }: Props) {
  return (
    <Overlay title="Session cost & usage" subtitle="/cost · /usage · /stats" onClose={onClose} width={520}>
      <div className="grid grid-cols-2 gap-3 px-4 py-4">
        <Stat label="Total cost" value={usage ? fmtUsd(usage.totalCostUsd) : "—"} />
        <Stat label="Turns" value={usage ? String(usage.numTurns) : "—"} />
        <Stat label="API time" value={usage ? fmtMs(usage.durationApiMs) : "—"} />
        <Stat label="Wall time" value={usage ? fmtMs(usage.durationMs) : "—"} />
        <Stat label="Input tokens" value={usage ? fmtTokens(usage.inputTokens) : "—"} />
        <Stat label="Output tokens" value={usage ? fmtTokens(usage.outputTokens) : "—"} />
        <Stat label="Cache read" value={usage ? fmtTokens(usage.cacheReadInputTokens) : "—"} />
        <Stat label="Cache writes" value={usage ? fmtTokens(usage.cacheCreationInputTokens) : "—"} />
      </div>
      <div className="flex items-center gap-2 border-t border-[var(--border)] bg-[var(--panel-2)]/40 px-4 py-2 text-[11px] text-[var(--muted)]">
        <span>
          Model: <span className="font-mono">{model ?? "—"}</span> · numbers accumulate per-turn from SDK result
          messages.
        </span>
        <a
          href="/cost"
          onClick={onClose}
          className="ml-auto rounded-md border border-[var(--border)] bg-[var(--panel)] px-2 py-0.5 text-[var(--foreground)] hover:bg-[var(--panel-2)]"
        >
          View all cost →
        </a>
      </div>
    </Overlay>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-[var(--border)] bg-[var(--panel)]/40 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-[var(--muted)]">{label}</div>
      <div className="mt-0.5 font-mono text-sm">{value}</div>
    </div>
  );
}
