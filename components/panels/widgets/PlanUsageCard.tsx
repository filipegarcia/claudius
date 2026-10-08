"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { AlertTriangle, ChevronDown, Gauge, Minus, Timer } from "lucide-react";
import type { PlanRateLimits } from "@/lib/client/types";
import { useCountdownSeconds } from "@/lib/client/use-countdown";
import { useRateLimitWarningPct } from "@/lib/client/useRateLimitWarning";
import {
  collectUsageWindows,
  shortUsageLabel,
  usageTone,
  type RateLimitInfo,
  type UsageTone,
  type UsageWindow,
} from "@/lib/client/usage-windows";
import { OPUS_OVERLOAD_NUDGE_SONNET_TARGET } from "@/components/chat/OpusOverloadNudgePanel";
import { cn } from "@/lib/utils/cn";

type Effort = "low" | "medium" | "high" | "xhigh" | "max" | "auto";

type Props = {
  planUsage?: PlanRateLimits | null;
  /** Latest SDK `rate_limit_event` payload per limit type (the chat pill's data). */
  rateLimitEvents?: readonly RateLimitInfo[];
  model: string | null;
  effort: Effort;
  onChangeModel?: (modelValue: string) => Promise<void> | void;
  onChangeEffort?: (level: Effort) => Promise<void> | void;
  /** Open the full cost & usage overlay. Omit to hide the "Details" link. */
  onOpenDetails?: () => void;
  className?: string;
};

// Same lever set as the chat pill's "Slow your burn" chips (see SystemPill).
const HIGH_EFFORT_LEVELS = new Set<string>(["high", "xhigh", "max"]);

const CARD_TONES: Record<UsageTone, string> = {
  ok: "border-[var(--border)] bg-[var(--panel-2)]/40",
  warning: "border-amber-500/30 bg-amber-500/10 text-amber-200",
  rejected: "border-red-500/30 bg-red-500/10 text-red-200",
};

const BAR_TONES: Record<UsageTone, string> = {
  ok: "bg-emerald-500",
  warning: "bg-amber-400",
  rejected: "bg-red-500",
};

const TONE_RANK: Record<UsageTone, number> = { ok: 0, warning: 1, rejected: 2 };

// Minimized row: hover keeps the tint instead of flattening it to panel grey.
const CARD_HOVER: Record<UsageTone, string> = {
  ok: "hover:bg-[var(--panel-2)]",
  warning: "hover:bg-amber-500/15",
  rejected: "hover:bg-red-500/15",
};

// Per-limit % colour in the minimized row, so a hot limit stands out even
// when the other one is fine.
const PCT_TONES: Record<UsageTone, string> = {
  ok: "",
  warning: "text-amber-300",
  rejected: "text-red-400",
};

// Minimized state persists like the rail's CollapsibleSections — same key
// scheme and same same-tab change event, read via useSyncExternalStore so a
// toggle in another tab propagates and there's no set-state-in-effect.
const COLLAPSED_KEY = "claudius.activity.plan-usage.collapsed";
const CHANGED_EVENT = "claudius.activity.changed";

function subscribeCollapsed(cb: () => void) {
  window.addEventListener("storage", cb);
  window.addEventListener(CHANGED_EVENT, cb);
  return () => {
    window.removeEventListener("storage", cb);
    window.removeEventListener(CHANGED_EVENT, cb);
  };
}

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeCollapsed(next: boolean) {
  try {
    window.localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0");
    window.dispatchEvent(new Event(CHANGED_EVENT));
  } catch {
    // Private mode / quota — the toggle just won't stick.
  }
}

/** "Sun 3:00 AM" — weekly windows reset days out, so the time alone is ambiguous. */
function formatReset(resetsAtSec: number): string {
  return new Date(resetsAtSec * 1000).toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Wall clock for the reset-passed filter, held in state (not read in render)
 * so the card stays pure between ticks — same approach as `useCountdownSeconds`.
 * A minute is plenty: it only decides when a reset window drops off.
 */
function useNowMs(intervalMs: number): number {
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return nowMs;
}

function UsageRow({ window: w, tone }: { window: UsageWindow; tone: UsageTone }) {
  const countdown = useCountdownSeconds(w.resetsAtSec);
  const pct = Math.round(w.pct);
  return (
    <div data-testid="plan-usage-window" data-window={w.key} data-tone={tone}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate">{w.label}</span>
        <span className="shrink-0 font-mono font-medium">
          {w.rejected ? "limit hit" : `${pct}% used`}
        </span>
      </div>
      <div
        className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-[var(--panel)]"
        role="progressbar"
        aria-label={`${w.label} used`}
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={cn("h-full rounded-full transition-all", BAR_TONES[tone])}
          style={{ width: `${Math.min(100, Math.max(2, w.pct))}%` }}
        />
      </div>
      {w.resetsAtSec && (
        <div className="mt-0.5 flex items-center gap-1 opacity-70">
          <Timer className="h-2.5 w-2.5 shrink-0" />
          <span className="truncate">
            resets {formatReset(w.resetsAtSec)}
            {countdown && (
              <>
                {" · "}
                <span className="font-mono">{countdown}</span>
              </>
            )}
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * Plan rate-limit usage for the Activity rail — the always-visible
 * counterpart of the chat's "You've used X% of your Weekly limit" pill.
 * Shows every window the account has (% used, reset time, live countdown),
 * tinting amber at the same threshold that makes the pill appear and red at
 * a hard stop, with the pill's "Slow your burn" levers once it does.
 *
 * Renders nothing when there's no plan data — API-key / Bedrock / Vertex
 * sessions, or a fresh session before its first completed turn.
 */
export function PlanUsageCard({
  planUsage,
  rateLimitEvents = [],
  model,
  effort,
  onChangeModel,
  onChangeEffort,
  onOpenDetails,
  className,
}: Props) {
  const nowMs = useNowMs(60_000);
  const { value: thresholdPct } = useRateLimitWarningPct();
  const collapsed = useSyncExternalStore(subscribeCollapsed, readCollapsed, () => false);
  const windows = collectUsageWindows(planUsage, rateLimitEvents, nowMs);
  if (windows.length === 0) return null;

  const tones = windows.map((w) => usageTone(w, thresholdPct));
  // Worst across ALL windows, minimized or not: a hard stop on a limit the
  // compact row doesn't list must still turn the bar red.
  const worst = tones.reduce<UsageTone>((a, t) => (TONE_RANK[t] > TONE_RANK[a] ? t : a), "ok");
  const isStale = !!planUsage?.stale;

  if (collapsed) {
    // Windows are sorted 5-hour, Weekly, then the rest — so the first two are
    // the two headline limits, falling back to whatever the account has.
    const shown = windows.slice(0, 2);
    const summary = windows
      .map(
        (w) =>
          `${w.label}: ${w.rejected ? "limit hit" : `${Math.round(w.pct)}% used`}` +
          (w.resetsAtSec ? ` · resets ${formatReset(w.resetsAtSec)}` : ""),
      )
      .join("\n");
    return (
      // Margins (`className`) go on the wrapper: on the button itself they'd
      // add to its `w-full` and push it past the rail's edge.
      <div
        data-pane-name="plan-usage"
        data-testid="plan-usage-card"
        data-tone={worst}
        data-collapsed="true"
        className={className}
      >
      <button
        type="button"
        onClick={() => writeCollapsed(false)}
        aria-label="Expand usage"
        title={`${summary}${isStale ? "\n(last known values)" : ""}\n\nClick to expand`}
        // Same box metrics as the Notifications bar below it.
        className={cn(
          "flex w-full items-center gap-1.5 rounded-md border px-2 py-1.5 text-left text-[11px] transition",
          CARD_TONES[worst],
          CARD_HOVER[worst],
        )}
      >
        {worst === "ok" ? (
          <Gauge className="h-3 w-3 shrink-0 opacity-70" />
        ) : (
          <AlertTriangle className="h-3 w-3 shrink-0" />
        )}
        <span className="font-medium">Usage</span>
        <span className={cn("ml-auto flex min-w-0 items-baseline gap-2", isStale && "opacity-60")}>
          {shown.map((w, i) => (
            <span key={w.key} data-testid="plan-usage-mini-window" data-window={w.key} className="flex items-baseline gap-1 whitespace-nowrap">
              <span className="opacity-70">{shortUsageLabel(w)}</span>
              <span className={cn("font-mono font-medium", PCT_TONES[tones[i]])}>
                {w.rejected ? "hit" : `${Math.round(w.pct)}%`}
              </span>
            </span>
          ))}
        </span>
        <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
      </button>
      </div>
    );
  }

  const showSonnet = worst !== "ok" && !!onChangeModel && !!model?.toLowerCase().includes("opus");
  const showEffort = worst !== "ok" && !!onChangeEffort && HIGH_EFFORT_LEVELS.has(effort);
  // A hard stop isn't a threshold problem — only offer the link on a warning.
  const showThreshold = worst === "warning";

  return (
    <div
      data-pane-name="plan-usage"
      data-testid="plan-usage-card"
      data-tone={worst}
      className={cn("rounded-md border px-2 py-1.5 text-[10px] leading-4", CARD_TONES[worst], className)}
    >
      <div className="mb-1 flex items-center gap-1.5">
        {worst === "ok" ? (
          <Gauge className="h-3 w-3 shrink-0 opacity-70" />
        ) : (
          <AlertTriangle className="h-3 w-3 shrink-0" />
        )}
        <span className="font-medium">Usage</span>
        {planUsage?.subscriptionType && (
          <span className="rounded border border-current/20 px-1 text-[9px] capitalize opacity-70">
            {planUsage.subscriptionType}
          </span>
        )}
        <span className="ml-auto flex items-center gap-1.5">
          {isStale && planUsage && (
            <span
              className="opacity-70"
              title="The usage endpoint didn't respond on the last attempt — showing the last known values."
            >
              as of{" "}
              {new Date(planUsage.fetchedAt).toLocaleTimeString(undefined, {
                hour: "numeric",
                minute: "2-digit",
              })}
            </span>
          )}
          {onOpenDetails && (
            <button
              type="button"
              onClick={onOpenDetails}
              className="rounded px-1 opacity-70 hover:bg-current/10 hover:opacity-100"
              title="Open cost & usage details"
            >
              Details
            </button>
          )}
          <button
            type="button"
            onClick={() => writeCollapsed(true)}
            data-testid="plan-usage-minimize"
            aria-label="Minimize usage"
            title="Minimize to one line"
            className="rounded p-0.5 opacity-70 hover:bg-current/10 hover:opacity-100"
          >
            <Minus className="h-3 w-3" />
          </button>
        </span>
      </div>

      <div className={cn("space-y-1.5", isStale && "opacity-60")}>
        {windows.map((w, i) => (
          <UsageRow key={w.key} window={w} tone={tones[i]} />
        ))}
      </div>

      {(showSonnet || showEffort || showThreshold) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1 border-t border-current/10 pt-1.5">
          <span className="opacity-70">Slow your burn:</span>
          {showSonnet && (
            <button
              type="button"
              onClick={() => void onChangeModel!(OPUS_OVERLOAD_NUDGE_SONNET_TARGET)}
              className="rounded border border-current/30 bg-current/10 px-1 font-medium hover:bg-current/20"
              title={`Switch this session to ${OPUS_OVERLOAD_NUDGE_SONNET_TARGET}`}
            >
              /model sonnet
            </button>
          )}
          {showEffort && (
            <button
              type="button"
              onClick={() => void onChangeEffort!("medium")}
              className="rounded border border-current/30 bg-current/10 px-1 font-medium hover:bg-current/20"
              title="Step reasoning effort down to medium"
            >
              /effort medium
            </button>
          )}
          {showThreshold && (
            <Link
              href="/settings#rate-limit-warning"
              className="rounded border border-current/30 bg-current/10 px-1 font-medium hover:bg-current/20"
              title="Change the utilization % at which usage warnings fire"
            >
              change threshold
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
