"use client";

import { AlertTriangle, Timer } from "lucide-react";
import type { DisplayMessage } from "@/lib/client/types";
import { formatResetClock, useCountdownSeconds } from "@/lib/client/use-countdown";

// Upgrade destinations, mirrored from the Claude Code CLI's `/rate-limit-options`
// menu so the browser surfaces the same next steps when the user hits the wall:
//   "Upgrade your plan"     → claude.ai/upgrade/max
//   "Upgrade to Team plan"  → claude.ai/create/team
// (The CLI's third option, "Stop and wait for limit to reset", is covered here
// by the live countdown / the reset time printed in the message above — there's
// nothing to click, you just wait.)
export const UPGRADE_PLAN_URL = "https://claude.ai/upgrade/max";
export const UPGRADE_TEAM_URL = "https://claude.ai/create/team";
/**
 * SDK 0.3.181 — destination for the "buy credits" CTA when
 * `errorCode === 'credits_required'`. Reuses the same page the
 * long-context credits nudge links to.
 */
export const PURCHASE_CREDITS_URL = "https://claude.ai/settings/usage";

const RATE_LIMIT_TYPE_LABEL: Record<string, string> = {
  five_hour: "5-hour limit",
  seven_day: "weekly limit",
  seven_day_opus: "weekly Opus limit",
  seven_day_sonnet: "weekly Sonnet limit",
  overage: "extra-usage limit",
};

export type RateLimitHit = NonNullable<DisplayMessage["rateLimitHit"]>;

/**
 * The CLI's "Upgrade your plan / Upgrade to Team plan" affordances. Shared by
 * the inline hit panel below and the event-driven rejected pill in SystemPill
 * so the wording + destinations stay in one place.
 */
export function RateLimitUpgradeLinks() {
  return (
    <>
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
    </>
  );
}

/**
 * Actionable panel rendered inline under an assistant message that *is* a hard
 * rate-limit hit ("You've hit your session limit · resets …"). Mirrors the
 * Claude Code CLI's `/rate-limit-options` menu so the browser gives the user a
 * next step instead of bare prose: a live countdown to the reset (when we know
 * it) plus upgrade links.
 *
 * Lives on the message (not as a separate system pill) so it renders on every
 * transcript path — live stream, resumed-session replay, and paginated
 * scrollback — each of which builds the bubble through a different code path.
 */
export function RateLimitHitPanel({ hit }: { hit: RateLimitHit }) {
  const countdown = useCountdownSeconds(hit.resetsAt);
  const tierLabel = hit.rateLimitType
    ? RATE_LIMIT_TYPE_LABEL[hit.rateLimitType] ?? "usage limit"
    : "usage limit";
  const resetClock = hit.resetsAt ? formatResetClock(hit.resetsAt) : null;

  // Per-model weekly-limit takeover toast — the Claude Code TUI prints a
  // "Now using <fallback>. Your <limit> resets <time>" ambient line so the
  // user knows why the active model just silently changed. Gated on the two
  // per-model rejection tiers since the SDK's automatic fallback only engages
  // for those (`seven_day` / `five_hour` / `overage` are account-wide and the
  // model doesn't swap).
  const showFallbackTakeover =
    !!hit.fallbackModel &&
    (hit.rateLimitType === "seven_day_opus" || hit.rateLimitType === "seven_day_sonnet");

  return (
    <div className="my-1 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] leading-5 text-red-200">
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-3.5 w-3.5" />
        <span className="font-medium">You&apos;ve hit your {tierLabel}</span>
        {resetClock && <span className="opacity-80">{" · "}resets {resetClock}</span>}
      </div>

      {countdown && (
        <div className="mt-1 flex items-center gap-1.5 opacity-90">
          <Timer className="h-3 w-3" />
          <span className="font-mono">{countdown}</span>
          <span className="opacity-70">until reset</span>
        </div>
      )}

      {showFallbackTakeover && (
        <div className="mt-1 opacity-90">
          Now using <span className="font-mono">{hit.fallbackModel}</span>.
        </div>
      )}

      {/* SDK 0.3.181 — credits-required path: show "buy credits" CTA.
          Falls back to the standard upgrade links for ordinary plan limits. */}
      {hit.errorCode === "credits_required" ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-current/10 pt-1.5">
          <span className="opacity-70">Credits required to continue:</span>
          <a
            href={PURCHASE_CREDITS_URL}
            target="_blank"
            rel="noreferrer"
            className="font-medium underline underline-offset-2 hover:opacity-80"
            data-testid="buy-credits-link"
          >
            {hit.hasChargeableSavedPaymentMethod ? "Buy credits" : "Add payment method"}
          </a>
        </div>
      ) : (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-current/10 pt-1.5">
          <span className="opacity-70">Out of usage? Upgrade to keep going:</span>
          <RateLimitUpgradeLinks />
        </div>
      )}
    </div>
  );
}
