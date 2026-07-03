"use client";

import {
  AlertCircle,
  AlertTriangle,
  Bell,
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
import { useState } from "react";
import { useParams } from "next/navigation";
import type { SystemEntry } from "@/lib/client/types";
import {
  shouldShowRateLimitPill,
  useRateLimitWarningPct,
} from "@/lib/client/useRateLimitWarning";
import { formatResetClock, useCountdownSeconds } from "@/lib/client/use-countdown";
import { PURCHASE_CREDITS_URL, RateLimitUpgradeLinks } from "./RateLimitHitPanel";
import { OPUS_OVERLOAD_NUDGE_SONNET_TARGET } from "./OpusOverloadNudgePanel";

/**
 * Remediation-lever context for the soft `allowed_warning` branch of
 * {@link RateLimitPill}. The CLI pairs the "Approaching <limit>" headline with
 * "try /model sonnet" / "try /effort medium" hints — we mirror that as
 * one-click chips when the active session is on Opus (model burn-down) or on
 * a high reasoning-effort level (output-token burn-down). All optional: a
 * SystemPill rendered without these props (splash screen, dev pages) still
 * works, the chips just don't appear.
 */
export type SystemPillLevers = {
  model?: string | null;
  effort?: "low" | "medium" | "high" | "xhigh" | "max" | "auto";
  onSwitchToSonnet?: () => void | Promise<void>;
  onStepEffortDown?: () => void | Promise<void>;
};

const KIND_META: Record<SystemEntry["kind"], { icon: typeof Info; tone: string }> = {
  init: { icon: Cpu, tone: "text-emerald-400" },
  hook_started: { icon: Webhook, tone: "text-sky-400" },
  hook_response: { icon: CheckCircle2, tone: "text-sky-400" },
  status: { icon: Clock, tone: "text-amber-400" },
  compact_boundary: { icon: GitMerge, tone: "text-violet-400" },
  rate_limit: { icon: AlertTriangle, tone: "text-amber-400" },
  api_retry: { icon: AlertTriangle, tone: "text-amber-400" },
  permission_denied: { icon: ShieldAlert, tone: "text-red-400" },
  // Automatic model-fallback announcement — the SDK's
  // `Switched to <new> because <old> is not available [due to high demand
  // for <old>]` line. Amber `Cpu` mirrors the CLI's own pip and pairs with
  // the `init` pill (same icon, different tone) so a reader scans both as
  // "model state" rows.
  model_fallback: { icon: Cpu, tone: "text-amber-400" },
  // Cross-turn `<system-reminder>` blocks the server prepends to the user's
  // SDK input (every-turn todos nudge, stale-todowrite, plan-mode-reentry,
  // etc. — see `lib/server/system-reminders.ts`). Rendered with the same
  // muted tone as `info` because these are background nudges to the model,
  // not events that demand the user's attention.
  system_reminder: { icon: Bell, tone: "text-[var(--muted)]" },
  info: { icon: Info, tone: "text-[var(--muted)]" },
};

export function SystemPill({
  entry,
  levers,
}: {
  entry: SystemEntry;
  levers?: SystemPillLevers;
}) {
  const meta = KIND_META[entry.kind];
  const Icon = meta.icon;
  // Compact-boundary is a major thread-state transition (the SDK summarized
  // earlier turns into a single context block). Show it as a full-width
  // horizontal rule with the token-reduction stats and an expandable summary —
  // the same data the CLI shows on a `/compact` (its ctrl+o expands the full
  // summary). Delegated to its own component so the expand/collapse state
  // doesn't add hooks to the other (hookless) SystemPill render paths.
  if (entry.kind === "compact_boundary") {
    return <CompactBoundaryDivider entry={entry} />;
  }
  // Rate-limit gets a richer renderer: tier label + live mm:ss countdown
  // to the reset, plus overage / billing hints. The Claude Code CLI surfaces
  // the same data via "You've used X% of your <tier> · resets <time>" — we
  // reuse the structured SDK payload rather than parsing it from prose so
  // the value is always current.
  if (entry.kind === "rate_limit" && entry.rateLimit) {
    return <RateLimitPill entry={entry} levers={levers} />;
  }
  // System reminders are cross-turn nudges the server prepends to the user's
  // SDK input. They survive in the JSONL and would otherwise leak into the
  // user's own bubble on a cold resume; lifting them here keeps them
  // visible-but-tidy. Collapsed by default because `todos-current` fires
  // every turn — at one block per turn the chat would otherwise become
  // wallpaper.
  if (entry.kind === "system_reminder" && entry.reminderBody) {
    return <SystemReminderPill entry={entry} />;
  }
  // A failed hook (SessionStart/Setup/SubagentStart exiting 2, etc.) gets its
  // own renderer: red tone so it reads as an error rather than routine hook
  // chatter, plus an expandable stderr body when the SDK sent one — mirroring
  // CC 2.1.199's "stop hiding the stderr" fix instead of silently dropping it.
  if (entry.kind === "hook_response" && entry.hookFailed) {
    return <HookFailurePill entry={entry} />;
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
// System-reminder pill — collapsed by default, ▸ expand reveals the body
// ---------------------------------------------------------------------------

/**
 * Best-effort short title derived from the reminder body's opening line.
 * Used as the collapsed-pill label so a reader scanning the chat can tell
 * a `todos-current` nudge from a `plan-mode-reentry` without expanding.
 * Falls back to "System reminder" for bodies we don't recognise.
 */
function systemReminderTitle(body: string): string {
  const lead = body.trimStart().slice(0, 120).toLowerCase();
  if (lead.startsWith("the current to-do list")) return "Todos snapshot";
  if (lead.startsWith("the todowrite tool hasn't")) return "TodoWrite idle";
  if (lead.startsWith("the task tools haven't")) return "Task tools idle";
  if (lead.startsWith("## re-entering plan mode")) return "Re-entering plan mode";
  if (lead.startsWith("## exited auto mode")) return "Exited auto mode";
  if (lead.startsWith("you have completed implementing the plan")) return "Verify plan";
  if (lead.startsWith("the date has changed")) return "Date change";
  if (lead.startsWith("memory")) return "Memory update";
  return "System reminder";
}

function SystemReminderPill({ entry }: { entry: SystemEntry }) {
  const [expanded, setExpanded] = useState(false);
  const body = entry.reminderBody ?? "";
  const title = systemReminderTitle(body);
  return (
    <div className="my-1 text-[11px] text-[var(--muted)]">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-[var(--panel-2)]/40"
        title={expanded ? "Hide reminder text" : "Show reminder text"}
      >
        <Bell className="h-3 w-3 text-[var(--muted)]" />
        <span className="opacity-90">System reminder</span>
        <span className="opacity-60">— {title}</span>
        <span className="opacity-50">{expanded ? "▾" : "▸"}</span>
      </button>
      {expanded && (
        <div className="ml-5 mt-1 max-h-60 overflow-auto whitespace-pre-wrap rounded-md border border-[var(--border)] bg-[var(--panel)]/40 p-2 text-[10.5px] leading-5 text-[var(--foreground)]/75 scroll-thin">
          {body}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hook-failure pill — red tone + expandable stderr (CC 2.1.199)
// ---------------------------------------------------------------------------

function HookFailurePill({ entry }: { entry: SystemEntry }) {
  const [expanded, setExpanded] = useState(false);
  const hasStderr = typeof entry.hookStderr === "string" && entry.hookStderr.length > 0;
  return (
    <div className="my-1 text-[11px] text-red-300">
      <button
        type="button"
        onClick={() => hasStderr && setExpanded((v) => !v)}
        aria-expanded={hasStderr ? expanded : undefined}
        disabled={!hasStderr}
        className="flex items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-red-500/10 disabled:cursor-default disabled:hover:bg-transparent"
        title={hasStderr ? (expanded ? "Hide hook stderr" : "Show hook stderr") : undefined}
      >
        <AlertCircle className="h-3 w-3 text-red-400" />
        <span>{entry.label}</span>
        {entry.detail && <span className="opacity-70">— {entry.detail}</span>}
        {hasStderr && <span className="opacity-50">{expanded ? "▾" : "▸"}</span>}
      </button>
      {expanded && hasStderr && (
        <div className="ml-5 mt-1 max-h-60 overflow-auto whitespace-pre-wrap rounded-md border border-red-500/30 bg-red-500/10 p-2 font-mono text-[10.5px] leading-5 text-red-200 scroll-thin">
          {entry.hookStderr}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Compact-boundary divider — token-reduction stats + expandable summary
// ---------------------------------------------------------------------------

function formatCompactStats(s: NonNullable<SystemEntry["compactStats"]>): string | null {
  const parts: string[] = [];
  if (typeof s.preTokens === "number" && typeof s.postTokens === "number") {
    parts.push(`${s.preTokens.toLocaleString()}→${s.postTokens.toLocaleString()} tokens`);
  }
  // Only show duration when it's at least a second — sub-second compactions
  // round to "0s" and read as noise.
  if (typeof s.durationMs === "number" && s.durationMs >= 1000) {
    parts.push(`${Math.round(s.durationMs / 1000)}s`);
  }
  return parts.length ? parts.join(" · ") : null;
}

function CompactBoundaryDivider({ entry }: { entry: SystemEntry }) {
  const [expanded, setExpanded] = useState(false);
  const statText = entry.compactStats ? formatCompactStats(entry.compactStats) : null;
  const hasSummary = typeof entry.compactSummary === "string" && entry.compactSummary.length > 0;
  return (
    <div className="my-4 w-full text-[11px] text-[var(--muted)]">
      <div className="flex items-center gap-3">
        <div className="h-px flex-1 bg-[var(--border)]" />
        <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1">
          <GitMerge className="h-3.5 w-3.5 shrink-0 text-violet-400" />
          <span className="font-medium">{entry.label}</span>
          {statText && <span className="opacity-70">· {statText}</span>}
          {entry.detail && <span className="opacity-70">— {entry.detail}</span>}
          {hasSummary && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              className="rounded border border-[var(--border)] bg-[var(--panel-2)] px-1.5 py-0.5 text-[10px] hover:bg-[var(--panel)]"
            >
              {expanded ? "▾ hide summary" : "▸ show summary"}
            </button>
          )}
        </div>
        <div className="h-px flex-1 bg-[var(--border)]" />
      </div>
      {expanded && hasSummary && (
        <div className="mx-auto mt-2 max-h-80 max-w-[var(--chat-col)] overflow-auto whitespace-pre-wrap rounded-md border border-[var(--border)] bg-[var(--panel)]/40 p-3 text-[11px] leading-5 text-[var(--foreground)]/80 scroll-thin">
          {entry.compactSummary}
        </div>
      )}
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
  seven_day_overage_included: "Weekly limit (overage incl.)",
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

// Effort levels considered "high" for the step-down chip. The CLI's soft
// warning specifically calls out `/effort medium` as the burn-down lever when
// the user is on `high` or `xhigh` — we extend that to `max` (strictly higher
// than what the spec enumerates) so the chip surfaces wherever stepping down
// to `medium` would meaningfully reduce per-turn output-token spend.
const HIGH_EFFORT_LEVELS = new Set<string>(["high", "xhigh", "max"]);

function RateLimitPill({
  entry,
  levers,
}: {
  entry: SystemEntry;
  levers?: SystemPillLevers;
}) {
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

  // Soft-warning remediation chips. The CLI pairs "Approaching <limit>" with
  // one-line hints — "try /model sonnet" when the active model is Opus
  // (burns Opus minutes), "try /effort medium" when reasoning effort is
  // high/xhigh/max (burns per-turn output tokens). The rejected branch owns
  // the upgrade links below, so chips are gated to non-rejected warnings.
  const showSonnetChip =
    status === "allowed_warning" &&
    !!levers?.onSwitchToSonnet &&
    !!levers.model &&
    levers.model.toLowerCase().includes("opus");
  const showEffortChip =
    status === "allowed_warning" &&
    !!levers?.onStepEffortDown &&
    !!levers.effort &&
    HIGH_EFFORT_LEVELS.has(levers.effort);
  // "Change the threshold" link — paired with the burn-down chips so a user
  // who'd rather hush the warning than switch model/effort can jump straight
  // to the preset that controls when this pill fires. Always offered on a
  // soft warning (the rejected branch is a hard stop the user must see).
  const showThresholdChip = status === "allowed_warning";

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

      {/* Soft-warning remediation chips. Surfaced on `allowed_warning`. The
          model/effort chips appear only when the active session is on a
          model/effort the lever can actually burn down — Sonnet pivot for
          Opus sessions, effort step-down for high/xhigh/max — mirroring the
          CLI's "try /model sonnet" / "try /effort medium" hints with
          one-click affordances that reuse the existing setModel/setEffort
          plumbing. The "change the threshold" link is always offered so a
          user who'd rather hush the warning than burn down can jump straight
          to the preset that controls when this pill fires. */}
      {(showSonnetChip || showEffortChip || showThresholdChip) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-current/10 pt-1.5">
          <span className="opacity-70">Slow your burn:</span>
          {showSonnetChip && (
            <button
              type="button"
              onClick={() => void levers!.onSwitchToSonnet!()}
              className="rounded border border-current/30 bg-current/10 px-1.5 py-0.5 font-medium hover:bg-current/20"
              title={`Switch this session to ${OPUS_OVERLOAD_NUDGE_SONNET_TARGET}`}
            >
              try /model sonnet
            </button>
          )}
          {showEffortChip && (
            <button
              type="button"
              onClick={() => void levers!.onStepEffortDown!()}
              className="rounded border border-current/30 bg-current/10 px-1.5 py-0.5 font-medium hover:bg-current/20"
              title="Step reasoning effort down to medium"
            >
              try /effort medium
            </button>
          )}
          {showThresholdChip && (
            <Link
              href="/settings#rate-limit-warning"
              className="rounded border border-current/30 bg-current/10 px-1.5 py-0.5 font-medium hover:bg-current/20"
              title="Change the utilization % at which this warning fires"
            >
              change the threshold
            </Link>
          )}
        </div>
      )}

      {/* Hard-stop next steps. SDK 0.3.181: when errorCode === "credits_required"
          AND canUserPurchaseCredits !== false, the user needs to buy credits —
          show the purchase CTA. When canUserPurchaseCredits is explicitly false
          (org-managed seat, non-admin) they can't act directly — show a
          contact-admin line. For ordinary plan limits mirror the CLI's
          `/rate-limit-options`: wait for the reset or upgrade to lift the cap.
          Only shown on rejection — a warning isn't a wall yet. */}
      {status === "rejected" && info.errorCode === "credits_required" && info.canUserPurchaseCredits !== false ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-current/10 pt-1.5">
          <span className="opacity-70">Credits required to continue:</span>
          <a
            href={PURCHASE_CREDITS_URL}
            target="_blank"
            rel="noreferrer"
            className="font-medium underline underline-offset-2 hover:opacity-80"
            data-testid="rate-limit-buy-credits-link"
          >
            {info.hasChargeableSavedPaymentMethod ? "Buy credits" : "Add payment method"}
          </a>
        </div>
      ) : status === "rejected" && info.errorCode === "credits_required" ? (
        <div className="mt-1.5 border-t border-current/10 pt-1.5">
          <span className="opacity-70" data-testid="rate-limit-credits-contact-admin">
            Credits required to continue — contact your administrator.
          </span>
        </div>
      ) : (
        status === "rejected" && (
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-current/10 pt-1.5">
            <span className="opacity-70">Out of usage? Upgrade to keep going:</span>
            <RateLimitUpgradeLinks />
          </div>
        )
      )}
    </div>
  );
}
