"use client";

import Link from "next/link";
import { Overlay } from "./Overlay";
import type { PlanRateLimits, SessionUsage } from "@/lib/client/types";

type Props = {
  usage: SessionUsage | null;
  model: string | null;
  planUsage?: PlanRateLimits | null;
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

function fmtUtilization(pct: number | null): string {
  if (pct === null) return "—";
  return `${Math.round(pct)}%`;
}

function fmtResetsAt(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return ` · resets ${d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`;
}

function UsageBar({ utilization }: { utilization: number | null }) {
  const pct = utilization ?? 0;
  const color =
    pct >= 90 ? "bg-red-500" : pct >= 70 ? "bg-amber-400" : "bg-emerald-500";
  return (
    <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-[var(--border)]">
      <div
        className={`h-full rounded-full transition-all ${color}`}
        style={{ width: `${Math.min(100, pct)}%` }}
      />
    </div>
  );
}

const WINDOW_LABELS: Record<string, string> = {
  fiveHour: "5-hour",
  sevenDay: "7-day",
  sevenDayOpus: "7-day (Opus)",
  sevenDaySonnet: "7-day (Sonnet)",
  sevenDayOauthApps: "7-day (OAuth apps)",
};

export function CostOverlay({ usage, model, planUsage, onClose }: Props) {
  const windows =
    planUsage?.rateLimitsAvailable && planUsage.rateLimits
      ? (
          Object.entries(planUsage.rateLimits) as [
            string,
            { utilization: number | null; resetsAt: string | null } | null | undefined,
          ][]
        ).filter(([, v]) => v !== null && v !== undefined)
      : [];

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

      {planUsage && (
        <div
          data-testid="plan-usage-section"
          className="border-t border-[var(--border)] px-4 py-3"
        >
          <div className="mb-2 flex items-center gap-2">
            <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--muted)]">
              Plan
            </span>
            {planUsage.subscriptionType ? (
              <span
                data-testid="subscription-type-badge"
                className="rounded border border-[var(--border)] bg-[var(--panel)] px-1.5 py-0.5 font-mono text-[10px] capitalize"
              >
                {planUsage.subscriptionType}
              </span>
            ) : (
              <span
                data-testid="subscription-type-badge"
                className="rounded border border-[var(--border)] bg-[var(--panel)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--muted)]"
              >
                API key
              </span>
            )}
          </div>

          {planUsage.rateLimitsAvailable && windows.length > 0 ? (
            <div className="space-y-2">
              {windows.map(([key, w]) => (
                <div key={key}>
                  <div className="flex items-baseline justify-between text-[11px]">
                    <span className="text-[var(--muted)]">
                      {WINDOW_LABELS[key] ?? key}
                    </span>
                    <span className="font-mono text-[var(--foreground)]">
                      {fmtUtilization(w?.utilization ?? null)}
                      <span className="text-[var(--muted)]">
                        {fmtResetsAt(w?.resetsAt ?? null)}
                      </span>
                    </span>
                  </div>
                  <UsageBar utilization={w?.utilization ?? null} />
                </div>
              ))}
            </div>
          ) : !planUsage.rateLimitsAvailable ? (
            <p
              data-testid="rate-limits-unavailable"
              className="text-[11px] text-[var(--muted)]"
            >
              Plan rate limits not available for this session type.
            </p>
          ) : null}
        </div>
      )}

      <div className="flex items-center gap-2 border-t border-[var(--border)] bg-[var(--panel-2)]/40 px-4 py-2 text-[11px] text-[var(--muted)]">
        <span>
          Model: <span className="font-mono">{model ?? "—"}</span> · numbers accumulate per-turn from SDK result
          messages.
        </span>
        <Link
          href="/cost"
          onClick={onClose}
          className="ml-auto rounded-md border border-[var(--border)] bg-[var(--panel)] px-2 py-0.5 text-[var(--foreground)] hover:bg-[var(--panel-2)]"
        >
          View all cost →
        </Link>
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
