/**
 * CC 2.1.299 parity — "Added /usage warnings for max effort, workflows,
 * always-on context and large tool results".
 *
 * The CLI's `/usage` dialog has a "What's contributing to your limits usage?"
 * section fed by a scan of local transcripts. The SDK exposes the same data on
 * `Query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` as
 * `behaviors.{day,week}.behaviors[{key, pct, count}]` (null for
 * non-claude.ai-subscriber sessions, or when the scan fails). The CLI renders
 * one warning per behaviour whose share is at least {@link USAGE_FLAG_THRESHOLD_PCT}
 * — filtered on the UNROUNDED share, displayed `Math.round`ed — with the copy
 * in {@link USAGE_BEHAVIOR_COPY} (verbatim from the bundled 2.1.299 binary).
 *
 * Claudius surfaces it in the per-session Cost overlay (`/cost`), which already
 * shows plan usage. Pure + dependency-free so it's unit-testable and usable
 * from both the server (extraction) and the overlay (filtering/copy).
 */

export type UsageBehaviorKey =
  | "cache_miss"
  | "long_context"
  | "subagent_heavy"
  | "high_parallel"
  | "cron"
  | "max_effort"
  | "workflow"
  | "always_on_context"
  | "large_tool_results";

/** One behavioural characteristic of local usage in a window. */
export type UsageBehaviorStat = {
  key: UsageBehaviorKey;
  /** Share of the weighted local usage attributed to this behaviour, 0-100. */
  pct: number;
  /** Requests in the window exhibiting the behaviour. */
  count: number;
};

export type UsageBehaviorWindow = {
  /** API requests found in local transcripts for this window. */
  requestCount: number;
  /** Distinct sessions observed in this window. */
  sessionCount: number;
  /**
   * Behaviours with a known key. Categories overlap — this is not a
   * partition, so percentages don't sum to 100.
   */
  behaviors: UsageBehaviorStat[];
};

export type UsageBehaviors = { day: UsageBehaviorWindow; week: UsageBehaviorWindow };

/** Response body of `GET /api/sessions/[id]/usage-behaviors`. */
export type UsageBehaviorsResponse = { behaviors: UsageBehaviors | null };

/** The CLI's `/usage` only warns about behaviours at or above this share. */
export const USAGE_FLAG_THRESHOLD_PCT = 10;

/** Headline + body for each behaviour, verbatim from the CLI 2.1.299 bundle. */
export const USAGE_BEHAVIOR_COPY: Record<UsageBehaviorKey, { headline: (pct: number) => string; body: string }> = {
  cache_miss: {
    headline: (pct) => `${pct}% of your usage hit a >100k-token cache miss`,
    body: "Uncached input is expensive, and often happens when sending a message to a session that has gone idle. /compact before stepping away keeps the cold-start small.",
  },
  long_context: {
    headline: (pct) => `${pct}% of your usage was at >150k context`,
    body: "Longer sessions are more expensive even when cached. /compact mid-task, /clear when switching to new tasks.",
  },
  subagent_heavy: {
    headline: (pct) => `${pct}% of your usage came from subagent-heavy sessions`,
    body: "Each subagent runs its own requests. Be deliberate about spawning them — and consider configuring a cheaper model for simpler subagents.",
  },
  high_parallel: {
    headline: (pct) => `${pct}% of your usage was while 4+ sessions ran in parallel`,
    body: "All sessions share one limit. If you don't need them all at once, queueing uses it more evenly.",
  },
  cron: {
    headline: (pct) => `${pct}% of your usage came from sessions active for 8+ hours`,
    body: "These are often background/loop sessions. Continuous usage can add up quickly so make sure it is intentional.",
  },
  max_effort: {
    headline: (pct) => `${pct}% of your usage was at max effort`,
    body: "Max effort thinks much longer on every step. Save it for the hardest tasks and use a lower level for everyday work (/effort).",
  },
  workflow: {
    headline: (pct) => `${pct}% of your usage came from workflows`,
    body: "A workflow fans a task out to many agents, and each one runs its own requests. Save them for big tasks. Ultracode starts one on every task; /effort turns it off.",
  },
  always_on_context: {
    headline: (pct) => `${pct}% of your usage went to always-on context over 40k tokens`,
    body: "CLAUDE.md files, MCP tools, skills and memory are sent with every request. Run /context to see what takes up space, then trim or turn off what you don't need.",
  },
  large_tool_results: {
    headline: (pct) => `${pct}% of your usage went to tool results over 10k tokens`,
    body: "A large result is paid for again on every later request until it's compacted or cleared. Ask for narrower reads, searches and command output, or hand noisy work to a subagent.",
  },
};

function isBehaviorKey(key: unknown): key is UsageBehaviorKey {
  return typeof key === "string" && Object.prototype.hasOwnProperty.call(USAGE_BEHAVIOR_COPY, key);
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function extractWindow(raw: unknown): UsageBehaviorWindow | null {
  if (!raw || typeof raw !== "object") return null;
  const w = raw as { request_count?: unknown; session_count?: unknown; behaviors?: unknown };
  const behaviors: UsageBehaviorStat[] = [];
  if (Array.isArray(w.behaviors)) {
    for (const b of w.behaviors) {
      if (!b || typeof b !== "object") continue;
      const { key, pct, count } = b as { key?: unknown; pct?: unknown; count?: unknown };
      // Unknown (future) keys have no copy to render — drop them rather than
      // showing a headline-less row.
      if (!isBehaviorKey(key) || typeof pct !== "number" || !Number.isFinite(pct)) continue;
      behaviors.push({ key, pct, count: num(count) });
    }
  }
  return { requestCount: num(w.request_count), sessionCount: num(w.session_count), behaviors };
}

/**
 * Pull the day/week behaviour windows out of an experimental usage response.
 * `null` when the section is absent/null (non-subscriber session, failed
 * scan, `skipBehaviors`) or malformed — the overlay then hides the section.
 */
export function extractUsageBehaviors(usageData: unknown): UsageBehaviors | null {
  const raw = (usageData as { behaviors?: unknown } | null | undefined)?.behaviors;
  if (!raw || typeof raw !== "object") return null;
  const { day, week } = raw as { day?: unknown; week?: unknown };
  const d = extractWindow(day);
  const w = extractWindow(week);
  if (!d || !w) return null;
  return { day: d, week: w };
}

/**
 * The behaviours worth warning about: share >= `threshold` (on the raw,
 * unrounded pct — same as the CLI, so 9.6% stays hidden even though it would
 * print as "10%"), highest share first.
 */
export function filterUsageFlags(
  behaviors: readonly UsageBehaviorStat[],
  threshold: number = USAGE_FLAG_THRESHOLD_PCT,
): UsageBehaviorStat[] {
  return behaviors
    .filter((b) => isBehaviorKey(b.key) && b.pct >= threshold)
    .sort((a, b) => b.pct - a.pct);
}

/** The rendered headline + body for one flagged behaviour (pct `Math.round`ed, like the CLI). */
export function usageFlagCopy(stat: UsageBehaviorStat): { headline: string; body: string } {
  const copy = USAGE_BEHAVIOR_COPY[stat.key];
  return { headline: copy.headline(Math.round(stat.pct)), body: copy.body };
}
