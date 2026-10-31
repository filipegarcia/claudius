#!/usr/bin/env node
// Golden fixture for the cron next-fire helpers (S11b): `lib/shared/cron.ts`
// on cron-parser 5.5.0 + luxon.
//
//   node rust/scripts/cron-golden.mjs      (node@22)
//
// The helpers resolve cron in the process's local zone unless given a `tz`,
// so the recorder re-runs itself once per zone with `TZ` set, under
// `--experimental-transform-types` (the .ts source is imported as is).
// Records:
// - `validateCron` over valid and invalid expressions (zone-independent);
// - `nextFires(cron, 5, from)` for every expression × start instant, per
//   local zone (an expression cron-parser rejects yields `[]`);
// - `nextFireAfter(cron, anchor, now, tz?)` over the DST cases of
//   `tests/unit/cc-parity-2.1.299-schedule-dst.test.ts` and more, with and
//   without an explicit `tz`.
//
// Written to rust/crates/claudius-core/tests/fixtures/cron_golden.json and
// replayed by crates/claudius-core/tests/cron_golden.rs.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "crates/claudius-core/tests/fixtures/cron_golden.json");

const ZONES = [
  "UTC",
  "America/New_York",
  "Europe/Lisbon",
  "Asia/Kolkata",
  "Australia/Lord_Howe",
  "Pacific/Chatham",
  "America/Sao_Paulo",
];

const VALID = [
  "* * * * *",
  "*/5 * * * *",
  "0 * * * *",
  "0 9 * * *",
  "0 9 * * 1-5",
  "0 9 * * 1",
  "30 1 * * *",
  "*/30 1 * * *",
  "0 2 * * *",
  "30 2 * * *",
  "15 2-3 * * *",
  "0 0 1 * *",
  "0 0 31 * *",
  "0 0 L * *",
  "0 0 * * 5L",
  "0 0 * * 1#2",
  "0 0 29 2 *",
  "0 12 1,15 * 1",
  "0 0 * * 7",
  "0 0 * * sun",
  // A duplicate `0` passes the duplicate check (it's falsy), and only the
  // first duplicate is looked at.
  "0,0 * * * *",
  "0 0,0 * * *",
  "0,0,5,5 * * * *",
  "0 0 * * 0,7",
  "0 0 * * 7,sun",
  "0 0 * * 0-0,0",
  "0 0 * * 7-7,0",
  "0 0 1 jan *",
  "0 0 * JAN-MAR MON-FRI",
  "5,10-20/5 * * * *",
  "0 */2 * * *",
  "0 0 */3 * *",
  "0 1-5/2 * * *",
  "1-59/15 * * * *",
  "59 23 31 12 *",
  "0 0 * * 0,6",
  "0 0 ? * *",
  "0 0 * * ?",
  "3/20 * * * *",
  "0 0 L 2 *",
  "0 0 * * 0L",
  "0 0 * * 7L",
  "0 0 * * 5#5",
  "0 0 1-7 * 1",
  "0 0 1 */2 *",
  "0 0,12 * * *",
  "  0  9 * * *  ",
  "0\t9 * * *",
  "0 0 1,L * *",
  "0 0 L * 1",
  "0 0 * * 1,5L",
  "0 0 13 * 5",
  "0 0 29 2 1",
  "0 0 31 */2 *",
  // No February has a fifth Monday until 2044: the search runs out of steps
  // and returns where it stopped.
  "0 0 * 2 1#5",
  "0 0 * * 6#5",
  "0 0 L/2 * *",
  "0 0 * * 1-7",
  "0 0 * * 5-7/2",
  "0 22-2 * * *",
  "0 0 * * Sun-Sat",
  // The `#` occurrence is `+text`: these pass (`2.5` never matches).
  "0 0 * * 1#0x2",
  "0 0 * * 1#2.0",
  "0 0 * * 1#+2",
  "0 0 * * 1#2e0",
  "0 0 * * 1#.2e1",
  "0 0 * * 1#2.5",
  "0 0 * * 1#",
  // `?` is a wildcard, so the other day field alone decides.
  "0 0 1 * ?",
  "0 0 ? * 1",
  "0 0 12L * *",
  "0 0 123L * *",
  "0 0 1,1L * *",
];
// Accepted only through the parser (not 5 fields, so `validateCron` refuses
// them, but `nextFires` runs them).
const PARSER_ONLY = [
  "@daily",
  "@weekly",
  "@hourly",
  "@yearly",
  "@monthly",
  "@weekdays",
  "@weekends",
  "0 0 0 * * *",
  "*/10 * * * * *",
  "30 30 1 * * *",
  "* * *",
  "",
];
const INVALID = [
  "",
  // A weekday range ending on 0 or 7 starts its list with 0, once.
  "0 0 * * 0-7,1",
  "0 0 * * *,1",
  "   ",
  "* * * *",
  "* * * * * *",
  "* * * * * * *",
  "60 * * * *",
  "* 24 * * *",
  "* * 0 * *",
  "* * 32 * *",
  "* * * 13 *",
  "* * * 0 *",
  "* * * * 8",
  "a * * * *",
  "*/0 * * * *",
  "5-1 * * * *",
  "* * * foo *",
  "* * * * mon-xyz",
  "1,,2 * * * *",
  ",1 * * * *",
  "1/2/3 * * * *",
  "* * * * 1#6",
  "* * * * 1#0",
  "* * * * 1#2,3",
  "* * * * 1-2#2",
  "* * * * 1#2#3",
  "0 0 30 2 *",
  "0 0 31 4 *",
  "1-2-3 * * * *",
  "- * * * *",
  "*/ * * * *",
  "1- * * * *",
  "-1 * * * *",
  "1.5 * * * *",
  "* * L * *",
  "L * * * *",
  "* * * * L",
  "* * 5L * *",
  "* * LW * *",
  "* * 15W * *",
  "* * * * 1,1",
  "1,1 * * * *",
  "@reboot",
  "@daily * * * *",
  "*/5-10 * * * *",
  "1-5/0 * * * *",
  "0x1 * * * *",
  "1e1 * * * *",
  "H * * * *",
  "H/15 * * * *",
  "H(0-29)/10 * * * *",
  "H(5-1) * * * *",
  "H/0 * * * *",
  "０ * * * *",
];

const FROMS = [
  "2026-01-15T10:07:33.123Z",
  "2026-03-08T06:30:00.000Z",
  "2026-03-08T07:00:00.000Z",
  "2026-11-01T05:10:00.000Z",
  "2026-11-01T06:15:00.000Z",
  "2026-03-29T00:30:00.000Z",
  "2026-10-25T00:30:00.000Z",
  "2024-02-28T23:59:59.999Z",
  "2025-12-31T23:59:00.000Z",
  "2026-04-04T14:10:00.000Z",
  "2026-10-03T15:20:00.000Z",
  "2026-04-04T13:30:00.000Z",
  "2026-09-26T13:00:00.000Z",
  "2018-11-04T02:30:00.000Z",
  "2019-02-16T23:30:00.000Z",
].map((s) => new Date(s).getTime());

// `H` is random: replayed with `Math.random()` pinned to each of these.
const HASHED = [
  "H * * * *",
  "H/15 * * * *",
  "H(0-29)/10 * * * *",
  "H(5-40)/7 * * * *",
  "H(50-59)/20 * * * *",
  "H(3-3) * * * *",
  "H H * * *",
  "0 H(9-17) * * *",
  "H/20 H/6 * * *",
  "0 0 H * *",
  "0 0 * H *",
  "0 0 * * H",
  "H * * * * *",
  "0 0 1 * H/2",
  "H,30 * * * *",
  "1-5,H * * * *",
  "xH/5 * * * *",
  "H(1-2)x * * * *",
  "H(9-2)/3 * * * *",
  "H(1-5)/0 * * * *",
  // Padding after an `H(...)` form survives into the value: a fraction
  // stays a JS number (in range, never matched), `-5` makes a range.
  "H/30.5 * * * *",
  "0 H(1-1).5 * * *",
  "H(1-1).5,30 * * * *",
  "0 0 H(2-2).5 * *",
  "0 0 * H(1-1).5 *",
  "H(1-1)-5 * * * *",
  "0 0 * * H(1-1).5",
  "H(1-1).5 * * * * *",
  "0 H(0-0).5,3 * * *",
];
const RANDOMS = [0, 0.123456789, 0.5, 0.987654321, 0.9999999999, 0.43];
const HASHED_FROMS = [FROMS[0], FROMS[3], FROMS[9]];

const ms = (s) => new Date(s).getTime();
// [cron, anchor, now, tz?]; anchor `null` = undefined, "NaN" = NaN.
const AFTER = [
  ["30 1 * * *", null, ms("2026-11-01T06:15:00Z"), "America/New_York"],
  ["30 1 * * *", ms("2026-11-01T05:30:00.300Z"), ms("2026-11-01T06:15:00Z"), "America/New_York"],
  ["30 1 * * *", ms("2026-11-01T05:30:00.300Z"), ms("2026-11-01T06:45:00Z"), "America/New_York"],
  ["*/30 1 * * *", ms("2026-11-01T05:30:00.300Z"), ms("2026-11-01T06:05:00Z"), "America/New_York"],
  ["*/30 1 * * *", ms("2026-11-01T05:00:00.300Z"), ms("2026-11-01T05:05:00Z"), "America/New_York"],
  ["0 * * * *", ms("2026-11-01T05:00:00.200Z"), ms("2026-11-01T05:01:00Z"), "America/New_York"],
  ["*/15 * * * *", ms("2026-11-01T05:45:00.200Z"), ms("2026-11-01T05:46:00Z"), "America/New_York"],
  ["*/15 * * * *", ms("2026-11-01T06:00:00.200Z"), ms("2026-11-01T06:01:00Z"), "America/New_York"],
  ["0 9 * * *", ms("2026-10-21T13:00:00Z") - 200, ms("2026-10-21T13:00:00Z") - 50, "America/New_York"],
  ["0 9 * * *", ms("2026-10-21T13:00:00Z") - 2000, ms("2026-10-21T13:00:00Z") - 50, "America/New_York"],
  ["30 1 * * *", ms("2026-11-01T06:15:00Z") - 25 * 3600 * 1000, ms("2026-11-01T06:15:00Z"), "America/New_York"],
  ["30 1 * * *", ms("2026-11-01T06:15:00Z") - 25 * 3600 * 1000 + 1, ms("2026-11-01T06:15:00Z"), "America/New_York"],
  ["30 1 * * *", ms("2026-11-01T06:15:00Z") + 1, ms("2026-11-01T06:15:00Z"), "America/New_York"],
  ["30 1 * * *", "NaN", ms("2026-11-01T06:15:00Z"), "America/New_York"],
  ["not a cron", ms("2026-11-01T05:30:00.300Z"), ms("2026-11-01T06:15:00Z"), "America/New_York"],
  ["0 2 * * *", ms("2026-03-07T07:00:00.100Z"), ms("2026-03-08T01:00:00Z"), "America/New_York"],
  ["30 2 * * *", ms("2026-03-07T07:30:00.100Z"), ms("2026-03-08T07:00:00Z"), "America/New_York"],
  ["0 * * * *", ms("2026-03-08T06:00:00.100Z"), ms("2026-03-08T06:30:00Z"), "America/New_York"],
  ["0 * * * *", ms("2026-04-04T13:00:00.200Z"), ms("2026-04-04T14:10:00Z"), "Australia/Lord_Howe"],
  ["*/30 * * * *", ms("2026-04-04T14:00:00.200Z"), ms("2026-04-04T14:10:00Z"), "Australia/Lord_Howe"],
  ["0 2 * * *", ms("2026-10-03T15:00:00.200Z"), ms("2026-10-03T15:20:00Z"), "Australia/Lord_Howe"],
  ["30 1 * * *", ms("2026-10-25T00:30:00.200Z"), ms("2026-10-25T00:40:00Z"), "Europe/Lisbon"],
  ["0 1 * * *", ms("2026-10-25T00:00:00.200Z"), ms("2026-10-25T00:40:00Z"), "Europe/Lisbon"],
  ["*/20 * * * *", ms("2026-10-25T01:00:00.200Z"), ms("2026-10-25T01:01:00Z"), "Europe/Lisbon"],
  ["45 2 * * *", ms("2026-04-04T13:45:00.200Z"), ms("2026-04-05T14:00:00Z"), "Pacific/Chatham"],
  ["0 9 * * 1-5", ms("2026-01-16T14:00:00.100Z"), ms("2026-01-16T15:00:00Z"), "UTC"],
  ["* * * * *", ms("2026-01-16T14:00:00.100Z"), ms("2026-01-16T14:00:00.500Z"), "UTC"],
  ["* * * * *", ms("2026-01-16T14:00:00.000Z"), ms("2026-01-16T14:00:00.900Z"), "UTC"],
  ["0 0 L * *", ms("2026-01-31T05:00:00.100Z"), ms("2026-02-01T00:00:00Z"), "America/New_York"],
  ["0 0 30 2 *", null, ms("2026-01-16T14:00:00Z"), "UTC"],
  // An anchor after `now` is ignored.
  ["*/5 * * * *", ms("2026-01-16T15:02:00Z"), ms("2026-01-16T14:02:00Z"), "UTC"],
  ["0 9 * * *", null, "NaN", "UTC"],
  ["0 9 * * *", null, 8.64e15 + 1, "UTC"],
  ["0 9 * * *", ms("2026-01-16T14:00:00Z"), ms("2026-01-16T14:00:00Z") + 0.75, "UTC"],
  ["0 9 * * *", ms("2026-01-16T09:00:00Z") + 0.5, ms("2026-01-16T09:00:00.700Z"), "UTC"],
];
// The `tz` forms luxon's `normalizeZone` reads, on a DST case and a plain one.
for (const tz of [
  "", "utc", "UTC", "gmt", "GMT", "Utc", "utc+5:30", "UTC-03", "utc-0:30", "utc+0", "UTC+5", "utc+12:45",
  "utc+5:3", "utc+", "utc+123", "america/new_york", "AMERICA/NEW_YORK", "US/Eastern", "EST5EDT", "Etc/GMT+5",
  "+05:30", "+0530", "+05", "-03:00", "\u221205:00", "+23:59", "+24:00", "+5:30", "+05:30:00", "Z",
  "local", "default", "system", "Local", "Not/AZone", "Asia/Calcutta", "europe/lisbon",
]) {
  AFTER.push(["30 1 * * *", ms("2026-11-01T05:30:00.300Z"), ms("2026-11-01T06:15:00Z"), tz]);
  AFTER.push(["0 9 * * *", null, ms("2026-01-16T14:00:00Z"), tz]);
}
// `nextFires` from an invalid date.
const EDGE_FROMS = ["NaN", 8.64e15 + 1, -8.64e15 - 1, "Infinity"];

if (!process.env.CRON_GOLDEN_CHILD) {
  const zones = {};
  for (const zone of ZONES) {
    const r = spawnSync(
      process.execPath,
      ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url)],
      { encoding: "utf8", maxBuffer: 1 << 28, env: { ...process.env, TZ: zone, CRON_GOLDEN_CHILD: zone } },
    );
    if (r.status !== 0) {
      process.stderr.write(r.stderr);
      process.exit(r.status ?? 1);
    }
    zones[zone] = JSON.parse(r.stdout);
  }
  const first = zones[ZONES[0]];
  const fixture = {
    validate: first.validate,
    froms: FROMS,
    expressions: [...VALID, ...PARSER_ONLY, ...INVALID],
    nextFires: Object.fromEntries(ZONES.map((z) => [z, zones[z].nextFires])),
    // Per local zone even with an explicit `tz`: a stalled iterator falls
    // back to `nextFireMs` from now, in the local zone.
    after: Object.fromEntries(ZONES.map((z) => [z, zones[z].after])),
    afterLocal: Object.fromEntries(ZONES.map((z) => [z, zones[z].afterLocal])),
    hashed: Object.fromEntries(ZONES.map((z) => [z, zones[z].hashed])),
    edges: first.edges,
    anchorMaxAgeMs: first.anchorMaxAgeMs,
  };
  for (const z of ZONES) {
    if (JSON.stringify(zones[z].validate) !== JSON.stringify(first.validate)) throw new Error(`validate differs in ${z}`);
    if (JSON.stringify(zones[z].edges) !== JSON.stringify(first.edges)) throw new Error(`edges differ in ${z}`);
  }
  writeFileSync(out, JSON.stringify(fixture) + "\n");
  console.log(
    `wrote ${out}: ${fixture.expressions.length} expressions × ${FROMS.length} starts × ${ZONES.length} zones, ` +
      `${HASHED.length} hashed × ${RANDOMS.length} randoms, ${AFTER.length} nextFireAfter cases`,
  );
  process.exit(0);
}

const cron = await import(pathToFileURL(join(repo, "lib/shared/cron.ts")).href);
const anchorOf = (a) => (a === null ? undefined : typeof a === "string" ? Number(a) : a);
const expressions = [...VALID, ...PARSER_ONLY, ...INVALID];
const result = {
  validate: [...VALID, ...PARSER_ONLY, ...INVALID].map((input) => ({ input, got: cron.validateCron(input) })),
  nextFires: expressions.map((expr) =>
    expr.includes("H") ? null : FROMS.map((from) => cron.nextFires(expr, 5, new Date(from)).map((d) => d.getTime())),
  ),
  after: AFTER.map(([c, a, now, tz]) => cron.nextFireAfter(c, anchorOf(a), anchorOf(now), tz)),
  afterLocal: AFTER.map(([c, a, now]) => cron.nextFireAfter(c, anchorOf(a), anchorOf(now))),
  hashed: HASHED.map((expr) =>
    RANDOMS.map((r) =>
      HASHED_FROMS.map((from) => {
        const real = Math.random;
        Math.random = () => r;
        try {
          return cron.nextFires(expr, 5, new Date(from)).map((d) => d.getTime());
        } finally {
          Math.random = real;
        }
      }),
    ),
  ),
  edges: EDGE_FROMS.map((from) => ({
    from,
    got: cron.nextFires("* * * * *", 5, new Date(anchorOf(from))).map((d) => d.getTime()),
  })),
  anchorMaxAgeMs: cron.FIRE_ANCHOR_MAX_AGE_MS,
};
result.hashed = { expressions: HASHED, randoms: RANDOMS, froms: HASHED_FROMS, got: result.hashed };
// The cases, for the replay.
result.after = AFTER.map((c, i) => ({ cron: c[0], anchor: c[1], now: c[2], tz: c[3], got: result.after[i] }));
process.stdout.write(JSON.stringify(result));
