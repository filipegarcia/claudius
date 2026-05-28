"use client";

import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Cpu,
  GitMerge,
  Info,
  ShieldAlert,
  Timer,
  Webhook,
} from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import type { SystemEntry } from "@/lib/client/types";
import {
  shouldShowRateLimitPill,
  useRateLimitWarningPct,
} from "@/lib/client/useRateLimitWarning";

const KIND_META: Record<SystemEntry["kind"], { icon: typeof Info; tone: string }> = {
  init: { icon: Cpu, tone: "text-emerald-400" },
  hook_started: { icon: Webhook, tone: "text-sky-400" },
  hook_response: { icon: CheckCircle2, tone: "text-sky-400" },
  status: { icon: Clock, tone: "text-amber-400" },
  compact_boundary: { icon: GitMerge, tone: "text-violet-400" },
  rate_limit: { icon: AlertTriangle, tone: "text-amber-400" },
  api_retry: { icon: AlertTriangle, tone: "text-amber-400" },
  permission_denied: { icon: ShieldAlert, tone: "text-red-400" },
  info: { icon: Info, tone: "text-[var(--muted)]" },
};

export function SystemPill({ entry }: { entry: SystemEntry }) {
  const meta = KIND_META[entry.kind];
  const Icon = meta.icon;
  // Compact-boundary is a major thread-state transition (the SDK summarized
  // earlier turns into a single context block). Show it as a full-width
  // horizontal rule with the label centered so the user has a clear visual
  // break between pre- and post-compact content rather than a small inline
  // pill that gets lost among hook/status entries.
  if (entry.kind === "compact_boundary") {
    return (
      <div className="my-4 flex w-full items-center gap-3 text-[11px] text-[var(--muted)]">
        <div className="h-px flex-1 bg-[var(--border)]" />
        <div className="flex items-center gap-2 whitespace-nowrap">
          <Icon className={`h-3.5 w-3.5 ${meta.tone}`} />
          <span className="font-medium">{entry.label}</span>
          {entry.detail && <span className="opacity-70">— {entry.detail}</span>}
        </div>
        <div className="h-px flex-1 bg-[var(--border)]" />
      </div>
    );
  }
  // Rate-limit gets a richer renderer: tier label + live mm:ss countdown
  // to the reset, plus overage / billing hints. The Claude Code CLI surfaces
  // the same data via "You've used X% of your <tier> · resets <time>" — we
  // reuse the structured SDK payload rather than parsing it from prose so
  // the value is always current.
  if (entry.kind === "rate_limit" && entry.rateLimit) {
    return <RateLimitPill entry={entry} />;
  }
  return (
    <div className="my-1 flex items-center gap-2 text-[11px] text-[var(--muted)]">
      <Icon className={`h-3 w-3 ${meta.tone}`} />
      <span>{entry.label}</span>
      {entry.detail && <span className="opacity-70">— {entry.detail}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rate-limit pill — live countdown + billing hint
// ---------------------------------------------------------------------------

const RATE_LIMIT_TYPE_LABEL: Record<string, string> = {
  five_hour: "5-hour limit",
  seven_day: "Weekly limit",
  seven_day_opus: "Weekly Opus limit",
  seven_day_sonnet: "Weekly Sonnet limit",
  overage: "Extra-usage limit",
};

// Human copy keyed off SDKRateLimitInfo.overageDisabledReason. Strings mirror
// the CLI wording so users who've seen the terminal warning recognise this UI.
const OVERAGE_DISABLED_COPY: Record<string, string> = {
  out_of_credits: "Out of credits — add funds to keep going.",
  org_level_disabled: "Your org has disabled extra usage.",
  org_level_disabled_until: "Your org has disabled extra usage for this window.",
  seat_tier_level_disabled: "Your seat tier doesn't allow extra usage.",
  member_level_disabled: "Extra usage isn't enabled for your account.",
  seat_tier_zero_credit_limit: "Your seat tier has a $0 extra-usage cap.",
  group_zero_credit_limit: "Your group has a $0 extra-usage cap.",
  member_zero_credit_limit: "Your account has a $0 extra-usage cap.",
  org_service_level_disabled: "Your org's service level disables extra usage.",
  overage_not_provisioned: "Extra usage isn't set up on this account.",
  no_limits_configured: "No usage allowance configured.",
  fetch_error: "Couldn't read your usage status — try again.",
  unknown: "Extra usage unavailable.",
};

// Upgrade destinations, mirrored from the Claude Code CLI's `/rate-limit-options`
// menu so the browser surfaces the same next steps when the user hits the wall:
//   "Upgrade your plan"     → claude.ai/upgrade/max
//   "Upgrade to Team plan"  → claude.ai/create/team
// (The CLI's third option, "Stop and wait for limit to reset", is covered here
// by the live countdown — there's nothing to click, you just wait.)
const UPGRADE_PLAN_URL = "https://claude.ai/upgrade/max";
const UPGRADE_TEAM_URL = "https://claude.ai/create/team";

function RateLimitPill({ entry }: { entry: SystemEntry }) {
  const info = entry.rateLimit!;
  const status = info.status ?? "allowed";

  // Pick the "live" reset: when the user has burned through the base quota
  // *and* the overage bucket (overageStatus === "rejected"), the only path
  // forward is to wait for the *later* of the two windows. The CLI follows
  // the same fallback order — base resetsAt first, overage second.
  const isFullyRejected = status === "rejected" && info.overageStatus === "rejected";
  const liveReset = isFullyRejected
    ? Math.max(info.resetsAt ?? 0, info.overageResetsAt ?? 0) || undefined
    : info.resetsAt;

  // All hooks first, before any conditional return — rules-of-hooks.
  // The countdown interval is cheap (one setInterval per visible pill),
  // and the threshold gate below decides whether to *render*; the
  // dedupe in use-session.ts means at most one pill per `rateLimitType`
  // exists at any time, so we're not running runaway timers in hidden
  // pills.
  const countdown = useCountdownSeconds(liveReset);
  const params = useParams<{ workspaceId?: string }>();
  const { value: warningThresholdPct } = useRateLimitWarningPct();

  // Gate non-rejected pills on the user's chosen threshold. The pill
  // still exists in `systemEntries` after this return — we just don't
  // render it — so *lowering* the threshold mid-session immediately
  // reveals previously hidden events without needing a replay.
  if (!shouldShowRateLimitPill(info, warningThresholdPct)) return null;

  const tierLabel = info.rateLimitType ? RATE_LIMIT_TYPE_LABEL[info.rateLimitType] ?? "limit" : "limit";

  const tone =
    status === "rejected"
      ? "border-red-500/30 bg-red-500/10 text-red-200"
      : status === "allowed_warning"
        ? "border-amber-500/30 bg-amber-500/10 text-amber-200"
        : "border-[var(--border)] bg-[var(--panel)]/40 text-[var(--muted)]";

  // SDK reports `utilization` as a 0–1 fraction; the Claude CLI does
  // `Math.floor(H.utilization*100)` before rendering. We mirror that
  // here rather than at the storage layer so the value-on-the-wire and
  // the value-in-the-pref stay in their natural units.
  const utilizationPct =
    typeof info.utilization === "number" ? Math.round(info.utilization * 100) : null;

  const headline =
    status === "rejected"
      ? `You've hit your ${tierLabel}`
      : status === "allowed_warning" && utilizationPct !== null
        ? `You've used ${utilizationPct}% of your ${tierLabel}`
        : `Approaching ${tierLabel}`;

  // Pay-as-you-go pivot. When the base quota is rejected but the overage
  // bucket still says "allowed" (or "allowed_warning") and the user isn't
  // already on it, the Claude Code CLI offers to flip billing. We can't
  // perform the flip from the browser (it's CLI/credential-level config),
  // but we can mirror the messaging and link to the workspace's cost page
  // for the manual switchover.
  const canSwitchToOverage =
    status === "rejected" &&
    (info.overageStatus === "allowed" || info.overageStatus === "allowed_warning") &&
    !info.isUsingOverage;

  const overageBlockedCopy = info.overageDisabledReason
    ? OVERAGE_DISABLED_COPY[info.overageDisabledReason] ?? null
    : null;

  // Compute reset wall-clock label once per render. Intl will pick the
  // user's locale + timezone automatically — matches the CLI's "6:30pm
  // (Europe/Berlin)" wording in spirit even though we don't append the TZ
  // (the browser already knows where the user is).
  const resetClock = liveReset ? formatResetClock(liveReset) : null;

  // Workspace-aware deep link. SystemPill is rendered inside the chat,
  // which always lives at /[workspaceId]/..., so useParams gives us the
  // active workspace id without having to thread it through props.
  const costHref = params?.workspaceId ? `/${params.workspaceId}/cost` : "/cost";

  return (
    <div className={`my-2 rounded-md border px-3 py-2 text-[11px] leading-5 ${tone}`}>
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-3.5 w-3.5" />
        <span className="font-medium">{headline}</span>
        {resetClock && (
          <span className="opacity-80">
            {" · "}resets {resetClock}
          </span>
        )}
      </div>

      {countdown && (
        <div className="mt-1 flex items-center gap-1.5 opacity-90">
          <Timer className="h-3 w-3" />
          <span className="font-mono">{countdown}</span>
          <span className="opacity-70">until reset</span>
        </div>
      )}

      {(canSwitchToOverage || overageBlockedCopy) && (
        <div className="mt-1.5 border-t border-current/10 pt-1.5 opacity-90">
          {canSwitchToOverage && (
            <span>
              Need to keep going? Switch this session to pay-as-you-go billing in your{" "}
              <Link href={costHref} className="underline underline-offset-2 hover:opacity-80">
                cost settings
              </Link>
              .
            </span>
          )}
          {overageBlockedCopy && <span>{overageBlockedCopy}</span>}
        </div>
      )}

      {/* Hard-stop next steps. Mirrors the CLI's `/rate-limit-options` menu:
          wait for the reset (the countdown above) or upgrade to lift the cap.
          Only shown on rejection — a warning isn't a wall yet. */}
      {status === "rejected" && (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-current/10 pt-1.5">
          <span className="opacity-70">Out of usage? Upgrade to keep going:</span>
          <a
            href={UPGRADE_PLAN_URL}
            target="_blank"
            rel="noreferrer"
            className="font-medium underline underline-offset-2 hover:opacity-80"
          >
            Upgrade your plan
          </a>
          <a
            href={UPGRADE_TEAM_URL}
            target="_blank"
            rel="noreferrer"
            className="font-medium underline underline-offset-2 hover:opacity-80"
          >
            Upgrade to Team plan
          </a>
        </div>
      )}
    </div>
  );
}

/**
 * Live countdown to an epoch-seconds timestamp. Returns `null` once the
 * reset has passed (caller can fall back to a "retry now" affordance) or
 * when `resetsAt` is missing.
 *
 * Implementation note: the SDK's `resetsAt` is in *seconds*, not ms (the
 * CLI computes `(resetsAt - Date.now()/1000)`). We tick once per second
 * via `setInterval` and clean up on unmount or when the target changes.
 *
 * The current wall-clock is held in state (not read with `Date.now()`
 * during render) so the component stays referentially pure between
 * ticks — react-hooks/purity flags otherwise-equivalent code that reads
 * `Date.now()` directly in render.
 */
function useCountdownSeconds(resetsAtSec: number | undefined): string | null {
  // The current wall-clock lives in state; the initializer reads
  // `Date.now()` once at mount so the first paint is correct, and the
  // setInterval below keeps it advancing. We don't sync inside the
  // effect body (`react-hooks/set-state-in-effect` flags that pattern
  // as a cascading re-render); the initializer already covers mount,
  // and the first tick fires within ≤ 1s — imperceptible.
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!resetsAtSec) return;
    // Re-render once per second. We don't need sub-second precision — the
    // smallest unit we render is "Xs" — so a 1-Hz tick is plenty.
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [resetsAtSec]);

  if (!resetsAtSec) return null;
  const remaining = Math.floor(resetsAtSec - nowMs / 1000);
  if (remaining <= 0) return "Available now";
  return formatRemaining(remaining);
}

function formatRemaining(totalSec: number): string {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) {
    // For long windows (weekly resets) show "Dd HHh MMm" — otherwise the
    // hour count balloons past 24 and reads as nonsense.
    if (h >= 24) {
      const d = Math.floor(h / 24);
      const hh = h % 24;
      return `${d}d ${hh}h ${m.toString().padStart(2, "0")}m`;
    }
    return `${h}h ${m.toString().padStart(2, "0")}m ${s.toString().padStart(2, "0")}s`;
  }
  return `${m.toString().padStart(2, "0")}m ${s.toString().padStart(2, "0")}s`;
}

function formatResetClock(resetsAtSec: number): string {
  const d = new Date(resetsAtSec * 1000);
  // `numeric` minute looks like "6:3pm" — force 2-digit minute via the
  // standard `2-digit` option.
  return d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}
