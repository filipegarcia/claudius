import { describe, expect, test } from "vitest";
import {
  USAGE_BEHAVIOR_COPY,
  USAGE_FLAG_THRESHOLD_PCT,
  extractUsageBehaviors,
  filterUsageFlags,
  usageFlagCopy,
  type UsageBehaviorStat,
} from "@/lib/shared/usage-behaviors";

/**
 * CC 2.1.299 — "Added /usage warnings for max effort, workflows, always-on
 * context and large tool results". The SDK's experimental usage response
 * carries `behaviors.{day,week}.behaviors[{key, pct, count}]`; the CLI warns
 * about each behaviour whose (unrounded) share is >= 10%, printing the share
 * `Math.round`ed with fixed copy. Claudius mirrors that in the Cost overlay.
 */

const stat = (key: UsageBehaviorStat["key"], pct: number, count = 1): UsageBehaviorStat => ({ key, pct, count });

describe("extractUsageBehaviors", () => {
  test("maps the SDK's day/week windows (snake_case) and keeps known keys only", () => {
    const usage = {
      behaviors: {
        day: {
          request_count: 120,
          session_count: 4,
          behaviors: [
            { key: "max_effort", pct: 41.2, count: 50 },
            { key: "some_future_key", pct: 80, count: 9 },
            { key: "workflow", pct: 22, count: 12 },
          ],
          skills: [{ name: "pdf", pct: 3 }],
        },
        week: { request_count: 900, session_count: 30, behaviors: [{ key: "cache_miss", pct: 15, count: 70 }] },
      },
    };
    expect(extractUsageBehaviors(usage)).toEqual({
      day: {
        requestCount: 120,
        sessionCount: 4,
        behaviors: [stat("max_effort", 41.2, 50), stat("workflow", 22, 12)],
        recommendations: [],
      },
      week: { requestCount: 900, sessionCount: 30, behaviors: [stat("cache_miss", 15, 70)], recommendations: [] },
    });
  });

  test("null for non-subscriber sessions, skipBehaviors answers and malformed input", () => {
    expect(extractUsageBehaviors(null)).toBeNull();
    expect(extractUsageBehaviors(undefined)).toBeNull();
    expect(extractUsageBehaviors({})).toBeNull();
    expect(extractUsageBehaviors({ behaviors: null })).toBeNull();
    expect(extractUsageBehaviors({ behaviors: { day: {} } })).toBeNull();
    expect(extractUsageBehaviors({ behaviors: "nope" })).toBeNull();
  });

  test("drops entries with a non-numeric pct and tolerates a missing behaviours array", () => {
    const out = extractUsageBehaviors({
      behaviors: {
        day: { behaviors: [{ key: "cron", pct: "12" }, { key: "cron" }, null, { key: "long_context", pct: 30 }] },
        week: {},
      },
    });
    expect(out?.day.behaviors).toEqual([stat("long_context", 30, 0)]);
    expect(out?.day.requestCount).toBe(0);
    expect(out?.week.behaviors).toEqual([]);
  });
});

describe("extractUsageBehaviors — recommendations (SDK 0.3.305)", () => {
  test("keeps well-formed recommendations, with or without detail, in SDK order", () => {
    const out = extractUsageBehaviors({
      behaviors: {
        day: {
          behaviors: [],
          recommendations: [
            { key: "max_effort", pct: 41.2, title: "Lower the default effort", detail: "/effort high" },
            { key: "mcp_server", pct: 12, title: "Disable the unused linear server" },
          ],
        },
        week: { behaviors: [] },
      },
    });
    expect(out?.day.recommendations).toEqual([
      { key: "max_effort", pct: 41.2, title: "Lower the default effort", detail: "/effort high" },
      { key: "mcp_server", pct: 12, title: "Disable the unused linear server" },
    ]);
    // An SDK that predates the field (or a window without it) yields [].
    expect(out?.week.recommendations).toEqual([]);
  });

  test("drops malformed entries and blank details", () => {
    const out = extractUsageBehaviors({
      behaviors: {
        day: {
          recommendations: [
            null,
            { key: 1, pct: 5, title: "bad key" },
            { key: "cron", pct: "5", title: "bad pct" },
            { key: "cron", pct: 5, title: "  " },
            { key: "cron", pct: 5, title: "Trim loops", detail: "   " },
          ],
        },
        week: { recommendations: "nope" },
      },
    });
    expect(out?.day.recommendations).toEqual([{ key: "cron", pct: 5, title: "Trim loops" }]);
    expect(out?.week.recommendations).toEqual([]);
  });
});

describe("filterUsageFlags", () => {
  test("threshold is the CLI's 10%", () => {
    expect(USAGE_FLAG_THRESHOLD_PCT).toBe(10);
  });

  test("filters on the unrounded share: 9.6 hidden (though it'd print 10), 10 shown", () => {
    const out = filterUsageFlags([stat("cron", 9.6), stat("workflow", 10), stat("high_parallel", 3)]);
    expect(out.map((b) => b.key)).toEqual(["workflow"]);
  });

  test("sorted by share, highest first", () => {
    const out = filterUsageFlags([stat("workflow", 22), stat("max_effort", 41), stat("cache_miss", 30)]);
    expect(out.map((b) => b.key)).toEqual(["max_effort", "cache_miss", "workflow"]);
  });

  test("custom threshold and unknown keys", () => {
    const unknown = { key: "mystery", pct: 99, count: 1 } as unknown as UsageBehaviorStat;
    expect(filterUsageFlags([stat("cron", 6), unknown], 5).map((b) => b.key)).toEqual(["cron"]);
  });

  test("does not mutate its input", () => {
    const input = [stat("workflow", 12), stat("max_effort", 40)];
    filterUsageFlags(input);
    expect(input.map((b) => b.key)).toEqual(["workflow", "max_effort"]);
  });
});

describe("usageFlagCopy — CLI 2.1.299 copy, pct Math.round-ed", () => {
  test("rounds like the CLI", () => {
    expect(usageFlagCopy(stat("max_effort", 10.4)).headline).toBe("10% of your usage was at max effort");
    expect(usageFlagCopy(stat("max_effort", 33.5)).headline).toBe("34% of your usage was at max effort");
  });

  test("the four new 2.1.299 warnings, verbatim", () => {
    expect(usageFlagCopy(stat("max_effort", 41))).toEqual({
      headline: "41% of your usage was at max effort",
      body: "Max effort thinks much longer on every step. Save it for the hardest tasks and use a lower level for everyday work (/effort).",
    });
    expect(usageFlagCopy(stat("workflow", 22))).toEqual({
      headline: "22% of your usage came from workflows",
      body: "A workflow fans a task out to many agents, and each one runs its own requests. Save them for big tasks. Ultracode starts one on every task; /effort turns it off.",
    });
    expect(usageFlagCopy(stat("always_on_context", 18)).headline).toBe(
      "18% of your usage went to always-on context over 40k tokens",
    );
    expect(USAGE_BEHAVIOR_COPY.always_on_context.body).toBe(
      "CLAUDE.md files, MCP tools, skills and memory are sent with every request. Run /context to see what takes up space, then trim or turn off what you don't need.",
    );
    expect(usageFlagCopy(stat("large_tool_results", 12)).headline).toBe(
      "12% of your usage went to tool results over 10k tokens",
    );
    expect(USAGE_BEHAVIOR_COPY.large_tool_results.body).toBe(
      "A large result is paid for again on every later request until it's compacted or cleared. Ask for narrower reads, searches and command output, or hand noisy work to a subagent.",
    );
  });

  test("pre-existing behaviours keep the CLI copy", () => {
    expect(USAGE_BEHAVIOR_COPY.cache_miss.headline(15)).toBe("15% of your usage hit a >100k-token cache miss");
    expect(USAGE_BEHAVIOR_COPY.long_context.headline(15)).toBe("15% of your usage was at >150k context");
    expect(USAGE_BEHAVIOR_COPY.subagent_heavy.headline(15)).toBe("15% of your usage came from subagent-heavy sessions");
    expect(USAGE_BEHAVIOR_COPY.subagent_heavy.body).toContain("spawning them — and consider");
    expect(USAGE_BEHAVIOR_COPY.high_parallel.headline(15)).toBe("15% of your usage was while 4+ sessions ran in parallel");
    expect(USAGE_BEHAVIOR_COPY.cron.headline(15)).toBe("15% of your usage came from sessions active for 8+ hours");
  });
});
