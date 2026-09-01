"use client";

import Link from "next/link";
import { Overlay } from "./Overlay";
import type { PlanRateLimits, SessionUsage } from "@/lib/client/types";
import { computePromptCacheStats } from "@/lib/shared/prompt-cache";

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

function fmtAsOf(epochMs: number): string {
  const d = new Date(epochMs);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
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
  // CC parity 2.1.208: the CLI's `/usage` shows last-known bars with an
  // "as of <time>" note when the usage endpoint is rate-limited, instead of
  // an error screen. Claudius already showed last-known bars on a failed
  // fetch (the server-side catch swallows the error and just doesn't
  // broadcast fresh data), but had no freshness cue at all. `stale` is an
  // explicit signal from the server (a `plan_usage_unavailable` event after
  // a failed fetch attempt) rather than something inferred from elapsed
  // time here — Claude Code turns routinely run past any reasonable
  // wall-clock threshold, so timing out client-side would flag perfectly
  // healthy long-running turns as stale. See `PlanUsageUnavailableEvent` in
  // lib/shared/events.ts for the full rationale.
  const isStale = !!planUsage?.stale;
  const promptCache = usage
    ? computePromptCacheStats({
        inputTokens: usage.inputTokens,
        cacheReadInputTokens: usage.cacheReadInputTokens,
        cacheCreationInputTokens: usage.cacheCreationInputTokens,
      })
    : null;
  const spendLimit = planUsage?.spendLimit ?? null;
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

      {/* CC parity 2.1.251: prompt-cache line ("/cost" hit ratio / misses).
          Derived client-side from the same cache token totals shown in the
          stat grid above (Cache read / Cache writes) — see
          lib/shared/prompt-cache.ts for why there's no new server field
          behind this. Deliberately just the two ratios: the raw token
          counts ("re-cached" == Cache read, cache-write tokens == Cache
          writes) already have a home in the grid above, so repeating them
          here would just be the same numbers twice. Also deliberately no
          warm/cold badge — with only session-cumulative totals available
          (no per-turn breakdown), "warm" would mean "hit cache at least
          once, ever, this session" and stay pinned to true past the first
          hit, which reads as live status but isn't; the hit-ratio % already
          conveys the same information honestly. */}
      {promptCache && (
        <div data-testid="prompt-cache-section" className="border-t border-[var(--border)] px-4 py-3">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--muted)]">
              Prompt cache
            </span>
          </div>
          <div className="grid grid-cols-2 gap-3 text-[11px]">
            <Stat
              label="Hit ratio"
              value={promptCache.hitRatioPct === null ? "—" : `${Math.round(promptCache.hitRatioPct)}%`}
            />
            <Stat
              label="Misses"
              value={promptCache.missRatioPct === null ? "—" : `${Math.round(promptCache.missRatioPct)}%`}
            />
          </div>
        </div>
      )}

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
            {isStale && (
              <span
                data-testid="plan-usage-stale-note"
                title="The usage endpoint didn't respond on the last attempt — showing the last known values."
                className="ml-auto text-[10px] text-[var(--muted)]"
              >
                as of {fmtAsOf(planUsage.fetchedAt)}
              </span>
            )}
          </div>

          {planUsage.rateLimitsAvailable && (windows.length > 0 || (planUsage.modelScoped?.length ?? 0) > 0) ? (
            <div
              data-stale={isStale ? "true" : undefined}
              // Stale: dim the bars so a frozen utilization % stops reading
              // as live, matching how TodosBanner.tsx dims a frozen list.
              className={`space-y-2 ${isStale ? "opacity-60" : ""}`}
            >
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
              {planUsage.modelScoped?.map((ms, i) => (
                <div key={`model_scoped_${i}`} data-testid="model-scoped-window">
                  <div className="flex items-baseline justify-between text-[11px]">
                    <span className="text-[var(--muted)]">
                      7-day ({ms.displayName})
                    </span>
                    <span className="font-mono text-[var(--foreground)]">
                      {fmtUtilization(ms.utilization)}
                      <span className="text-[var(--muted)]">
                        {fmtResetsAt(ms.resetsAt)}
                      </span>
                    </span>
                  </div>
                  <UsageBar utilization={ms.utilization} />
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

          {/* CC parity 2.1.251: gateway-enforced spend limit — separate from
              the percentage windows above (Anthropic-side) AND from
              Claudius's own client-enforced USD caps in the Cost page's
              Limits tab ("Spending limits" panel). Only for developers
              behind a Claude apps gateway with an org-configured spend
              limit; renders nothing when the field isn't present (which is
              always, today — see the doc comment on
              PlanUsageEvent.rateLimits.spendLimit). */}
          {spendLimit && (
            <div data-testid="spend-limit-bar" className="mt-3 border-t border-[var(--border)]/50 pt-3">
              <div className="flex items-baseline justify-between text-[11px]">
                <span className="text-[var(--muted)]">Gateway spend limit</span>
                <span className="font-mono text-[var(--foreground)]">
                  {fmtUsd(spendLimit.usedUsd ?? 0)} / {spendLimit.limitUsd === null ? "—" : fmtUsd(spendLimit.limitUsd)}
                  {spendLimit.currency && spendLimit.currency !== "USD" ? ` ${spendLimit.currency}` : ""}
                </span>
              </div>
              <UsageBar utilization={spendLimit.utilization} />
              <p className="mt-1 text-[10px] text-[var(--muted)]">
                Enforced by your organization&apos;s Claude apps gateway — separate from Anthropic&apos;s own
                rate-limit windows above and from Claudius&apos;s client-side caps under the Cost page&apos;s
                Limits tab.
              </p>
            </div>
          )}
        </div>
      )}

      <div className="flex items-center gap-2 border-t border-[var(--border)] bg-[var(--panel-2)]/40 px-4 py-2 text-[11px] text-[var(--muted)]">
        <span>
          Model: <span className="font-mono">{model ?? "—"}</span> · totals persist across restarts; live turns
          update as estimates until the turn completes.
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
