#!/usr/bin/env bun
// Golden fixture for the effort helpers the session engine uses.
//
//   bun rust/scripts/effort-golden.mjs      (bun: it imports the .ts source)
//
// Records, from the TS sources themselves:
// - `buildEffortFlagSettings(level, ultracode)` for every level the route
//   accepts, with ultracode on and off (lib/shared/effort-flags.ts);
// - `parseAppliedEffort(response)` over well-formed, malformed and
//   future-shaped `get_settings` responses. `undefined` is written as
//   `{"undefined": true}`, a value as `{"value": …}`;
// - the `LEVELS` set `POST /api/sessions/:id/effort` validates against
//   (module-private in the route, so read from its source).
//
// Written to rust/crates/claudius-core/tests/fixtures/effort_golden.json and
// replayed by crates/claudius-core/tests/effort_golden.rs.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const { buildEffortFlagSettings, parseAppliedEffort } = await import(join(repo, "lib/shared/effort-flags.ts"));

const routeSrc = readFileSync(join(repo, "app/api/sessions/[id]/effort/route.ts"), "utf8");
const m = routeSrc.match(/const LEVELS = new Set\((\[[^\]]*\])\);/);
if (!m) throw new Error("LEVELS moved in the effort route: update the pattern");
const routeLevels = JSON.parse(m[1]);

const build = [];
for (const level of routeLevels)
  for (const ultracode of [false, true]) build.push({ level, ultracode, out: buildEffortFlagSettings(level, ultracode) });

const RESPONSES = [
  null,
  undefined,
  0,
  1,
  "",
  "applied",
  true,
  [],
  [{ applied: { effort: "high" } }],
  {},
  { applied: null },
  { applied: undefined },
  { applied: 0 },
  { applied: "high" },
  { applied: true },
  { applied: [] },
  { applied: ["high"] },
  { applied: {} },
  { applied: { model: "claude-opus-4-8" } },
  { applied: { effort: null } },
  { applied: { effort: undefined } },
  ...["low", "medium", "high", "xhigh", "max"].map((effort) => ({ applied: { effort } })),
  { applied: { effort: "auto" } },
  { applied: { effort: "HIGH" } },
  { applied: { effort: " high" } },
  { applied: { effort: "ultra" } },
  { applied: { effort: "" } },
  { applied: { effort: 3 } },
  { applied: { effort: 0 } },
  { applied: { effort: false } },
  { applied: { effort: ["high"] } },
  { applied: { effort: { level: "high" } } },
  { effort: "high" },
  { effective: { effortLevel: "high" } },
  // The CLI's real shape, and the fake CLI's.
  {
    effective: { effortLevel: "xhigh", model: "opus" },
    applied: { model: "claude-opus-4-8", effort: "xhigh", advisor: null, ultracode: false },
  },
  { effective: {}, applied: { model: "fake-model", effort: null } },
];
// `undefined` doesn't survive JSON: record which inputs had it so the replay
// can rebuild them (as a missing key / missing value).
const enc = (v) => (v === undefined ? { undefined: true } : { value: v });
const parse = RESPONSES.map((response) => ({ response: enc(response), out: enc(parseAppliedEffort(response)) }));

const sdkVersion = JSON.parse(readFileSync(join(repo, "node_modules/@anthropic-ai/claude-agent-sdk/package.json"), "utf8")).version;
const file = join(rustDir, "crates/claudius-core/tests/fixtures/effort_golden.json");
writeFileSync(file, `${JSON.stringify({ sdkVersion, routeLevels, build, parse }, null, 1)}\n`);
console.log(`${build.length} build cases, ${parse.length} parse cases; wrote ${file.slice(repo.length + 1)}`);
