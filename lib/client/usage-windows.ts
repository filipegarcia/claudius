import type { PlanRateLimits, SystemEntry } from "@/lib/client/types";

/** One SDK `rate_limit_event` payload, as stored on a `rate_limit` SystemEntry. */
export type RateLimitInfo = NonNullable<SystemEntry["rateLimit"]>;

/**
 * One plan rate-limit window, normalized for display in the Activity rail's
 * usage card.
 *
 * Two sources feed this, in different units:
 *   • `planUsage` (the experimental `get_usage` read after each successful
 *     turn): `utilization` is 0–100, `resetsAt` is an ISO string. It is the
 *     complete snapshot — every window the account has.
 *   • SDK `rate_limit_event`s (the same payloads the inline chat pill shows):
 *     `utilization` is a 0–1 fraction, `resetsAt` is epoch **seconds**. They
 *     only carry the window that tripped, but they're the only source that
 *     says the window is a hard stop (`status: "rejected"`).
 */
export type UsageWindow = {
  /** Stable key: the plan-usage window key, or `model:<displayName>`. */
  key: string;
  /** Matches the chat pill's wording, e.g. "Weekly limit". */
  label: string;
  /** Percentage used, 0–100. Can read above 100 — clamp when drawing a bar. */
  pct: number;
  /** Epoch seconds when the window resets, when known. */
  resetsAtSec?: number;
  /** The SDK reported a hard stop on this window. */
  rejected: boolean;
};

const PLAN_WINDOW_LABELS: Record<string, string> = {
  fiveHour: "5-hour limit",
  sevenDay: "Weekly limit",
  sevenDayOpus: "Weekly Opus limit",
  sevenDaySonnet: "Weekly Sonnet limit",
  sevenDayOauthApps: "Weekly limit (OAuth apps)",
};

/** SDK `rateLimitType` → the matching plan-usage key + pill label. */
const EVENT_WINDOWS: Record<string, { key: string; label: string }> = {
  five_hour: { key: "fiveHour", label: "5-hour limit" },
  seven_day: { key: "sevenDay", label: "Weekly limit" },
  seven_day_opus: { key: "sevenDayOpus", label: "Weekly Opus limit" },
  seven_day_sonnet: { key: "sevenDaySonnet", label: "Weekly Sonnet limit" },
  seven_day_overage_included: { key: "sevenDayOverageIncluded", label: "Weekly limit (overage incl.)" },
  overage: { key: "overage", label: "Extra-usage limit" },
};

/** Display order: the session window, then the weekly ones, then the rest. */
const ORDER = [
  "fiveHour",
  "sevenDay",
  "sevenDayOpus",
  "sevenDaySonnet",
  "sevenDayOverageIncluded",
  "sevenDayOauthApps",
  "overage",
];

function rank(key: string): number {
  const i = ORDER.indexOf(key);
  // Model-scoped (and any future) windows sort after the known ones.
  return i === -1 ? ORDER.length : i;
}

function isoToSec(iso: string | null | undefined): number | undefined {
  if (!iso) return undefined;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000);
}

/**
 * Merge both sources into one list of windows, ordered for display.
 *
 * A window whose reset time has already passed is dropped from *each source
 * before merging*: its utilization belongs to a window that no longer exists
 * (a resumed session can replay rate-limit events from days ago), and letting
 * it merge would carry a stale "rejected" onto the fresh window. The plan
 * snapshot wins on `pct`/`resetsAt` because it's the complete read; a live
 * event only adds the hard-stop flag, or fills a window the snapshot lacks.
 */
export function collectUsageWindows(
  planUsage: PlanRateLimits | null | undefined,
  rateLimitEvents: readonly RateLimitInfo[],
  nowMs: number,
): UsageWindow[] {
  const live = (resetsAtSec: number | undefined) =>
    resetsAtSec === undefined || resetsAtSec * 1000 > nowMs;
  const byKey = new Map<string, UsageWindow>();

  for (const info of rateLimitEvents) {
    const meta = info.rateLimitType ? EVENT_WINDOWS[info.rateLimitType] : undefined;
    if (!meta || !live(info.resetsAt)) continue;
    const rejected = info.status === "rejected";
    // An event without a percentage is only worth a row when it's a hard stop.
    if (typeof info.utilization !== "number" && !rejected) continue;
    byKey.set(meta.key, {
      key: meta.key,
      label: meta.label,
      pct: typeof info.utilization === "number" ? info.utilization * 100 : 100,
      resetsAtSec: info.resetsAt,
      rejected,
    });
  }

  if (planUsage?.rateLimitsAvailable) {
    const planWindows: [string, string, { utilization: number | null; resetsAt: string | null } | null | undefined][] = [
      ...Object.entries(planUsage.rateLimits ?? {}).map(
        ([key, w]) => [key, PLAN_WINDOW_LABELS[key] ?? key, w] as [string, string, typeof w],
      ),
      ...(planUsage.modelScoped ?? []).map(
        (ms) => [`model:${ms.displayName}`, `Weekly ${ms.displayName} limit`, ms] as [string, string, typeof ms],
      ),
    ];
    for (const [key, label, w] of planWindows) {
      if (!w || typeof w.utilization !== "number") continue;
      const resetsAtSec = isoToSec(w.resetsAt);
      if (!live(resetsAtSec)) continue;
      const fromEvent = byKey.get(key);
      byKey.set(key, {
        key,
        label,
        pct: w.utilization,
        resetsAtSec: resetsAtSec ?? fromEvent?.resetsAtSec,
        rejected: fromEvent?.rejected ?? false,
      });
    }
  }

  return [...byKey.values()].sort((a, b) => rank(a.key) - rank(b.key));
}

const SHORT_LABELS: Record<string, string> = {
  fiveHour: "5-hour",
  sevenDay: "Weekly",
  sevenDayOpus: "Opus",
  sevenDaySonnet: "Sonnet",
  sevenDayOauthApps: "OAuth apps",
  sevenDayOverageIncluded: "Weekly+",
  overage: "Extra",
};

/** Compact label for the minimized one-line usage row, e.g. "Weekly". */
export function shortUsageLabel(w: Pick<UsageWindow, "key" | "label">): string {
  if (w.key.startsWith("model:")) return w.key.slice("model:".length);
  return SHORT_LABELS[w.key] ?? w.label;
}

export type UsageTone = "ok" | "warning" | "rejected";

/**
 * Tone for one window. `warning` uses the same user-chosen threshold that
 * gates the inline chat pill (Settings → rate-limit warning), so the rail
 * turns amber exactly when the pill would start showing.
 */
export function usageTone(w: UsageWindow, thresholdPct: number): UsageTone {
  if (w.rejected || w.pct >= 100) return "rejected";
  if (w.pct > 0 && w.pct >= thresholdPct) return "warning";
  return "ok";
}
