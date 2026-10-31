#!/usr/bin/env node
// Golden fixture for the historical usage estimate (S17): `priceFor` /
// `costFromTokens` / `inferenceGeoMultiplier` (lib/shared/cost-pricing.ts)
// and the real `Session.prototype.seedUsageBaseline` (lib/server/session.ts)
// with its `session_usage` row (lib/server/session-usage-db.ts).
//
//   node rust/scripts/usage-estimate-golden.mjs     (node@22: session.ts needs
//                                                    better-sqlite3)
//
// Re-runs itself under `--experimental-transform-types` with HOME and
// CLAUDE_CONFIG_DIR in a temp root and a resolve hook for the `@/` and
// extensionless imports, twice (two temp roots); both recordings must agree
// byte for byte. Records:
//
// - `prices`: `priceFor(model)` for odd model ids.
// - `costs`: `costFromTokens(model, tokens)`, as `JSON.stringify` text.
// - `geo`: `inferenceGeoMultiplier(geo)`.
// - `seeds`: `seedUsageBaseline()` on a bare session object (its own cwd, id,
//   resumeFrom, zero totals and checkpoint) over transcript `files` written
//   under the project root first (`text`, raw bytes as `hex`, or a `symlink`), and
//   optionally a `persisted` `session_usage` row saved first. Each case
//   records the resulting `totals`, the restored `checkpoint`
//   (`sdkLastCumulative`) and the row `getSessionUsage` reads afterwards
//   (`row`, or null), all as `JSON.stringify` text.
// - `folds`: `foldResultIntoSessionUsage(totals, last, message)` over a
//   sequence of SDK result messages: each step's `{totals, last}` as
//   `JSON.stringify` text, or null when the frame carries no usage.
// - `costStates`: `lastRecordedCostState(id, cwd)` for odd ids over one
//   project's `files`.
//
// Written to rust/crates/claudius-core/tests/fixtures/usage_estimate_golden.json
// and replayed by crates/claudius-core/tests/usage_estimate_golden.rs.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "crates/claudius-core/tests/fixtures/usage_estimate_golden.json");

if (!process.env.USAGE_ESTIMATE_GOLDEN_CHILD) {
  const runs = [0, 1].map(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "usage-estimate-golden-")));
    try {
      const home = join(root, "home");
      mkdirSync(home);
      mkdirSync(join(root, "project"));
      const r = spawnSync(
        process.execPath,
        ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url)],
        {
          // `openDb` reads its migrations from `process.cwd()`.
          cwd: repo,
          encoding: "utf8",
          maxBuffer: 1 << 26,
          env: {
            PATH: process.env.PATH,
            HOME: home,
            CLAUDE_CONFIG_DIR: join(root, "config"),
            USAGE_ESTIMATE_GOLDEN_CHILD: root,
          },
        },
      );
      if (r.status !== 0) {
        process.stderr.write(r.stderr);
        process.exit(r.status ?? 1);
      }
      return readFileSync(join(root, "out.json"), "utf8");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  if (runs[0] !== runs[1]) throw new Error("the two recordings differ");
  const fixture = JSON.parse(runs[0]);
  writeFileSync(out, `${JSON.stringify(fixture, null, 1)}\n`);
  console.log(
    `wrote ${out.slice(repo.length + 1)}: ${fixture.prices.length} prices, ${fixture.costs.length} costs, ${fixture.seeds.length} seeds, ${fixture.folds.length} folds (stable)`,
  );
  process.exit(0);
}

const ROOT_DIR = process.env.USAGE_ESTIMATE_GOLDEN_CHILD;

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
  try {
    return await next(s, ctx);
  } catch (e) {
    if (e?.code === "ERR_MODULE_NOT_FOUND" && !s.includes(":") && !s.startsWith(".")) return next(s + ".js", ctx);
    throw e;
  }
}
export async function load(url, ctx, next) {
  if (url.endsWith(".json")) {
    return next(url, { ...ctx, importAttributes: { ...ctx.importAttributes, type: "json" } });
  }
  return next(url, ctx);
}`;
register(`data:text/javascript,${encodeURIComponent(hook)}`);

const { Session, zeroSessionUsage } = await import(join(repo, "lib/server/session.ts"));
const { getSessionUsage, saveSessionUsage } = await import(join(repo, "lib/server/session-usage-db.ts"));
const { priceFor, costFromTokens, inferenceGeoMultiplier, MODEL_PRICING_MULTIPLIER_MAX } = await import(
  join(repo, "lib/shared/cost-pricing.ts")
);

const J = (v) => JSON.stringify(v);

// \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 pricing \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const MODELS = [
  undefined, null, "", "claude-opus-5-5", "claude-opus-5-5-20260301", "Claude-OPUS-5-5", "claude-opus-5",
  "claude-opus-5-1", "claude-opus-4-7", "claude-3-opus", "opus", "claude-haiku-5-5", "claude-haiku-5",
  "us.anthropic.claude-haiku-5-5-v1:0", "claude-haiku-4-5", "claude-3-5-haiku", "claude-fable-5-1",
  "claude-fable-5.1", "claude-fable-5", "claude-fable-5-15", "fable", "claude-sonnet-5-5", "claude-sonnet-5.5",
  "claude-sonnet-5", "claude-sonnet-5-1", "claude-sonnet-4-5", "claude-3-7-sonnet", "gpt-4o", "<synthetic>",
  "anthropic/claude-opus-5-5", "opus-5-5-haiku", "haiku-sonnet", "sonnet-opus", "fable-opus", "OPUS-5-5",
  "claude-opus-5-5[1m]", "  claude-haiku-5-5  ", "claude-opus\u20115-5", "\u0130opus",
];
const prices = MODELS.map((model) => ({ model: model ?? null, missing: model === undefined, pricing: priceFor(model) }));

const TOKENS = [
  { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
  { input: 1, output: 1, cacheRead: 1, cacheWrite5m: 1, cacheWrite1h: 1 },
  { input: 1234, output: 567, cacheRead: 89012, cacheWrite5m: 3456, cacheWrite1h: 0 },
  { input: 3, output: 7, cacheRead: 0.5, cacheWrite5m: 1e-3, cacheWrite1h: 2 },
  { input: 1e9, output: 2.5e8, cacheRead: 7e10, cacheWrite5m: 3e7, cacheWrite1h: 9e6 },
  { input: -100, output: 50, cacheRead: -0, cacheWrite5m: 0, cacheWrite1h: 0 },
  { input: 9007199254740993, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
  { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite5m: 0.4, cacheWrite1h: 0.5 },
  // Sums whose rounding depends on the addition order.
  { input: 525947.1, output: 97597, cacheRead: 9995352, cacheWrite5m: 68752, cacheWrite1h: 585 },
  { input: 83604451, output: 4285657, cacheRead: 7480918170, cacheWrite5m: 8892593, cacheWrite1h: 30414 },
  { input: 74187996253836004, output: 71281109351170637, cacheRead: 4679204548, cacheWrite5m: 7540, cacheWrite1h: 0 },
];
const costs = [];
for (const model of MODELS) {
  for (const tokens of TOKENS) {
    costs.push({ model: model ?? null, missing: model === undefined, tokens, cost: J(costFromTokens(model, tokens)) });
  }
}
const geo = [undefined, null, "", "us", "US", "Us", " us", "us ", "eu", "not_available", "usa", "\u0130"].map((g) => ({
  geo: g ?? null,
  missing: g === undefined,
  multiplier: inferenceGeoMultiplier(g),
}));

// ----------------------------- seeds -----------------------------
//
// `seedUsageBaseline()` on a bare session object (cwd, id, resumeFrom, zero
// totals and checkpoint): the checkpoint the resumed CLI restores
// (`lastRecordedCostState`), then the persisted `session_usage` row or the
// transcript estimate (`estimateSessionUsageFromTranscripts`: the main
// `<resume>.jsonl` plus every `*.jsonl` under `<resume>/subagents/`). Each
// case writes its files under the project root first; the fixture keeps them
// (`text`, `hex` for raw bytes, or `symlink`) for the replay.

const { projectRoot } = await import(join(repo, "lib/server/db.ts"));
const { zeroSdkCumulativeUsage, foldResultIntoSessionUsage } = await import(join(repo, "lib/server/session.ts"));
const { lastRecordedCostState } = await import(join(repo, "lib/server/sdk-cost-state.ts"));
const { mkdirSync: mkdirp, symlinkSync } = await import("node:fs");

const usage = (input, output, cacheRead, cacheWrite) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheWrite,
});
const asst = (over = {}) => ({
  type: "assistant",
  uuid: over.uuid ?? "a-uuid",
  requestId: "requestId" in over ? over.requestId : "req_1",
  message: { id: "msg_1", model: "claude-opus-5-5", usage: usage(10, 20, 300, 40), ...over.message },
  ...Object.fromEntries(Object.entries(over).filter(([k]) => !["message", "uuid", "requestId"].includes(k))),
});
const user = { type: "user", uuid: "u-1", message: { role: "user", content: "hi" } };
const lines = (records) => records.map((r) => (typeof r === "string" ? r : J(r))).join("\n") + "\n";
const costState = (sessionId, cost, extra = {}) => ({
  type: "cost-state",
  sessionId,
  totalCostUSD: cost,
  totalAPIDuration: cost * 1000,
  totalAPIDurationWithoutRetries: cost * 1000,
  totalToolDuration: 0,
  totalLinesAdded: 0,
  totalLinesRemoved: 0,
  totalDuration: 0,
  startTime: 1,
  modelUsage: {
    "claude-opus-5-5": {
      inputTokens: 1, outputTokens: 2, thinkingTokens: 1, cacheReadInputTokens: 3,
      cacheCreationInputTokens: 4, webSearchRequests: 0, costUSD: cost,
    },
  },
  hasUnknownModelCost: false,
  ...extra,
});
const many = Array.from({ length: 60 }, (_, i) =>
  asst({
    uuid: `u${i}`,
    requestId: `req_${i % 45}`,
    message: {
      id: `msg_${i % 45}`,
      model: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1", "claude-opus-4-7", undefined][i % 6],
      usage: { ...usage(i * 37 + 0.25, i * 11, i * 1013, i % 7 === 0 ? 0 : i * 97),
        ...(i % 4 === 0 ? { cache_creation: { ephemeral_5m_input_tokens: i, ephemeral_1h_input_tokens: i * 96 } } : {}) },
    },
  }),
);

// [name, files (rel -> records | text | {hex} | {symlink}), opts]
// `R` is the resumed id; files are relative to the project root.
const R = "res-0001";
const SEEDS = [
  ["fresh session: nothing read", {}, { resume: null }],
  ["no transcript", {}],
  ["only users", { [`${R}.jsonl`]: [user, { ...user, uuid: "u-2" }] }],
  ["one call", { [`${R}.jsonl`]: [user, asst()] }],
  ["content-block splits dedupe by message id + request id", { [`${R}.jsonl`]: [user, asst({ uuid: "s1" }), asst({ uuid: "s2" }), asst({ uuid: "s3" })] }],
  ["same id, other request id: distinct", { [`${R}.jsonl`]: [asst(), asst({ requestId: "req_2" })] }],
  ["missing / non-string request id: the empty one", { [`${R}.jsonl`]: [asst({ requestId: undefined }), asst({ requestId: 7 }), asst({ requestId: null })] }],
  ["no / non-string message id: never deduped", { [`${R}.jsonl`]: [asst({ message: { id: undefined } }), asst({ message: { id: undefined } }),
    asst({ message: { id: 5 } }), asst({ message: { id: 5 } }), asst({ message: { id: null } }), asst({ message: { id: "" } }), asst({ message: { id: "" } })] }],
  ["two models", { [`${R}.jsonl`]: [asst({ message: { id: "m1" } }), asst({ message: { id: "m2", model: "claude-haiku-5-5", usage: usage(1, 2, 3, 4) } })] }],
  ["every family", { [`${R}.jsonl`]: ["claude-opus-5-5", "claude-opus-5", "claude-opus-4-7", "claude-haiku-5-5", "claude-haiku-4-5",
    "claude-fable-5-1", "claude-fable-5", "claude-sonnet-5-5", "claude-sonnet-5", "claude-sonnet-4-5", "mystery"]
    .map((model, i) => asst({ message: { id: `m${i}`, model, usage: usage(1000, 2000, 30000, 4000) } })) }],
  ["model: missing, null, empty, number -> (unknown) / Sonnet", { [`${R}.jsonl`]: [asst({ message: { id: "n1", model: undefined } }),
    asst({ message: { id: "n2", model: null } }), asst({ message: { id: "n3", model: "" } }), asst({ message: { id: "n4", model: 4 } })] }],
  ["integer-like and __proto__ model ids: own keys, JS key order", { [`${R}.jsonl`]: ["zeta", "10", "2", "__proto__", "constructor", "01"]
    .map((model, i) => asst({ message: { id: `i${i}`, model, usage: usage(i + 1, 1, 0, 0) } })) }],
  ["synthetic models skipped", { [`${R}.jsonl`]: [asst({ message: { id: "y1", model: "<synthetic>" } }), asst({ message: { id: "y2", model: "<synthetic>-fast" } }), asst({ message: { id: "y3" } })] }],
  ["usage not a plain object: skipped", { [`${R}.jsonl`]: [asst({ message: { id: "a", usage: null } }), asst({ message: { id: "b", usage: 0 } }),
    asst({ message: { id: "c", usage: "x" } }), asst({ message: { id: "d", usage: [1] } }), asst({ message: { id: "e", usage: true } }), asst({ message: { id: "f", usage: {} } })] }],
  ["odd records", { [`${R}.jsonl`]: [{ type: "assistant", message: null }, { type: "assistant", message: "text" }, { type: "assistant", message: [1] },
    { type: "assistant" }, 5, "\"assistant\"", [], {}, { ...asst({ message: { id: "q1" } }), type: "user" }, { ...asst({ message: { id: "q2" } }), type: "Assistant" }, "", "  {\"type\":\"assistant\"}", "{not json", asst({ message: { id: "q4" } })] }],
  ["non-number tokens count as 0", { [`${R}.jsonl`]: [asst({ message: { usage: { input_tokens: "12", output_tokens: null, cache_read_input_tokens: true, cache_creation_input_tokens: [3] } } })] }],
  ["fractional, negative and huge tokens", { [`${R}.jsonl`]: [asst({ message: { id: "f", usage: usage(1.5, -2.5, 1e15, 0.49999999999999994) } }),
    asst({ message: { id: "g", usage: usage(-1.5, 2.5, -0.5, 0.5) } }), asst({ message: { id: "h", usage: usage(9007199254740993, 1e21, 0, 0) } })] }],
  ["half tokens round like Math.round in the row", { [`${R}.jsonl`]: [asst({ message: { id: "h1", usage: usage(-1.5, -2.5, 0.5, 2.5) } })] }],
  ["cache-write buckets: the 1h share at its own rate", { [`${R}.jsonl`]: [
    asst({ message: { id: "c1", usage: { ...usage(1, 1, 1, 400), cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 300 } } } }),
    asst({ message: { id: "c2", usage: { ...usage(1, 1, 1, 0), cache_creation: { ephemeral_5m_input_tokens: 7, ephemeral_1h_input_tokens: 5 } } } }),
    asst({ message: { id: "c3", usage: { ...usage(1, 1, 1, undefined), cache_creation: { ephemeral_1h_input_tokens: 9 } } } }),
    asst({ message: { id: "c4", usage: { ...usage(1, 1, 1, 10), cache_creation: { ephemeral_1h_input_tokens: 50 } } } }),
    asst({ message: { id: "c5", usage: { ...usage(1, 1, 1, 10), cache_creation: { ephemeral_1h_input_tokens: -5 } } } }),
    asst({ message: { id: "c6", usage: { ...usage(1, 1, 1, -10), cache_creation: { ephemeral_1h_input_tokens: 5 } } } }),
    asst({ message: { id: "c7", usage: { ...usage(1, 1, 1, -0), cache_creation: { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 3 } } } }),
    asst({ message: { id: "c8", usage: { ...usage(1, 1, 1, 10), cache_creation: [1, 2] } } }),
    asst({ message: { id: "c9", usage: { ...usage(1, 1, 1, 10), cache_creation: null } } }),
  ] }],
  ["costUSD wins when it's a finite number", { [`${R}.jsonl`]: [asst({ message: { id: "k1" }, costUSD: 0.5 }), asst({ message: { id: "k2" }, costUSD: "0.5" }),
    asst({ message: { id: "k3" }, costUSD: null }), asst({ message: { id: "k4" }, costUSD: -2 }), `{"type":"assistant","requestId":"r","costUSD":1e400,"message":{"id":"k5","model":"claude-opus-5-5","usage":{"input_tokens":5}}}`] }],
  ["US data-residency premium", { [`${R}.jsonl`]: ["us", "US", "eu", null, 5].map((g, i) =>
    asst({ message: { id: `g${i}`, usage: { ...usage(1000, 1000, 0, 0), inference_geo: g } } })) }],
  ["subagents and nested workflow agents, sorted, deduped across files", {
    [`${R}.jsonl`]: [asst({ message: { id: "main1" } }), asst({ message: { id: "main2" } })],
    [`${R}/subagents/agent-b.jsonl`]: [asst({ message: { id: "sb1", model: "claude-haiku-5-5" } }), asst({ message: { id: "main1" } })],
    [`${R}/subagents/agent-a.jsonl`]: [asst({ message: { id: "sa1", model: "claude-sonnet-5-5" } })],
    [`${R}/subagents/workflows/wf_1/agent-w.jsonl`]: [asst({ message: { id: "w1", model: "claude-fable-5-1" } })],
    [`${R}/subagents/workflows/wf_1/journal.jsonl`]: [{ type: "phase" }],
    [`${R}/subagents/agent-a.meta.json`]: [asst({ message: { id: "meta" } })],
    [`${R}/subagents/a/b/c/d/agent-deep4.jsonl`]: [asst({ message: { id: "deep4" } })],
    [`${R}/subagents/a/b/c/d/e/agent-deep5.jsonl`]: [asst({ message: { id: "deep5" } })],
    [`${R}/subagents/Z-upper.jsonl`]: [asst({ message: { id: "zu" } })],
    [`${R}/other/agent-x.jsonl`]: [asst({ message: { id: "outside" } })],
  }],
  ["a symlinked subagent transcript is ignored", {
    [`${R}.jsonl`]: [asst({ message: { id: "m" } })],
    [`elsewhere.jsonl`]: [asst({ message: { id: "linked" } })],
    [`${R}/subagents/agent-link.jsonl`]: { symlink: "../../elsewhere.jsonl" },
  }],
  ["subagents only (no main transcript): no turns, still priced", { [`${R}/subagents/agent-a.jsonl`]: [asst({ message: { id: "s" } })] }],
  ["CRLF lines, a BOM, invalid UTF-8", {
    [`${R}.jsonl`]: { hex: Buffer.concat([
      Buffer.from("﻿" + J(asst({ message: { id: "bom" } })) + "\r\n" + J(asst({ message: { id: "crlf" } })) + "\r\n"),
      Buffer.from('{"type":"assistant","requestId":"r","message":{"id":"bad-'), Buffer.from([0xff, 0xfe, 0xc3]),
      Buffer.from('","model":"claude-opus-5-5","usage":{"input_tokens":3}}}\n'),
    ]).toString("hex") },
  }],
  ["many calls, mixed models", { [`${R}.jsonl`]: many }],
  ["a persisted row wins", { [`${R}.jsonl`]: [asst()] }, { persisted: "full" }],
  ["a persisted row wins over no transcript", {}, { persisted: "full" }],
  ["a persisted zero row still wins", { [`${R}.jsonl`]: [asst()] }, { persisted: "zero" }],
  ["fork: estimate the source transcript, save under the new id", { [`${R}.jsonl`]: [asst(), costState(R, 3)] }, { id: "fork-0001" }],
  ["checkpoint: the last valid one for the resumed id", { [`${R}.jsonl`]: [asst(), costState(R, 0), costState(R, 208.25), costState(R, 363.52),
    costState(R, 999, { totalCostUSD: -1 }), costState("someone-else", 50), asst({ message: { id: "m2" } })] }],
  ["checkpoint: a later $0 one wins", { [`${R}.jsonl`]: [costState(R, 12), costState(R, 0)] }],
  ["checkpoint: empty modelUsage is valid, without models", { [`${R}.jsonl`]: [costState(R, 4, { modelUsage: {} })] }],
  ["checkpoint: invalid shapes are skipped", { [`${R}.jsonl`]: [costState(R, 1),
    costState(R, 2, { modelUsage: null }), costState(R, 3, { modelUsage: [1] }), costState(R, 4, { modelUsage: { m: null } }),
    costState(R, 5, { modelUsage: { m: [1] } }), costState(R, 6, { modelUsage: { m: { inputTokens: 1 } } }),
    costState(R, 7, { totalCostUSD: 1e9 + 1 }), costState(R, 8, { totalCostUSD: "8" }), costState(R, 9, { totalAPIDuration: -1 }),
    costState(R, 10, { modelUsage: { m: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 10, thinkingTokens: null } } }),
    { ...costState(R, 11), type: "cost-state-x" }, `{"type":"cost-state","sessionId":"${R}",`, `["cost-state"]`] }],
  ["checkpoint: models keep their fields and JS key order", { [`${R}.jsonl`]: [costState(R, 1, { modelUsage: {
    "claude-b": { costUSD: 1, inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 1, cacheCreationInputTokens: 1, webSearchRequests: 0, extra: "x" },
    "10": { inputTokens: 2, outputTokens: 2, cacheReadInputTokens: 2, cacheCreationInputTokens: 2, webSearchRequests: 0, costUSD: 2 },
    "2": { inputTokens: 3, outputTokens: 3, cacheReadInputTokens: 3, cacheCreationInputTokens: 3, webSearchRequests: 0, costUSD: 3 } } })] }],
];

function writeFiles(root, files) {
  for (const [rel, body] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirp(dirname(path), { recursive: true });
    if (Array.isArray(body)) writeFileSync(path, lines(body));
    else if (typeof body === "string") writeFileSync(path, body);
    else if (body.hex !== undefined) writeFileSync(path, Buffer.from(body.hex, "hex"));
    else if (body.symlink !== undefined) symlinkSync(body.symlink, path);
  }
}
/** The files as the fixture keeps them: JSONL text, raw bytes, or a link. */
function fixtureFiles(files) {
  return Object.entries(files).map(([rel, body]) =>
    Array.isArray(body) ? { rel, text: lines(body) } : typeof body === "string" ? { rel, text: body } : { rel, ...body });
}

const PERSISTED = {
  full: {
    totalCostUsd: 1.25, numTurns: 3, durationMs: 4000, durationApiMs: 3000, inputTokens: 100, outputTokens: 200,
    cacheReadInputTokens: 3000, cacheCreationInputTokens: 40, modelUsage: { "claude-opus-5-5": { inputTokens: 100, costUSD: 1.25 } },
  },
  zero: { ...zeroSessionUsage() },
};

// Each case gets its own project dir (a fresh cwd), so files don't leak.
const seeds = [];
let n = 0;
for (const [name, files, opts = {}] of SEEDS) {
  const caseNo = String(n++).padStart(3, "0");
  const cwd = join(ROOT_DIR, `project-${caseNo}`);
  mkdirp(cwd, { recursive: true });
  const root = projectRoot(cwd);
  mkdirp(root, { recursive: true });
  writeFiles(root, files);
  const id = opts.id ?? (opts.resume === null ? `fresh-${caseNo}` : R);
  const persisted = opts.persisted ? PERSISTED[opts.persisted] : null;
  if (persisted) await saveSessionUsage(cwd, id, persisted);
  const bare = Object.create(Session.prototype);
  Object.assign(bare, {
    cwd, id, resumeFrom: opts.resume === null ? undefined : R,
    usageTotals: zeroSessionUsage(), sdkLastCumulative: zeroSdkCumulativeUsage(),
  });
  await bare.seedUsageBaseline();
  const expectRow = persisted !== null || J(bare.usageTotals) !== J(zeroSessionUsage());
  const row = await readRowAt(cwd, id, expectRow);
  seeds.push({
    name, case: caseNo, id, resume: opts.resume === null ? null : R, files: fixtureFiles(files), persisted,
    totals: J(bare.usageTotals), checkpoint: J(bare.sdkLastCumulative), row: row ? J(row) : null,
  });
}
async function readRowAt(cwd, id, expectRow) {
  for (let i = 0; i < (expectRow ? 200 : 10); i++) {
    await new Promise((r) => setTimeout(r, 10));
    const row = await getSessionUsage(cwd, id);
    if (row) return row;
  }
  return null;
}

// ----------------------------- folds -----------------------------
//
// `foldResultIntoSessionUsage(totals, last, message)` over a sequence: each
// step's `{totals, last}` as `JSON.stringify` text, or null (no usage).

const mu = (models) => Object.fromEntries(Object.entries(models).map(([k, v]) => [k, v === null || typeof v !== "object" || Array.isArray(v) ? v : {
  inputTokens: v.in ?? 0, outputTokens: v.out ?? 0, cacheReadInputTokens: v.cr ?? 0, cacheCreationInputTokens: v.cc ?? 0,
  webSearchRequests: v.ws ?? 0, costUSD: v.cost ?? 0, ...(v.th !== undefined ? { thinkingTokens: v.th } : {}),
  contextWindow: v.cw ?? 200000, ...(v.extra ?? {}),
}]));
const res = (over) => ({ type: "result", subtype: "success", total_cost_usd: 0, num_turns: 0, duration_ms: 0, duration_api_ms: 0, ...over });
const Z = () => zeroSessionUsage();
const ZL = () => zeroSdkCumulativeUsage();
const FOLDS = [
  ["cumulative growth, per-turn sums", Z(), ZL(), [
    res({ total_cost_usd: 14.22, num_turns: 6, duration_ms: 71728, duration_api_ms: 1250927, modelUsage: mu({ "claude-opus-5": { in: 5270, out: 87894, cost: 14.22 } }) }),
    res({ total_cost_usd: 16.47, num_turns: 19, duration_ms: 56129, duration_api_ms: 1368269, modelUsage: mu({ "claude-opus-5": { in: 5806, out: 95575, cost: 16.47 } }) })]],
  ["num_turns dropping is not a reset", Z(), ZL(), [
    res({ total_cost_usd: 10, num_turns: 40, modelUsage: mu({ m: { out: 1000, cost: 10 } }) }),
    res({ total_cost_usd: 11, num_turns: 3, modelUsage: mu({ m: { out: 1100, cost: 11 } }) }),
    res({ total_cost_usd: 12, num_turns: 1, modelUsage: mu({ m: { out: 1200, cost: 12 } }) })]],
  ["a /clear counts the new block from zero", Z(), ZL(), [
    res({ total_cost_usd: 2.5, num_turns: 10, duration_ms: 60000, duration_api_ms: 40000, modelUsage: mu({ m: { out: 9, cost: 2.5 } }) }),
    res({ total_cost_usd: 0.3, num_turns: 2, duration_ms: 5000, duration_api_ms: 3000, modelUsage: mu({ m: { out: 2, cost: 0.3 } }) }),
    res({ total_cost_usd: 0.4, num_turns: 1, duration_ms: 1, duration_api_ms: 3500, modelUsage: mu({ m: { out: 3, cost: 0.4 } }) })]],
  ["zeroed and empty frames are skipped", Z(), ZL(), [
    res({ total_cost_usd: 5, num_turns: 4, duration_ms: 30000 }), res({}), res({ duration_ms: 1200 }), res({ modelUsage: {} }),
    res({ total_cost_usd: 6, num_turns: 1, duration_ms: 10000 })]],
  ["models: added, dropped, back, shrinking, descriptive", Z(), ZL(), [
    res({ total_cost_usd: 1, num_turns: 1, modelUsage: mu({ a: { in: 100, out: 200, cr: 1000, cc: 50, cost: 0.9, th: 7 }, b: { in: 10, out: 20, cost: 0.1 } }) }),
    res({ total_cost_usd: 1.5, num_turns: 2, modelUsage: mu({ a: { in: 150, out: 300, cr: 3000, cc: 50, cost: 1.4, th: 9, cw: 1000000 } }) }),
    res({ total_cost_usd: 1.7, num_turns: 1, modelUsage: mu({ a: { in: 140, out: 310, cr: 3000, cc: 60, cost: 1.5 }, b: { in: 15, out: 25, cost: 0.2 } }) }),
    res({ total_cost_usd: 1.8, num_turns: 1, modelUsage: mu({ c: { in: 1, cost: 0.1, extra: { provider: "x", note: null } }, a: { in: 140, out: 310, cr: 3000, cc: 60, cost: 1.5 } }) })]],
  ["odd model entries and values", Z(), ZL(), [
    res({ total_cost_usd: 1, num_turns: 1, modelUsage: { a: null, b: 5, c: [1, 2], d: { inputTokens: "7", outputTokens: 3, costUSD: 1 }, "10": { inputTokens: 1 }, "2": { inputTokens: 2 } } }),
    res({ total_cost_usd: 2, num_turns: 1, modelUsage: { d: { inputTokens: 9, outputTokens: "x", costUSD: 2 }, "2": { inputTokens: 5 }, "10": [3] } })]],
  ["an array modelUsage is ignored", Z(), ZL(), [
    res({ total_cost_usd: 1, num_turns: 1, modelUsage: [{ inputTokens: 1 }], usage: { input_tokens: 4 } })]],
  ["without modelUsage the per-turn usage adds", Z(), ZL(), [
    res({ total_cost_usd: 0.1, num_turns: 1, usage: { input_tokens: 10, output_tokens: 20 } }),
    res({ total_cost_usd: 0.2, num_turns: 2, usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 3, cache_creation_input_tokens: 1 } }),
    res({ total_cost_usd: 0.3, num_turns: 1, usage: [5] }),
    res({ total_cost_usd: 0.4, num_turns: 1, usage: { input_tokens: -5, output_tokens: "6" } })]],
  ["negative, string and huge scalars", Z(), ZL(), [
    res({ total_cost_usd: -1, num_turns: 2, duration_ms: -5, duration_api_ms: "9" }),
    res({ total_cost_usd: "3", num_turns: "4", duration_ms: 1e21, duration_api_ms: 9007199254740993 }),
    res({ total_cost_usd: 0.1, num_turns: 0.5, duration_ms: 0.1, duration_api_ms: 0.2 }),
    res({ total_cost_usd: 0.30000000000000004, num_turns: 0.25, duration_ms: 0.2, duration_api_ms: 0.1 })]],
  ["resume: the seeded checkpoint isn't counted twice",
    { ...Z(), totalCostUsd: 7, numTurns: 30, outputTokens: 7000, modelUsage: mu({ "claude-opus-5": { out: 7000, cost: 7 } }) },
    { totalCostUsd: 5, durationApiMs: 90000, modelUsage: mu({ "claude-opus-5": { out: 5000, cost: 5 } }) },
    [res({ total_cost_usd: 5.5, num_turns: 2, duration_api_ms: 95000, modelUsage: mu({ "claude-opus-5": { out: 5500, cost: 5.5 } }) }),
     res({ total_cost_usd: 6, num_turns: 1, duration_api_ms: 99000, modelUsage: mu({ "claude-opus-5": { out: 6000, cost: 6 }, h: { in: 1, cost: 0 } }) })]],
  ["resume: a CLI that didn't restore counts from zero",
    { ...Z(), totalCostUsd: 7, numTurns: 30 }, { totalCostUsd: 5, durationApiMs: 90000 },
    [res({ total_cost_usd: 0.4, num_turns: 1, duration_api_ms: 100, modelUsage: mu({ "claude-opus-5": { out: 400, cost: 0.4 } }) })]],
  ["resume: within 1e-9 of the checkpoint is not a reset",
    { ...Z(), totalCostUsd: 7 }, { totalCostUsd: 5, durationApiMs: 0 },
    [res({ total_cost_usd: 4.9999999995, num_turns: 1 }), res({ total_cost_usd: 4.999999998, num_turns: 1 })]],
  ["string and array messages carry nothing", Z(), ZL(), ["result", [1], res({ total_cost_usd: 1, num_turns: 1 })]],
];
const folds = FOLDS.map(([name, totals0, last0, messages]) => {
  let totals = totals0;
  let last = last0;
  const steps = messages.map((m) => {
    const out = foldResultIntoSessionUsage(totals, last, m);
    if (!out) return null;
    ({ totals, last } = out);
    return { totals: J(totals), last: J(last) };
  });
  return { name, totals: totals0, last: last0, messages, steps };
});

// ----------------------------- costStates -----------------------------

const CS_CWD = join(ROOT_DIR, "project-cost-state");
mkdirp(CS_CWD, { recursive: true });
const CS_ID = "cs-0001";
const CS_FILES = {
  [`${CS_ID}.jsonl`]: [costState(CS_ID, 2), costState("cs-0002", 3)],
  "cs-0002.jsonl": [costState(CS_ID, 4)],
  "x.jsonl": [costState("x", 5)],
  "a b.jsonl": [costState("a b", 6)],
};
writeFiles(projectRoot(CS_CWD), CS_FILES);
const costStateCases = [];
for (const id of [CS_ID, "cs-0002", "x", "a b", "../escape", "", "cs-0003", "cs-0001.jsonl", "CS-0001", "cs\u00e90001"]) {
  costStateCases.push({ id, checkpoint: J(await lastRecordedCostState(id, CS_CWD)) });
}
const costStates = { files: fixtureFiles(CS_FILES), cases: costStateCases };

writeFileSync(
  join(ROOT_DIR, "out.json"),
  J({ multiplierMax: MODEL_PRICING_MULTIPLIER_MAX, prices, costs, geo, seeds, folds, costStates }),
);
process.exit(0);
