#!/usr/bin/env node
// Golden fixture for the reaper's loop keep-alive (S11c):
// `lib/server/loop-keepalive.ts` (`isLoopArmed`, `hasArmedLoop`).
//
//   node rust/scripts/keepalive-golden.mjs     (node@22)
//
// Re-runs itself under `--experimental-transform-types` with
// TZ=America/New_York (a one-shot cron's first fire is resolved in the local
// zone), with a resolve hook for the `@/` imports. Records `isLoopArmed`
// for wake-ups and session crons around every edge (the tick grace, the
// 7-day cap, a one-shot cron's first fire, a DST day), and `hasArmedLoop`
// over a few lists.
//
// Written to rust/crates/claudius-core/tests/fixtures/keepalive_golden.json
// and replayed by crates/claudius-core/tests/keepalive_golden.rs.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { register } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "crates/claudius-core/tests/fixtures/keepalive_golden.json");
const ZONE = "America/New_York";

if (!process.env.KEEPALIVE_GOLDEN_CHILD) {
  const r = spawnSync(
    process.execPath,
    ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url)],
    { encoding: "utf8", maxBuffer: 1 << 26, env: { ...process.env, TZ: ZONE, KEEPALIVE_GOLDEN_CHILD: "1" } },
  );
  if (r.status !== 0) {
    process.stderr.write(r.stderr);
    process.exit(r.status ?? 1);
  }
  const fixture = JSON.parse(r.stdout);
  writeFileSync(out, JSON.stringify(fixture) + "\n");
  console.log(`wrote ${out}: ${fixture.cases.length} loops, ${fixture.cases.reduce((n, c) => n + c.nows.length, 0)} checks, ${fixture.lists.length} lists`);
  process.exit(0);
}

const hook = `
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
const ROOT = ${JSON.stringify(pathToFileURL(repo + "/").href)};
export async function resolve(spec, ctx, next) {
  const s = spec.startsWith("@/") ? new URL(spec.slice(2), ROOT).href : spec;
  if ((s.startsWith(".") || s.startsWith("file:")) && ctx.parentURL) {
    const p = fileURLToPath(new URL(s, ctx.parentURL));
    if (!existsSync(p)) {
      for (const ext of [".ts", ".tsx", "/index.ts"]) {
        if (existsSync(p + ext)) return next(pathToFileURL(p + ext).href, ctx);
      }
    }
  }
  return next(s, ctx);
}`;
register(`data:text/javascript,${encodeURIComponent(hook)}`);

const keepalive = await import(pathToFileURL(join(repo, "lib/server/loop-keepalive.ts")).href);
const { nextFireMs } = await import(pathToFileURL(join(repo, "lib/shared/cron.ts")).href);
const { isLoopArmed, hasArmedLoop, LOOP_TICK_GRACE_MS: GRACE, LOOP_KEEPALIVE_MAX_MS: MAX } = keepalive;

const ms = (s) => new Date(s).getTime();
const T0 = ms("2026-01-15T10:07:33Z");
const wakeup = (over) => ({
  kind: "wakeup", id: "w", toolUseId: "w", cron: null, humanSchedule: null, delaySeconds: 90,
  prompt: "/loop", recurring: false, durable: false, startedAt: T0, cancelled: false, ...over,
});
const cron = (over) => ({
  kind: "cron", id: "c", toolUseId: "c", cron: "*/5 * * * *", humanSchedule: null, delaySeconds: null,
  prompt: "p", recurring: false, durable: false, startedAt: T0, cancelled: false, ...over,
});
const LOOPS = [
  wakeup({}),
  wakeup({ delaySeconds: null }),
  wakeup({ delaySeconds: 0 }),
  wakeup({ delaySeconds: 1.5 }),
  wakeup({ delaySeconds: -5 }),
  wakeup({ delaySeconds: 1e9 }),
  wakeup({ delaySeconds: 3600 }),
  wakeup({ cancelled: true }),
  wakeup({ delaySeconds: 60, recurring: true }),
  cron({ recurring: true }),
  cron({ recurring: true, cancelled: true }),
  cron({ recurring: true, cron: "" }),
  cron({}),
  cron({ cron: "0 9 * * *" }),
  cron({ cron: "0 9 * * 1-5", startedAt: ms("2026-01-16T15:00:00Z") }),
  cron({ cron: "" }),
  cron({ cron: null }),
  cron({ cron: "not a cron" }),
  cron({ cron: "0 0 30 2 *" }),
  cron({ cron: "0 0 29 2 *" }),
  cron({ cron: "30 2 * * *", startedAt: ms("2026-03-08T05:00:00Z") }),
  cron({ cron: "30 1 * * *", startedAt: ms("2026-11-01T05:10:00Z") }),
  cron({ cron: "@hourly" }),
  cron({ cron: "*/5 * * * *", cancelled: true }),
];

// Every edge each loop can have, around `startedAt`.
function nowsFor(loop) {
  const s = loop.startedAt;
  const offsets = [-60_000, -1, 0, 1, 60_000, GRACE - 1, GRACE, GRACE + 1, 3_600_000, MAX - 1, MAX, MAX + 1, 30 * 86_400_000];
  const nows = offsets.map((o) => s + o);
  if (typeof loop.delaySeconds === "number") {
    const due = loop.startedAt + loop.delaySeconds * 1000 + GRACE;
    nows.push(Math.floor(due) - 1, Math.floor(due), Math.ceil(due), Math.ceil(due) + 1);
  }
  if (loop.cron) {
    const first = nextFireMs(loop.cron, new Date(loop.startedAt));
    if (first != null) nows.push(first, first + GRACE - 1, first + GRACE, first + GRACE + 1);
  }
  return [...new Set(nows.filter((n) => Number.isSafeInteger(n)))].sort((a, b) => a - b);
}

const cases = LOOPS.map((loop) => {
  const nows = nowsFor(loop);
  return { loop, nows, got: nows.map((now) => isLoopArmed(loop, now)) };
});

const expired = wakeup({ id: "old", startedAt: T0 - 7_200_000 });
const LISTS = [
  [[], T0],
  [[wakeup({ cancelled: true })], T0],
  [[wakeup({ cancelled: true }), cron({ recurring: true })], T0],
  [[expired, wakeup({ delaySeconds: null })], T0],
  [[expired, cron({ cron: "0 9 * * *" })], T0],
  [[expired, cron({ recurring: true, startedAt: T0 - MAX - 1 })], T0],
];
const lists = LISTS.map(([loops, now]) => ({ loops, now, got: hasArmedLoop(loops, now) }));

process.stdout.write(JSON.stringify({ zone: ZONE, graceMs: GRACE, maxMs: MAX, cases, lists }));
