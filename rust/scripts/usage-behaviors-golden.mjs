#!/usr/bin/env node
// Golden fixture for the usage extras (S16): `extractUsageBehaviors`
// (lib/shared/usage-behaviors.ts), `extractWeeklyUsedSkills`
// (lib/shared/skill-usage.ts), and the `/context` route's
// `{ ...data, weeklyUsedSkills }` merge.
//
//   node rust/scripts/usage-behaviors-golden.mjs     (node@22)
//
// Re-runs itself under `--experimental-transform-types` and imports the real
// TS modules. Every input is a JSON text, parsed by `JSON.parse` here and by
// serde_json in the replay, and every output is recorded as the
// `JSON.stringify` text the route would send.
//
// Written to rust/crates/claudius-core/tests/fixtures/usage_behaviors_golden.json
// and replayed by crates/claudius-core/tests/usage_behaviors_golden.rs.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "crates/claudius-core/tests/fixtures/usage_behaviors_golden.json");

if (!process.env.USAGE_BEHAVIORS_GOLDEN_CHILD) {
  const run = () => {
    const r = spawnSync(
      process.execPath,
      ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url)],
      { encoding: "utf8", maxBuffer: 1 << 26, env: { ...process.env, USAGE_BEHAVIORS_GOLDEN_CHILD: "1" } },
    );
    if (r.status !== 0) {
      process.stderr.write(r.stderr);
      process.exit(r.status ?? 1);
    }
    return r.stdout;
  };
  const first = run();
  if (run() !== first) {
    console.error("recording is not stable");
    process.exit(1);
  }
  const fixture = JSON.parse(first);
  writeFileSync(out, JSON.stringify(fixture, null, 1) + "\n");
  console.log(
    `wrote ${out}: ${fixture.usage.length} usage responses, ${fixture.context.length} context merges (stable)`,
  );
  process.exit(0);
}

const behaviorsMod = await import(pathToFileURL(join(repo, "lib/shared/usage-behaviors.ts")).href);
const skillsMod = await import(pathToFileURL(join(repo, "lib/shared/skill-usage.ts")).href);
const { extractUsageBehaviors, USAGE_BEHAVIOR_COPY } = behaviorsMod;
const { extractWeeklyUsedSkills } = skillsMod;

const J = (v) => JSON.stringify(v);
const win = (over) => ({ request_count: 10, session_count: 2, behaviors: [], ...over });
const usage = (day, week) => J({ behaviors: { day, week } });
const one = (b) => usage(win({ behaviors: [b] }), win({}));
const skills = (list) => J({ behaviors: { day: win({}), week: { ...win({}), skills: list } } });

// Usage responses, as the JSON text the CLI would send.
const USAGE = [
  // The TS unit test's response.
  J({
    behaviors: {
      day: { request_count: 10, session_count: 1, behaviors: [{ key: "max_effort", pct: 40, count: 4 }], skills: [] },
      week: {
        request_count: 50,
        session_count: 3,
        behaviors: [{ key: "workflow", pct: 25, count: 12 }],
        skills: [{ name: "pdf", pct: 12 }],
      },
    },
  }),
  // The fake CLI's default (no `behaviors`).
  J({ session: { total_cost_usd: 0 }, subscription_type: null, rate_limits_available: false, rate_limits: {} }),
  // Not an object, or no usable section.
  "null", "0", "5", "true", "false", '"behaviors"', "[]", "[1,2]", "{}",
  J({ behaviors: null }), J({ behaviors: 0 }), J({ behaviors: 1 }), J({ behaviors: "" }), J({ behaviors: "day" }),
  J({ behaviors: true }), J({ behaviors: [] }), J({ behaviors: [win({}), win({})] }), J({ behaviors: {} }),
  J({ behaviors: { day: win({}) } }), J({ behaviors: { week: win({}) } }),
  J({ __proto__: null, behaviors: { day: win({}), week: win({}) } }),
  '{"__proto__": {"behaviors": {"day": {}, "week": {}}}}',
  // Window shapes: objects and arrays pass, everything else is null.
  usage({}, {}), usage([], []), usage([1, 2], {}), usage({}, [[]]),
  usage(null, {}), usage({}, null), usage(0, {}), usage({}, 1), usage("", {}), usage({}, "w"),
  usage(true, {}), usage({}, false),
  // Counts: finite numbers pass through, the rest are 0.
  usage(win({ request_count: 1.5, session_count: -3 }), win({ request_count: 0, session_count: 1e300 })),
  usage(win({ request_count: "7", session_count: null }), win({ request_count: true, session_count: [] })),
  usage(win({ request_count: {}, session_count: undefined }), win({})),
  usage({ behaviors: [] }, { request_count: 3 }),
  '{"behaviors":{"day":{"request_count":1.0,"session_count":1e2,"behaviors":[]},"week":{"request_count":-0,"session_count":0.1e1,"behaviors":[]}}}',
  '{"behaviors":{"day":{"request_count":1e21,"session_count":1E+21,"behaviors":[]},"week":{"request_count":9007199254740993,"session_count":123456789012345678901234567890,"behaviors":[]}}}',
  '{"behaviors":{"day":{"request_count":1e-7,"session_count":-1.5e-10,"behaviors":[]},"week":{"request_count":0.000001,"session_count":-0.0,"behaviors":[]}}}',
  // Every known key, in order.
  usage(win({ behaviors: Object.keys(USAGE_BEHAVIOR_COPY).map((key, i) => ({ key, pct: i * 7.5, count: i })) }), win({})),
  // Unknown or odd keys.
  ...["foo", "MAX_EFFORT", " max_effort", "max_effort ", "max-effort", "", "__proto__", "constructor", "toString",
    "hasOwnProperty", "valueOf", "headline", "body"].map((key) => one({ key, pct: 50, count: 1 })),
  one({ key: 1, pct: 50, count: 1 }), one({ key: null, pct: 50 }), one({ key: ["cron"], pct: 50 }),
  one({ key: { cron: 1 }, pct: 50 }), one({ pct: 50, count: 1 }),
  // pct: a finite number, else dropped.
  ...[0, -5, 12.75, 100, 250, 1e-9, "40", null, true, [40], { v: 40 }].map((pct) => one({ key: "cron", pct, count: 2 })),
  one({ key: "cron", count: 2 }),
  '{"behaviors":{"day":{"behaviors":[{"key":"cron","pct":1.0,"count":2.0},{"key":"cron","pct":-0,"count":-0},{"key":"cron","pct":1e21,"count":1e21},{"key":"cron","pct":5e-324,"count":1.7976931348623157e308}]},"week":{}}}',
  // count: a finite number, else 0.
  ...["4", null, true, [], {}, 2.5, -1].map((count) => one({ key: "workflow", pct: 30, count })),
  one({ key: "workflow", pct: 30 }),
  // Entries that aren't objects; extra fields; duplicates and order.
  usage(win({ behaviors: [null, 0, 1, "", "cron", true, [], ["cron", 50, 1], { key: "cron", pct: 9, count: 1 }] }), win({})),
  usage(win({ behaviors: [{ key: "cron", pct: 9, count: 1, extra: "x", headline: "h" }] }), win({ extra: 1 })),
  usage(win({ behaviors: [{ key: "cron", pct: 9, count: 1 }, { key: "cron", pct: 3, count: 0 }, { key: "workflow", pct: 99, count: 9 }] }), win({})),
  '{"behaviors":{"day":{"behaviors":[{"count":3,"pct":7,"key":"cron"}],"session_count":2,"request_count":1},"week":{}}}',
  // `behaviors` that isn't an array.
  usage(win({ behaviors: null }), win({ behaviors: { 0: { key: "cron", pct: 1, count: 1 } } })),
  usage(win({ behaviors: "cron" }), win({ behaviors: 3 })),
  // Duplicate JSON keys: the last one wins.
  '{"behaviors":{"day":{"request_count":1,"request_count":2,"behaviors":[]},"week":{"behaviors":[{"key":"cron","key":"workflow","pct":1,"pct":2}]}},"behaviors":{"day":{},"week":{"request_count":9}}}',
  // Skills (`behaviors.week.skills`).
  skills([{ name: "pdf", pct: 12 }, { name: "docx", pct: 0 }, { name: "xlsx", pct: -1 }, { name: "pptx" }]),
  skills([{ name: "a", pct: "0" }, { name: "b", pct: null }, { name: "c", pct: true }, { name: "d", pct: [] }, { name: "e", pct: {} }]),
  skills([{ name: "", pct: 5 }, { name: 5, pct: 5 }, { pct: 5 }, { name: null }, { name: ["x"] }, { name: { n: 1 } }]),
  skills([null, 0, "pdf", [], ["pdf", 1], true, { name: "ok", pct: 1e-300 }, { name: "big", pct: 1e300 }]),
  skills([{ name: "dup", pct: 1 }, { name: "dup", pct: 2 }, { name: "Dup", pct: 3 }]),
  skills([{ name: " spaced ", pct: 1 }, { name: "\u00e9t\u00e9", pct: 1 }, { name: "\ud83d\ude00", pct: 1 }, { name: "a".repeat(5000), pct: 1 }]),
  '{"behaviors":{"day":{},"week":{"skills":[{"name":"neg0","pct":-0},{"name":"zero","pct":0.0},{"name":"tiny","pct":5e-324},{"name":"exp","pct":1e2}]}}}',
  J({ behaviors: { day: { skills: [{ name: "day-only", pct: 9 }] }, week: {} } }),
  J({ behaviors: { week: { skills: [{ name: "no-day", pct: 9 }] } } }),
  J({ behaviors: { week: { skills: { 0: { name: "obj", pct: 1 } } } } }),
  J({ behaviors: { week: { skills: "pdf" } } }), J({ behaviors: { week: { skills: null } } }),
  J({ behaviors: { week: [{ skills: [{ name: "arr", pct: 1 }] }] } }), J({ behaviors: { week: "skills" } }),
  J({ behaviors: [{ week: { skills: [{ name: "arr", pct: 1 }] } }] }),
  J({ behaviors: null, week: { skills: [{ name: "top", pct: 1 }] } }),
];

// `getContextUsage` data, merged as the full `/context` fetch does.
const CONTEXT = [
  "{}", J({ totalTokens: 1200, maxTokens: 200000, percentage: 0.6, categories: [{ name: "Skills", tokens: 30 }] }),
  J({ weeklyUsedSkills: 5, a: 1 }), J({ a: 1, weeklyUsedSkills: "x" }),
  '{"b":1,"2":2,"1":3,"10":4,"01":5,"-1":6,"4294967294":7,"4294967295":8}',
  '{"n":1.0,"e":1e2,"big":1e21,"tiny":1e-7,"neg":-0,"nested":{"2":1,"1":2,"x":3.50}}',
  "null", "[]", "[1,2]", '[{"a":1}]', '"ab"', '""', "5", "0", "true", "false",
  '{"a":1,"a":2}', '{"__proto__":{"x":1},"a":1}', '{"weeklyUsedSkills":null}',
];
const WEEKLY = [null, [], ["pdf"], ["pdf", "pdf", "\u00e9"]];

const usageCases = USAGE.map((text) => {
  const data = JSON.parse(text);
  return { text, behaviors: J(extractUsageBehaviors(data)), skills: J(extractWeeklyUsedSkills(data)) };
});
const contextCases = CONTEXT.map((text) => {
  const data = JSON.parse(text);
  return {
    text,
    summary: J(data),
    full: WEEKLY.map((weeklyUsedSkills) => ({ weeklyUsedSkills, body: J({ ...data, weeklyUsedSkills }) })),
  };
});

process.stdout.write(
  J({ keys: Object.keys(USAGE_BEHAVIOR_COPY), usage: usageCases, context: contextCases }),
);
