#!/usr/bin/env node
// Golden fixture for the chat client's pure helpers (U01a): the functions
// lib/client/use-session.ts defines around `useSession`, with the
// lib/client/sdk-message-filters.ts, lib/shared/user-prompt.ts,
// lib/shared/rate-limit-prefixes.ts and lib/shared/slash-commands.ts parts
// they call.
//
//   node rust/scripts/client-helpers-golden.mjs     (node@22)
//
// Re-runs itself under `--experimental-transform-types` with HOME in a temp
// dir, `TZ` pinned (a JSONL `timestamp` without a zone is local time) and a
// resolve hook for the `@/` and extensionless imports, twice; both
// recordings must agree byte for byte. The real use-session.ts is imported
// as it is, except that a load hook appends one `export { ... }` line for
// the helpers it doesn't export (`coerceTodos`, `blocksFromSDKContent`,
// `pickPrimaryArg`, `mergeCompactBoundary`, `normalizeCompactStats`,
// `rateLimitHitFromBlocks`). `Date.now()` is fixed (`now`) and
// `crypto.randomUUID()` counts from 1 again for every case
// (`00000000-0000-4000-8000-000000000001`, ...).
//
// Every case is `{ name, args, out | throws, same? }`:
// - `args` went through `JSON.stringify` / `JSON.parse` before the call, so
//   the replay reads exactly what the TS got. A `{"$repeat": [s, n]}` in
//   them is `s.repeat(n)`. Message lists carry `foldedSdkUuids` as arrays,
//   made `Set`s for the call.
// - `out` is the result in the client's snapshot JSON: a key whose value is
//   `undefined` is left out (no consumer of these objects tells it from a
//   missing key), a `Set` is an array, a `Record` the UI iterates is a list
//   of `[key, value]` pairs (own-key order), a number JSON can't hold is
//   `{"$num": "NaN" | "Infinity" | "-Infinity" | "-0"}`, and an `undefined`
//   result is `{"$undefined": true}`.
// - `throws` is the exception as `"<name>: <message>"`.
// - `same` is whether the helper handed back its input (`result === prev`).
//
// Written to rust/crates/claudius-client/tests/fixtures/client_helpers_golden.json
// and replayed by crates/claudius-client/tests/client_helpers_golden.rs.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "crates/claudius-client/tests/fixtures/client_helpers_golden.json");
const TZ = "America/New_York";
const NOW = 1763300000000;

if (!process.env.CLIENT_HELPERS_GOLDEN_CHILD) {
  const runs = [0, 1].map(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "client-helpers-golden-")));
    try {
      const r = spawnSync(
        process.execPath,
        ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url)],
        {
          cwd: repo,
          encoding: "utf8",
          maxBuffer: 1 << 26,
          env: { PATH: process.env.PATH, HOME: root, TZ, CLIENT_HELPERS_GOLDEN_CHILD: root },
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
  writeFileSync(out, runs[0]);
  const fixture = JSON.parse(runs[0]);
  const counts = Object.entries(fixture.sections).map(([k, v]) => `${k} ${Array.isArray(v) ? v.length : 1}`);
  const total = Object.values(fixture.sections).reduce((n, v) => n + (Array.isArray(v) ? v.length : 1), 0);
  console.log(`wrote ${out.slice(repo.length + 1)}: ${total} cases (stable)\n  ${counts.join(", ")}`);
  process.exit(0);
}

const ROOT_DIR = process.env.CLIENT_HELPERS_GOLDEN_CHILD;
const useSessionPath = join(repo, "lib/client/use-session.ts");
const PRIVATE = [
  "coerceTodos",
  "blocksFromSDKContent",
  "pickPrimaryArg",
  "mergeCompactBoundary",
  "normalizeCompactStats",
  "rateLimitHitFromBlocks",
];
const src = readFileSync(useSessionPath, "utf8");
for (const name of PRIVATE) {
  const decl = `\nfunction ${name}(`;
  const at = src.indexOf(decl);
  if (at < 0 || src.indexOf(decl, at + 1) >= 0) {
    throw new Error(`use-session.ts no longer declares \`function ${name}(\` exactly once: update the recorder`);
  }
}

const hook = `
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
const ROOT = ${JSON.stringify(pathToFileURL(repo + "/").href)};
const USE_SESSION = ${JSON.stringify(pathToFileURL(realpathSync(useSessionPath)).href)};
const EXPORTS = ${JSON.stringify(`\nexport { ${PRIVATE.join(", ")} };\n`)};
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
  const r = await next(url, ctx);
  if (url !== USE_SESSION) return r;
  return { ...r, source: String(r.source) + EXPORTS };
}`;
register(`data:text/javascript,${encodeURIComponent(hook)}`);

// --------------------------- determinism stubs ---------------------------

let uuidCount = 0;
Date.now = () => NOW;
Object.defineProperty(globalThis.crypto, "randomUUID", {
  configurable: true,
  writable: true,
  value: () => `00000000-0000-4000-8000-${String(++uuidCount).padStart(12, "0")}`,
});

const us = await import(useSessionPath);
for (const name of PRIVATE) {
  if (typeof us[name] !== "function") throw new Error(`the load hook didn't export ${name}: update the recorder`);
}
const filters = await import(join(repo, "lib/client/sdk-message-filters.ts"));
const prompt = await import(join(repo, "lib/shared/user-prompt.ts"));
const { SLASH_COMMANDS } = await import(join(repo, "lib/shared/slash-commands.ts"));

// ------------------------------- encoding --------------------------------

const def = (o, k, v) => Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });

function enc(v) {
  if (v === undefined) return { $undefined: true };
  if (typeof v === "number") {
    if (Number.isNaN(v)) return { $num: "NaN" };
    if (Object.is(v, -0)) return { $num: "-0" };
    if (!Number.isFinite(v)) return { $num: String(v) };
    return v;
  }
  if (typeof v === "function") return { $function: v.name };
  if (v === null || typeof v !== "object") return v;
  if (v instanceof Set) return [...v].map(enc);
  if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : enc(x)));
  const o = {};
  for (const [k, x] of Object.entries(v)) if (x !== undefined) def(o, k, enc(x));
  return o;
}

/** A `Record` as `[key, value]` pairs, in own-key order. */
const pairs = (rec) => Object.entries(rec).map(([k, v]) => [k, enc(v)]);

function expand(v) {
  if (Array.isArray(v)) return v.map(expand);
  if (v && typeof v === "object") {
    if (Object.keys(v).length === 1 && Array.isArray(v.$repeat)) return v.$repeat[0].repeat(v.$repeat[1]);
    const o = {};
    for (const [k, x] of Object.entries(v)) def(o, k, expand(x));
    return o;
  }
  return v;
}

const toMsg = (m) =>
  m && Array.isArray(m.foldedSdkUuids) ? { ...m, foldedSdkUuids: new Set(m.foldedSdkUuids) } : m;
const toMsgs = (l) => l.map(toMsg);
function toTrails(rec) {
  const o = {};
  for (const [k, v] of Object.entries(rec)) def(o, k, toMsgs(v));
  return o;
}

const sections = {};
/**
 * Record `fn(...args)` for each case. `args` is what the fixture stores
 * (round-tripped through JSON, `$repeat` still folded); `prep` turns the
 * parsed args into the call's (Sets for message lists); `show` encodes the
 * result (default `enc`); with `same`, also whether the first argument came
 * back.
 */
function section(name, fn, cases, { prep = (a) => a, show = enc, same = false } = {}) {
  sections[name] = cases.map(([label, args]) => {
    const stored = JSON.parse(JSON.stringify(args));
    const callArgs = prep(expand(stored));
    uuidCount = 0;
    try {
      const r = fn(...callArgs);
      return {
        name: label,
        args: stored,
        out: show(r, callArgs),
        ...(same ? { same: r === callArgs[0] } : {}),
      };
    } catch (e) {
      return { name: label, args: stored, throws: `${e?.name}: ${e?.message}` };
    }
  });
}

// ------------------------------- inputs ----------------------------------

const U = (...cps) => String.fromCodePoint(...cps);
const LONE_HI = String.fromCharCode(0xd83d);
const LONE_LO = String.fromCharCode(0xde00);
const FEFF = U(0xfeff);
const NEL = U(0x85);
const NBSP = U(0xa0);
const LS = U(0x2028);
const IDEO = U(0x3000);
const RSQUO = U(0x2019);
const LSQUO = U(0x2018);
const LONG_S = U(0x17f);
const KELVIN = U(0x212a);
const DOTTED_CAP_I = U(0x130);
const EMOJI = U(0x1f600);
const MIDDOT = U(0xb7);
const E_ACUTE = U(0xe9);
const I_DOT = U(0x130);
const MODIFIER_APOS = U(0x2bc);

const text = (t) => ({ kind: "text", text: t });
const thinking = (t, redacted) => (redacted ? { kind: "thinking", text: t, redacted } : { kind: "thinking", text: t });
const toolUse = (id, name = "Bash", input = {}, extra = {}) => ({ kind: "tool_use", id, name, input, ...extra });

// ---- prose detectors

const LIMIT_TEXTS = [
  "You've hit your limit \u00b7 resets 3pm (Europe/Lisbon)",
  `You${RSQUO}ve hit your weekly limit`,
  `You${LSQUO}ve reached your Opus limit`,
  `  ${FEFF}\n You've hit your session limit`,
  `${NEL}You've hit your limit`,
  `${NBSP}${IDEO}${LS}You're out of usage credits`,
  "YOU'VE HIT YOUR LIMIT",
  `Your org is out of usage ${MIDDOT} add funds to continue`,
  "Your org is out of usage - add funds to continue",
  `Your org is out of usage ${MIDDOT} contact your admin.`,
  "Your seat type doesn't include usage credits",
  "Your seat type doesn't include usage",
  "Your seat type doesn't include extra usage",
  "Your usage allocation has been disabled by your admin",
  "Your group's usage limit is set to $0",
  `Your group${RSQUO}s usage limit is set to $0`,
  "Fable 5 requires usage credits",
  "FABLE 5 REQUIRES USAGE CREDITS",
  "You're out of extra usage",
  "You've hit",
  "You've hi",
  "I think you've hit your limit",
  "",
  `${LONE_HI}You've hit your limit`,
  `You've hit your limit ${LONE_LO}`,
  `Y${U(0x4f)}u've hit your limit`,
  `You've hit your limit ${EMOJI}`,
  `${I_DOT}You've hit your limit`,
];

const blockSets = (texts) => texts.map((t) => [JSON.stringify(t).slice(0, 60), [[text(t)]]]);
const MIXED_BLOCKS = [
  ["empty", [[]]],
  ["thinking then hit", [[thinking("x"), text("You've hit your limit")]]],
  ["hit then tool_use", [[text("You've hit your limit"), toolUse("t1")]]],
  ["two texts, second hits", [[text("hello"), text("You've hit your limit")]]],
  ["two texts, first hits", [[text("You've hit your limit"), text("hello")]]],
  ["huge", [[text({ $repeat: ["You've hit your limit ", 5000] })]]],
];

section("isRateLimitHitText", us.isRateLimitHitText, [...blockSets(LIMIT_TEXTS), ...MIXED_BLOCKS]);

const TYPE_TEXTS = [
  "You've hit your Opus limit",
  "opus4 limit",
  `${E_ACUTE}opus`,
  "OPUS",
  "Sonnet limit",
  "sonnet-4",
  "weekly limit",
  "your week limit",
  "weeks",
  "7-day",
  "7 day",
  "7day",
  `7${IDEO}day`,
  `7${NEL}day`,
  `7${FEFF}day`,
  `7${NBSP}day`,
  "7--day",
  "seven day",
  "Seven-Day",
  "sevenday",
  "session limit",
  "sessions",
  "5-hour",
  "five hour",
  "5hour",
  "fivehour",
  `WEE${KELVIN}LY`,
  `${I_DOT}session`,
  "opus weekly",
  "weekly sonnet",
  "five_hour",
  "_opus_",
  "",
  `${LONE_HI}opus${LONE_LO}`,
  "nothing here",
];
section("rateLimitTypeFromText", us.rateLimitTypeFromText, TYPE_TEXTS.map((t) => [JSON.stringify(t), [t]]));

sections.RESUME_REASON_LABELS = Object.entries(us.RESUME_REASON_LABELS);
sections.STARTUP_FAILURE_REASON_LABELS = Object.entries(us.STARTUP_FAILURE_REASON_LABELS);
sections.MODEL_UNAVAILABLE_MESSAGE = us.MODEL_UNAVAILABLE_MESSAGE;

const OPUS_TEXTS = [
  "We are experiencing high demand for Opus 4.",
  "HIGH DEMAND FOR OPUS 4",
  "high demand for opus 45",
  "xhigh demand for opus 4",
  `${E_ACUTE}high demand for opus 4`,
  `high demand for opu${LONG_S} 4`,
  "high  demand for opus 4",
  "high demand for opus 4_",
  "high demand for opus 4.1",
  `high demand for opus 4${KELVIN}`,
  `high demand for opus 4${DOTTED_CAP_I}`,
  `${LONE_HI}high demand for opus 4${LONE_LO}`,
  "",
];
section("isOpusHighDemandText", us.isOpusHighDemandText, [...blockSets(OPUS_TEXTS), ...MIXED_BLOCKS]);

const MODEL_TEXTS = [
  "There's an issue with the selected model (claude-fable-5). It may not exist or you may not have access to it.",
  `There${RSQUO}s an issue with the selected model (x)`,
  `There${MODIFIER_APOS}s an issue with the selected model (x)`,
  "THERE'S AN ISSUE WITH THE SELECTED MODEL",
  "it may not exist or you may not have access",
  "The model claude-fable-5 is not available on your bedrock deployment.",
  "is not available on your deployment",
  "is not available on yourdeployment",
  "is not available on your \ndeployment",
  `is not available on your ${LS}deployment`,
  `is not available on your ${NEL}deployment`,
  "is not available on your \rdeployment",
  "is not available on your x deployment",
  `may not exi${LONG_S}t or you may not have access`,
  "",
];
section("isModelNotFoundText", us.isModelNotFoundText, [...blockSets(MODEL_TEXTS), ...MIXED_BLOCKS]);

const FABLE_404 = "There's an issue with the selected model (claude-fable-5). It may not exist or you may not have access to it.";
section(
  "rewriteModelUnavailableBlocks",
  us.rewriteModelUnavailableBlocks,
  [
    ["fable prose", [[text(FABLE_404)]]],
    ["fable prose, error tag", [[text(FABLE_404)], "model_not_found"]],
    ["other model prose", [[text("There's an issue with the selected model (claude-opus-9).")]]],
    ["fable plain prose with error", [[text("Fable is great")], "model_not_found"]],
    ["fable plain prose, other error", [[text("Fable is great")], "rate_limit"]],
    ["fable kelvin boundary", [[text(`Fable${KELVIN} is great`)], "model_not_found"]],
    ["FABLE upper", [[text("There's an issue with the selected model (CLAUDE-FABLE-5)")]]],
    ["fables (no boundary)", [[text("There's an issue with the selected model (fables)")]]],
    ["fable_5 (no boundary)", [[text("There's an issue with the selected model (claude_fable_5)")]]],
    ["fable in second text", [[text("There's an issue with the selected model (x)"), text("fable")]]],
    ["thinking then fable", [[thinking("t"), text("fable")], "model_not_found"]],
    ["tool_use only", [[toolUse("t1")], "model_not_found"]],
    ["empty", [[], "model_not_found"]],
    ["empty, no error", [[]]],
    ["error empty string", [[text("fable")], ""]],
  ],
  { same: true },
);

section(
  "rateLimitHitFromBlocks",
  us.rateLimitHitFromBlocks,
  [
    ["prose only", [[text("You've hit your Opus limit")], null, null]],
    ["prose, fallback", [[text("You've hit your Opus limit")], null, "claude-sonnet-4"]],
    ["prose weekly, fallback dropped", [[text("You've hit your weekly limit")], null, "claude-sonnet-4"]],
    ["no text", [[toolUse("t")], null, null]],
    ["empty", [[], null, null]],
    [
      "full last",
      [
        [text("You've hit your limit")],
        {
          status: "rejected",
          rateLimitType: "seven_day_sonnet",
          resetsAt: 1763303600,
          errorCode: "credits_required",
          canUserPurchaseCredits: false,
          hasChargeableSavedPaymentMethod: true,
          limitScope: "group_pool",
        },
        "claude-opus-4",
        "max",
      ],
    ],
    ["last type wins over prose", [[text("Opus")], { rateLimitType: "five_hour" }, "m", "pro"]],
    ["last empty type", [[text("Opus limit")], { rateLimitType: "" }, "m"]],
    ["last no type, prose sonnet", [[text("sonnet")], { resetsAt: 0 }, "m", ""]],
    ["empty strings", [[text("x")], { errorCode: "", limitScope: "" }, "", ""]],
    ["fractional reset", [[text("x")], { resetsAt: 1.5 }, null, null]],
  ],
);

// ---- todos and content blocks

section("coerceTodos", us.coerceTodos, [
  ["full", [[{ id: "a", content: "do it", status: "in_progress", activeForm: "Doing it" }]]],
  ["missing fields", [[{}]]],
  ["subject fallback", [[{ subject: "subj" }]]],
  ["content wins over subject", [[{ content: "c", subject: "s" }]]],
  ["empty content, subject", [[{ content: "", subject: "s" }]]],
  ["numeric id and odd types", [[{ id: 7, content: 5, status: null, activeForm: 3 }]]],
  ["null, number, string, array, bool", [[null, 5, "x", [1], true, { id: "z" }]]],
  ["unicode", [[{ id: `${LONE_HI}`, content: `${EMOJI}${LONE_LO}`, status: "completed", activeForm: "" }]]],
  ["empty", [[]]],
  ["many", [Array.from({ length: 30 }, (_, i) => (i % 3 ? { content: `c${i}` } : { id: `id${i}`, status: "completed" }))]],
]);

const TOOL_USE = { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } };
section(
  "blocksFromSDKContent",
  us.blocksFromSDKContent,
  [
    ["string", ["hello"]],
    ["empty string", [""]],
    ["undefined", []],
    ["null", [null]],
    ["number", [5]],
    ["object", [{ type: "text", text: "x" }]],
    ["empty array", [[]]],
    ["text", [[{ type: "text", text: "a" }]]],
    ["text non-string", [[{ type: "text", text: 5 }, { type: "text" }, { type: "text", text: null }]]],
    ["thinking", [[{ type: "thinking", thinking: "hmm", signature: "sig" }]]],
    ["thinking non-string", [[{ type: "thinking", thinking: 1 }, { type: "thinking" }]]],
    ["redacted", [[{ type: "redacted_thinking", data: "abc" }, { type: "redacted_thinking" }]]],
    ["tool_use", [[TOOL_USE]]],
    ["tool_use no input", [[{ type: "tool_use", id: "t", name: "Read" }]]],
    ["tool_use null input", [[{ type: "tool_use", id: "t", name: "Read", input: null }]]],
    ["tool_use string input", [[{ type: "tool_use", id: "t", name: "Read", input: "x" }]]],
    ["tool_use array input", [[{ type: "tool_use", id: "t", name: "Read", input: [1, 2] }]]],
    ["tool_use false input", [[{ type: "tool_use", id: "t", name: "Read", input: false }]]],
    ["tool_use odd id and name", [[{ type: "tool_use", id: 5, name: null, input: {} }, { type: "tool_use" }]]],
    ["unknown types", [[{ type: "image", source: {} }, { type: "server_tool_use", id: "s" }, { type: "web_search_tool_result" }, {}]]],
    ["primitives", [[5, "x", [], true, { type: "text", text: "after" }]]],
    ["null item throws", [[{ type: "text", text: "a" }, null]]],
    ["mixed order", [[{ type: "thinking", thinking: "t" }, TOOL_USE, { type: "text", text: "done" }]]],
    ["unicode", [[{ type: "text", text: `${LONE_HI}x${EMOJI}` }]]],
    ["huge", [[{ type: "text", text: { $repeat: ["ab", 50000] } }]]],
  ],
);

// ---- subagent trails

const sa = (uuid, id, content, at) => ({ ...(at === undefined ? {} : { at }), message: { type: "assistant", uuid, message: { id, content } } });
const su = (uuid, content, at) => ({ ...(at === undefined ? {} : { at }), message: { type: "user", uuid, message: { content } } });
section(
  "buildSubagentMessages",
  us.buildSubagentMessages,
  [
    [
      "splits coalesce",
      [
        [
          su("u1", "go", 1000),
          sa("a1", "msg_1", [{ type: "text", text: "Looking" }], 1001),
          sa("a2", "msg_1", [{ type: "tool_use", id: "toolu_x", name: "Read", input: { file_path: "/a" } }], 1002),
          sa("a3", "msg_2", [{ type: "text", text: "Done" }], 1003),
        ],
        "toolu_parent",
      ],
    ],
    ["user array text", [[su("u1", [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }])], "p"]],
    ["duplicate user uuid", [[su("u1", "one"), su("u1", "two")], "p"]],
    ["empty user text skipped, uuid reusable", [[su("u1", ""), su("u1", "second")], "p"]],
    ["missing uuids", [[{ message: { type: "assistant", message: { content: "x" } } }, { message: { type: "user", message: { content: "y" } } }], "p"]],
    ["missing uuid, empty user", [[{ message: { type: "user", message: { content: "" } } }, { message: { type: "assistant", message: { id: "m" } } }], "p"]],
    ["null uuid", [[{ message: { type: "user", uuid: null, message: { content: "y" } } }], "p"]],
    ["number uuid", [[{ message: { type: "user", uuid: 5, message: { content: "y" } } }], "p"]],
    ["lone halves join", [[su("u1", [{ type: "text", text: `a${LONE_HI}` }, { type: "text", text: `${LONE_LO}b` }])], "p"]],
    ["empty message id", [[sa("a1", "", "text")], "p"]],
    ["at not a number", [[sa("a1", "m", "x", "1000"), su("u1", "y", null)], "p"]],
    ["empty parent", [[sa("a1", "m", "x"), su("u1", "y")], ""]],
    ["refold same split", [[sa("a1", "m", "x"), sa("a1", "m", "x")], "p"]],
    ["user truthy non-string text", [[su("u1", [{ type: "text", text: 5 }, { type: "text", text: true }, { type: "text", text: [1, [2, null]] }, { type: "text", text: { a: 1 } }])], "p"]],
    ["user toString object throws", [[su("u1", [{ type: "text", text: { toString: 1 } }])], "p"]],
    ["user content object", [[su("u1", { text: "x" })], "p"]],
    ["user content null item", [[su("u1", [null, { type: "text", text: "ok" }])], "p"]],
    ["other types", [[{ message: { type: "system", uuid: "s" } }, { message: { type: "result" } }, { message: "x" }, { message: 5 }], "p"]],
    ["null item throws", [[null], "p"]],
    ["no message throws", [[{}], "p"]],
    ["primitive item throws", [[5], "p"]],
    ["null message throws", [[{ message: null }], "p"]],
    ["assistant null block throws", [[sa("a1", "m", [null])], "p"]],
    ["inner message missing", [[{ message: { type: "assistant", uuid: "a" } }, { message: { type: "user", uuid: "u" } }], "p"]],
    ["empty", [[], "p"]],
  ],
);

// ---- user content

const GOAL = "<session-goal>ship it</session-goal>";
const REM = (b) => `<system-reminder>${b}</system-reminder>`;
const img = (data = "AAAA", media = "image/png") => ({ type: "image", source: { type: "base64", media_type: media, data } });
section("extractUserContent", us.extractUserContent, [
  ["plain string", ["hello"]],
  ["goal + reminders", [`${GOAL}\n\n${REM(" todos ")}\n${REM("date")}  real prompt`]],
  ["reminder then goal (goal stays)", [`${REM("a")}${GOAL}x`]],
  ["reminder mid text", [`hi ${REM("a")}`]],
  ["feff/nel whitespace", [`${FEFF}${REM(`${FEFF} body ${NEL}`)}${FEFF}rest`]],
  ["nel before reminder (not js space)", [`${NEL}${REM("a")}rest`]],
  ["unclosed reminder", [`${REM("a").slice(0, -3)}rest`]],
  ["only reminders", [`${REM("a")}${REM("b")}`]],
  ["case-sensitive tag", ["<System-Reminder>a</System-Reminder>x"]],
  ["array text and images", [[{ type: "text", text: "look " }, img(), { type: "text", text: " and " }, img("BBBB", "image/jpeg")]]],
  ["image without base64", [[img(), { type: "image", source: { type: "url", url: "http://x" } }, img("CCCC")]]],
  ["image url with data", [[{ type: "image", source: { type: "url", data: "DDDD", media_type: "image/png" } }]]],
  ["image bad fields", [[{ type: "image", source: { type: "base64", data: 5, media_type: "image/png" } }, { type: "image", source: { type: "base64", data: "x" } }, { type: "image", source: "base64" }, { type: "image" }]]],
  ["array reminders", [[{ type: "text", text: `${GOAL}${REM("r")}` }, { type: "text", text: "after" }]]],
  ["null, primitives, arrays", [[null, 5, "str", [1], { type: "text", text: "ok" }, { type: "text", text: 7 }]]],
  ["empty array", [[]]],
  ["null", [null]],
  ["lone halves join", [[{ type: "text", text: LONE_HI }, { type: "text", text: LONE_LO }, img(), { type: "text", text: LONE_LO }]]],
  ["undefined", []],
  ["number", [7]],
  ["object", [{ type: "text", text: "x" }]],
  ["unicode", [`${REM(`${LONE_HI}`)}${EMOJI}${LONE_LO}`]],
  ["huge", [{ $repeat: [REM("x"), 2000] }]],
]);

section("extractPeerOrigin", us.extractPeerOrigin, [
  ["undefined", []],
  ["null", [null]],
  ["string", ["peer"]],
  ["no origin", [{}]],
  ["null origin", [{ origin: null }]],
  ["human", [{ origin: { kind: "human", from: "a" } }]],
  ["peer minimal", [{ origin: { kind: "peer", from: "session-a" } }]],
  ["peer full", [{ origin: { kind: "peer", from: "a", name: "Alice", body: "hi", verifiedPeerPid: 4242, msg_id: "m1" } }]],
  ["peer empty strings", [{ origin: { kind: "peer", from: "a", name: "", body: "", msg_id: "" } }]],
  ["peer odd types", [{ origin: { kind: "peer", from: "a", name: 5, body: {}, msg_id: 7, verifiedPeerPid: "5" } }]],
  ["pid 0", [{ origin: { kind: "peer", from: "a", verifiedPeerPid: 0 } }]],
  ["pid -1", [{ origin: { kind: "peer", from: "a", verifiedPeerPid: -1 } }]],
  ["pid 1.5", [{ origin: { kind: "peer", from: "a", verifiedPeerPid: 1.5 } }]],
  ["pid max safe", [{ origin: { kind: "peer", from: "a", verifiedPeerPid: 9007199254740991 } }]],
  ["pid past safe", [{ origin: { kind: "peer", from: "a", verifiedPeerPid: 9007199254740992 } }]],
  ["pid 1e21", [{ origin: { kind: "peer", from: "a", verifiedPeerPid: 1e21 } }]],
  ["from empty", [{ origin: { kind: "peer", from: "" } }]],
  ["from number", [{ origin: { kind: "peer", from: 5 } }]],
  ["origin array", [{ origin: [] }]],
  ["origin string", [{ origin: "peer" }]],
  ["kind upper", [{ origin: { kind: "Peer", from: "a" } }]],
  ["unicode", [{ origin: { kind: "peer", from: `${LONE_HI}`, name: EMOJI } }]],
]);

// ---- tool results

const tr = (extra) => ({ type: "tool_result", tool_use_id: "toolu_1", ...extra });
const META_UNAVAIL = [{ id: "toolu_1", non_execution_kind: "automode-unavailable" }];
section("extractToolResult", us.extractToolResult, [
  ["undefined", []],
  ["string content", ["x"]],
  ["empty", [[]]],
  ["no tool_result", [[{ type: "text", text: "a" }]]],
  ["string", [[tr({ content: "ok" })]]],
  ["parts", [[tr({ content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }] })]]],
  ["parts odd", [[tr({ content: [null, "s", 5, [], { text: null }, { text: 5 }, { text: [1, [2, null], null] }, { text: true }, { text: {} }, { text: "" }] })]]],
  ["part toString throws", [[tr({ content: [{ text: { toString: "x" } }] })]]],
  ["content number", [[tr({ content: 5 })]]],
  ["content missing", [[tr({})]]],
  ["is_error true", [[tr({ content: "e", is_error: true })]]],
  ["is_error false", [[tr({ content: "e", is_error: false })]]],
  ["is_error odd", [[tr({ content: "e", is_error: "yes" })]]],
  ["is_error null", [[tr({ content: "e", is_error: null })]]],
  ["no tool_use_id", [[{ type: "tool_result", content: "x", is_error: true }], null, [{ non_execution_kind: "automode-unavailable" }]]],
  ["lone halves join", [[tr({ content: [{ text: LONE_HI }, { text: LONE_LO }, { text: LONE_LO }] })]]],
  ["staged", [[tr({ content: "x" })], { staged: true }]],
  ["staged not true", [[tr({ content: "x" })], { staged: "true", detachedToolCall: 1 }]],
  ["detached", [[tr({ content: "x" })], { detachedToolCall: true }]],
  ["tool_use_result array", [[tr({ content: "x" })], [true]]],
  ["tool_use_result string", [[tr({ content: "x" })], "staged"]],
  ["not run", [[tr({ content: "x", is_error: true })], null, META_UNAVAIL]],
  ["not run needs is_error", [[tr({ content: "x" })], null, META_UNAVAIL]],
  ["meta id mismatch", [[tr({ content: "x", is_error: true })], null, [{ id: "other", non_execution_kind: "automode-unavailable" }]]],
  ["meta other kind", [[tr({ content: "x", is_error: true })], null, [{ id: "toolu_1", non_execution_kind: "automode-blocked" }]]],
  ["meta not array", [[tr({ content: "x", is_error: true })], null, { id: "toolu_1", non_execution_kind: "automode-unavailable" }]],
  ["meta junk entries", [[tr({ content: "x", is_error: true })], null, [null, 5, [], ...META_UNAVAIL]]],
  ["all flags", [[tr({ content: "x", is_error: true })], { staged: true, detachedToolCall: true }, META_UNAVAIL]],
  ["first tool_result wins", [[{ type: "text" }, tr({ content: "one" }), tr({ tool_use_id: "t2", content: "two" })]]],
  ["null before tool_result throws", [[{ type: "text" }, null, tr({ content: "x" })]]],
  ["null after tool_result", [[tr({ content: "x" }), null]]],
  ["primitives skipped", [[5, "x", [], tr({ content: "x" })]]],
  ["unicode", [[tr({ content: [{ text: LONE_HI }, { text: `${LONE_LO}${EMOJI}` }] })]]],
]);

// ---- background bashes

const bash = (id, extra = {}) => ({ toolUseId: id, command: `cmd-${id}`, startedAt: 100, ...extra });
const bashArgs = (prev, toolUseId, toolUseResult, extra = {}) => [prev, { toolUseId, command: "sleep 99", toolUseResult, startedAt: 5000, ...extra }];
const bashRec = (...ids) => Object.fromEntries(ids.map((id) => [id, bash(id)]));
section(
  "applyBashAutoBackground",
  us.applyBashAutoBackground,
  [
    ["no result", bashArgs({}, "t1", undefined)],
    ["null result", bashArgs({}, "t1", null)],
    ["false result", bashArgs({}, "t1", false)],
    ["zero result", bashArgs({}, "t1", 0)],
    ["empty string result", bashArgs({}, "t1", "")],
    ["empty object", bashArgs({}, "t1", {})],
    ["string result", bashArgs({}, "t1", "abc")],
    ["array result", bashArgs({}, "t1", [1])],
    ["new by task id", bashArgs({}, "t1", { backgroundTaskId: "b1" })],
    ["new by timeout", bashArgs({}, "t1", { timedOutAfterMs: 120000 })],
    ["timeout zero", bashArgs({}, "t1", { timedOutAfterMs: 0 })],
    ["empty task id, timeout", bashArgs({}, "t1", { backgroundTaskId: "", timedOutAfterMs: 1 })],
    ["empty task id alone", bashArgs({}, "t1", { backgroundTaskId: "" })],
    ["ends with final response", bashArgs({}, "t1", { backgroundTaskId: "b1", backgroundEndsWithFinalResponse: true })],
    ["ends false", bashArgs({}, "t1", { backgroundTaskId: "b1", backgroundEndsWithFinalResponse: false })],
    ["merge existing", bashArgs({ t1: bash("t1", { bashId: "old", killed: true, timedOutAfterMs: 7, endsWithAgentFinalResponse: true }) }, "t1", { timedOutAfterMs: 9 })],
    ["merge existing, null fields", bashArgs({ t1: bash("t1", { bashId: "old", timedOutAfterMs: 7, endsWithAgentFinalResponse: false }) }, "t1", { backgroundTaskId: null, timedOutAfterMs: 1, backgroundEndsWithFinalResponse: null })],
    ["existing empty command", bashArgs({ t1: bash("t1", { command: "" }) }, "t1", { backgroundTaskId: "b" })],
    ["arg empty command", bashArgs({}, "t1", { backgroundTaskId: "b" }, { command: "" })],
    ["odd task id", bashArgs({}, "t1", { backgroundTaskId: 5 })],
    ["odd timeout", bashArgs({}, "t1", { backgroundTaskId: "b", timedOutAfterMs: "5" })],
    ["odd ends", bashArgs({}, "t1", { backgroundTaskId: "b", backgroundEndsWithFinalResponse: "x" })],
    ["order: new key last", bashArgs(bashRec("b", "a"), "c", { backgroundTaskId: "x" })],
    ["order: existing key stays", bashArgs(bashRec("b", "a", "c"), "a", { backgroundTaskId: "x" })],
    ["order: index keys", bashArgs(bashRec("b", "10", "a", "3"), "7", { backgroundTaskId: "x" })],
    ["order: index key past all", bashArgs(bashRec("1", "z"), "4294967294", { backgroundTaskId: "x" })],
    ["order: not an index", bashArgs(bashRec("1", "z"), "4294967295", { backgroundTaskId: "x" })],
    ["order: leading zero", bashArgs(bashRec("1", "z"), "01", { backgroundTaskId: "x" })],
    ["__proto__ key", bashArgs(bashRec("a"), "__proto__", { backgroundTaskId: "x" })],
    ["constructor key", bashArgs(bashRec("a"), "constructor", { backgroundTaskId: "x" })],
    ["unicode key", bashArgs({}, `${LONE_HI}${EMOJI}`, { backgroundTaskId: LONE_LO })],
  ],
  { show: (r) => pairs(r), same: true },
);

// ---- primary args

const PICK_NAMES = [
  "Bash", "BashOutput", "KillBash", "Edit", "MultiEdit", "Write", "Read", "NotebookEdit", "Glob", "Grep",
  "WebFetch", "WebSearch", "Task", "TodoWrite", "TaskCreate", "TaskUpdate", "TaskGet", "TaskList",
  "ExitPlanMode", "CronCreate", "CronDelete", "ScheduleWakeup", "Schedule", "RemoteTrigger",
  "mcp__github__get_issue", "", "bash", "Agent",
];
const PICK_INPUT = {
  command: "ls -la", bash_id: "b1", shell_id: "s1", file_path: "/a/b.ts", notebook_path: "/n.ipynb",
  pattern: "*.rs", url: "https://x", query: "q", description: "desc", subject: "subj", taskId: "7",
  cron: "*/5 * * * *", id: "cron-1", reason: "wait", action: "list", path: "/p",
};
const PROTO_NAMES = [
  "constructor", "toString", "__proto__", "hasOwnProperty", "valueOf", "isPrototypeOf",
  "propertyIsEnumerable", "toLocaleString", "__defineGetter__", "__defineSetter__",
  "__lookupGetter__", "__lookupSetter__",
];
section("pickPrimaryArg", us.pickPrimaryArg, [
  ...PICK_NAMES.map((n) => [`${n} full`, [n, PICK_INPUT]]),
  ["Bash empty command", ["Bash", { command: "" }]],
  ["KillBash order", ["KillBash", { bash_id: "b", shell_id: "s" }]],
  ["KillBash bash only", ["KillBash", { bash_id: "b" }]],
  ["fallback order", ["X", { path: "/p", query: "q" }]],
  ["fallback skips non-strings", ["X", { file_path: 5, command: "", pattern: null, url: "u" }]],
  ["Bash non-string", ["Bash", { command: ["ls"] }]],
  ["null input", ["Bash", null]],
  ["undefined input", ["Bash"]],
  ["string input", ["Bash", "ls"]],
  ["number input", ["Bash", 5]],
  ["array input", ["Read", ["/a"]]],
  ["empty input", ["Read", {}]],
  ...PROTO_NAMES.map((n) => [`${n} throws`, [n, { command: "x" }]]),
  ["constructor null input", ["constructor", null]],
  ["unicode", ["Read", { file_path: `${LONE_HI}/${EMOJI}` }]],
]);

// ---- chronology

const msg = (uuid, createdAt, extra = {}) => ({ uuid, role: "assistant", blocks: [], ...(createdAt === undefined ? {} : { createdAt }), ...extra });
let seed = 7;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed);
const big = Array.from({ length: 300 }, (_, i) => msg(`m${i}`, rand() % 7 === 0 ? undefined : 1000 + (rand() % 50)));
section(
  "sortMessagesByChronology",
  us.sortMessagesByChronology,
  [
    ["empty", [[]]],
    ["one", [[msg("a", 5)]]],
    ["sorted", [[msg("a", 1), msg("b", 2), msg("c", 2)]]],
    ["reversed", [[msg("a", 3), msg("b", 2), msg("c", 1)]]],
    ["ties stable", [[msg("a", 2), msg("b", 1), msg("c", 2), msg("d", 1)]]],
    ["carry forward", [[msg("a", 5), msg("b"), msg("c", 1), msg("d")]]],
    ["leading missing is 0", [[msg("a"), msg("b", -5), msg("c", 0)]]],
    ["negatives and fractions", [[msg("a", 0.5), msg("b", -0.25), msg("c", 1e21), msg("d", -1e21)]]],
    ["huge spread", [[msg("a", 1.7976931348623157e308), msg("b", -1.7976931348623157e308), msg("c", 0)]]],
    ["all missing", [[msg("a"), msg("b")]]],
    ["big", [big]],
  ],
  { prep: ([l]) => [toMsgs(l)], show: (r) => r.map((m) => m.uuid), same: true },
);

// ---- tool result patching

const withTools = (uuid, ...ids) => ({ uuid, role: "assistant", blocks: [text("t"), ...ids.map((id) => toolUse(id))], foldedSdkUuids: [uuid] });
const RESULT = { content: "done", isError: false };
section(
  "applyToolResultToList",
  us.applyToolResultToList,
  [
    ["match", [[withTools("m1", "t1"), withTools("m2", "t2")], "t1", RESULT]],
    ["match twice in one", [[withTools("m1", "t1", "t1", "t2")], "t1", RESULT]],
    ["match in two", [[withTools("m1", "t1"), withTools("m2", "t1")], "t1", { content: "x", isError: true, staged: true, detached: true, notRun: true }]],
    ["no match", [[withTools("m1", "t1")], "t9", RESULT]],
    ["empty list", [[], "t1", RESULT]],
    ["clear result", [[{ ...withTools("m1"), blocks: [toolUse("t1", "Bash", {}, { result: RESULT, startedAt: 5 })] }], "t1"]],
    ["empty id matches empty", [[withTools("m1", "")], "", RESULT]],
    ["text block id ignored", [[{ uuid: "m", role: "user", blocks: [text("t1")] }], "t1", RESULT]],
  ],
  { prep: ([l, ...rest]) => [toMsgs(l), ...rest], same: true },
);
section(
  "applyToolResultToTrails",
  us.applyToolResultToTrails,
  [
    ["no match", [{ p1: [withTools("m1", "t1")] }, "t9", RESULT]],
    ["match second", [{ p1: [withTools("m1", "t1")], p2: [withTools("m2", "t2")] }, "t2", RESULT]],
    ["match all", [{ b: [withTools("m1", "t1")], 3: [withTools("m2", "t1")], a: [] }, "t1", RESULT]],
    ["empty", [{}, "t1", RESULT]],
  ],
  { prep: ([t, ...rest]) => [toTrails(t), ...rest], show: (r) => pairs(r), same: true },
);

// ---- compaction

section("nextTranscriptPath", us.nextTranscriptPath, [
  ["no key", ["/old", {}]],
  ["path", ["/old", { transcriptPath: "/new" }]],
  ["null", ["/old", { transcriptPath: null }]],
  ["empty", ["/old", { transcriptPath: "" }]],
  ["number path", ["/old", { transcriptPath: 5 }]],
  ["prev null", [null, {}]],
  ["array event", ["/old", []]],
  ["null event throws", ["/old", null]],
  ["string event throws", ["/old", "abc"]],
  ["number event throws", ["/old", 5]],
  ["bool event throws", ["/old", true]],
  ["unicode", [null, { transcriptPath: `/${LONE_HI}` }]],
]);

const summaryRec = (uuid, content, extra = {}) => ({ type: "user", uuid, message: { role: "user", content }, ...extra });
const SUMMARY = "This session is being continued from a previous conversation that ran out of context.\n\nSummary: ...";
const boundary = (uuid, after, extra = {}) => ({ uuid, afterMessageUuid: after, kind: "compact_boundary", label: "Compacted earlier conversation", ...extra });
const info = (uuid) => ({ uuid, afterMessageUuid: "x", kind: "info", label: "i" });
section(
  "withPagedCompactBoundary",
  us.withPagedCompactBoundary,
  [
    ["has more", [[], [summaryRec("s1", SUMMARY)], true]],
    ["by content", [[], [summaryRec("s1", `  ${SUMMARY}  `)], false]],
    ["by flag", [[info("i1")], [summaryRec("s1", "short", { isCompactSummary: true })], false]],
    ["flag not true", [[], [summaryRec("s1", "short", { isCompactSummary: "true" })], false]],
    ["array content", [[], [summaryRec("s1", [{ type: "text", text: SUMMARY }, { type: "text", text: " more" }, { type: "image" }])], false]],
    ["truthy non-string text", [[], [summaryRec("s1", [{ type: "text", text: 5 }], { isCompactSummary: true })], false]],
    ["lone halves join", [[], [summaryRec("s1", [{ type: "text", text: LONE_HI }, { type: "text", text: LONE_LO }], { isCompactSummary: true })], false]],
    ["toString object throws", [[], [summaryRec("s1", [{ type: "text", text: { toString: 0 } }], { isCompactSummary: true })], false]],
    ["empty summary text", [[], [summaryRec("s1", "   ", { isCompactSummary: true })], false]],
    ["subagent summary skipped", [[], [summaryRec("s1", SUMMARY, { parent_tool_use_id: "p" })], false]],
    ["no uuid", [[], [summaryRec(undefined, SUMMARY)], false]],
    ["empty uuid", [[], [summaryRec("", SUMMARY)], false]],
    ["number uuid", [[], [summaryRec(5, SUMMARY)], false]],
    ["first summary wins", [[], [summaryRec("", SUMMARY), summaryRec("s2", SUMMARY)], false]],
    ["divider for summary exists", [[boundary("s1", "m1")], [summaryRec("s1", SUMMARY)], false]],
    ["divider for page system record", [[boundary("sys1", "m1")], [{ type: "system", uuid: "sys1" }, summaryRec("s1", SUMMARY)], false]],
    ["anchorless divider exists", [[boundary("zzz", "")], [summaryRec("s1", SUMMARY)], false]],
    ["other divider", [[boundary("zzz", "m1"), info("s1")], [{ type: "system", uuid: 5 }, summaryRec("s1", SUMMARY)], false]],
    ["junk records", [[], [null, 5, "x", [], { type: "user" }, summaryRec("s1", SUMMARY)], false]],
    ["message not object", [[], [{ type: "user", uuid: "s1", message: SUMMARY }], false]],
    ["no summary", [[], [summaryRec("u1", "hello")], false]],
  ],
  { same: true },
);

section(
  "mergeCompactBoundary",
  us.mergeCompactBoundary,
  [
    ["new with stats", [[], "b1", "m1", { compactStats: { preTokens: 100, trigger: "auto" } }]],
    ["new with summary", [[info("i")], "b1", "m1", { compactSummary: "sum" }]],
    ["new empty patch", [[], "b1", "m1", {}]],
    ["new empty summary", [[], "b1", "m1", { compactSummary: "" }]],
    ["merge by uuid", [[boundary("b1", "m1", { compactStats: { preTokens: 1, postTokens: 2 } })], "b1", "zz", { compactStats: { postTokens: 3, durationMs: 4 } }]],
    ["merge overrides every stat", [[boundary("b1", "m1", { compactStats: { preTokens: 1, postTokens: 2, durationMs: 3, trigger: "auto" } })], "b1", "m1", { compactStats: { preTokens: 10, postTokens: 20, durationMs: 30, trigger: "manual" } }]],
    ["merge by anchor", [[boundary("b0", "m1", { compactSummary: "old" })], "b1", "m1", { compactSummary: "new" }]],
    ["merge keeps summary", [[boundary("b1", "m1", { compactSummary: "old" })], "b1", "m1", { compactSummary: "" }]],
    ["merge stats into none", [[boundary("b1", "m1")], "b1", "m1", { compactStats: { trigger: "manual" } }]],
    ["first match", [[boundary("b1", "x"), boundary("b2", "m1")], "b2", "x", { compactSummary: "s" }]],
    ["non-boundary same uuid", [[info("b1")], "b1", "m1", { compactSummary: "s" }]],
  ],
);

section("normalizeCompactStats", us.normalizeCompactStats, [
  ["undefined", []],
  ["null", [null]],
  ["number", [5]],
  ["string", ["x"]],
  ["array", [[1]]],
  ["empty", [{}]],
  ["snake", [{ pre_tokens: 1000, post_tokens: 200, duration_ms: 1500, trigger: "auto" }]],
  ["camel", [{ preTokens: 1, postTokens: 2, durationMs: 3, trigger: "manual" }]],
  ["snake wins", [{ pre_tokens: 1, preTokens: 2 }]],
  ["non-number snake", [{ pre_tokens: "1", preTokens: 2 }]],
  ["zero and negative", [{ pre_tokens: 0, duration_ms: -1 }]],
  ["fractions", [{ post_tokens: 0.5 }]],
  ["empty trigger", [{ trigger: "" }]],
  ["trigger only", [{ trigger: "auto" }]],
  ["trigger non-string", [{ trigger: 5, durationMs: null }]],
  ["big", [{ pre_tokens: 1e21 }]],
]);

// ---- older pages

const user = (uuid, content, extra = {}) => ({ type: "user", uuid, message: { role: "user", content }, ...extra });
const asst = (uuid, id, content, extra = {}) => ({ type: "assistant", uuid, message: { id, role: "assistant", content }, ...extra });
const T0 = "2026-11-16T10:00:00.000Z";
section("synthesizeOlder", us.synthesizeOlder, [
  [
    "a turn",
    [[
      user("u1", "list files", { timestamp: T0 }),
      asst("a1", "msg_1", [{ type: "text", text: "Sure" }]),
      asst("a2", "msg_1", [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }]),
      user("u2", [{ type: "tool_result", tool_use_id: "toolu_1", content: "a\nb" }]),
      asst("a3", "msg_1", [{ type: "text", text: "Two files" }]),
      asst("a4", "msg_2", [{ type: "text", text: "Anything else?" }]),
      user("u3", "no", { timestamp: "2026-11-16T10:05:00Z" }),
      asst("a5", "msg_3", "bye"),
    ]],
  ],
  [
    "splits fold, refold ignored, tool ids dedupe",
    [[
      asst("a1", "m", [{ type: "tool_use", id: "t", name: "Read", input: {} }]),
      asst("a1", "m", [{ type: "text", text: "dup" }]),
      asst("a2", "m", [{ type: "tool_use", id: "t", name: "Read", input: {} }, { type: "text", text: "x" }, { type: "text", text: "x" }]),
    ]],
  ],
  [
    "tool results",
    [[
      asst("a1", "m1", [{ type: "tool_use", id: "t1", name: "Edit", input: {} }, { type: "tool_use", id: "t2", name: "Write", input: {} }]),
      asst("a2", "m2", [{ type: "tool_use", id: "t1", name: "Edit", input: {} }]),
      user("r1", [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "ok" }], is_error: false }], { tool_use_result: { staged: true } }),
      user("r2", [{ type: "tool_result", tool_use_id: "t2", content: "no", is_error: true }], { tool_result_meta: [{ id: "t2", non_execution_kind: "automode-unavailable" }] }),
      user("r3", [{ type: "tool_result", tool_use_id: "t9", content: "orphan" }]),
      user("r4", [{ type: "tool_result", tool_use_id: "t1", content: "late" }], { tool_use_result: { detachedToolCall: true } }),
    ]],
  ],
  [
    "plumbing dropped",
    [[
      user("p1", "<task-notification>\n<task-id>x</task-id></task-notification>"),
      user("p2", "This session is being continued from a previous conversation. Summary"),
      user("p3", "<local-command-caveat>Caveat: ...</local-command-caveat>"),
      user("p4", "[Image: original 2360x2000, displayed at 2000x1695. Multiply coordinates by 1.18 to map to original image.]"),
      user("p5", "/compact"),
      user("p6", "/compact keep the API notes"),
      user("p7", [{ type: "text", text: "/btw" }, { type: "text", text: " why?" }]),
      user("p8", "<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>"),
      user("p9", "<local-command-stdout>Set model to opus</local-command-stdout>"),
      user("p10", "<command-name>/review</command-name><command-args></command-args>\n\nplease look at auth"),
      user("p11", "<local-command-stderr>oops</local-command-stderr> <b>tag</b>"),
      user("p12", "x", { isMeta: true }),
      user("p13", "y", { isCompactSummary: true }),
      user("p14", "z", { isVisibleInTranscriptOnly: true }),
      user("p15", "/model opus"),
      user("p16", "/unknown-cmd"),
      user("p17", "/fast on"),
      user("p18", "/Compact"),
      user("p19", "<COMMAND-NAME>/x</COMMAND-NAME>after"),
      user("p20", [{ type: "text", text: "/compact" }, img()]),
      user("p21", "[Image: original 1x1, displayed at 1x1. Multiply coordinates by 1 to map to original image.] hi"),
      asst("a1", "m1", "real"),
    ]],
  ],
  [
    "subagent and junk",
    [[
      null,
      5,
      "x",
      [],
      { type: "system", uuid: "s" },
      user("", "no uuid"),
      user(5, "number uuid"),
      user("u1", "child", { parent_tool_use_id: "toolu_p" }),
      asst("a1", "m", "child", { parent_tool_use_id: "toolu_p" }),
      user("u2", "kept", { parent_tool_use_id: "" }),
      user("u3", "kept too", { parent_tool_use_id: null }),
    ]],
  ],
  [
    "timestamps carry",
    [[
      asst("a0", "m0", "before any user"),
      user("u1", "hi", { timestamp: "2026-11-16T10:00:00Z" }),
      asst("a1", "m1", "one"),
      asst("a2", "m2", "two"),
      asst("a2b", "m2", "two-b"),
      user("u2", "bad ts", { timestamp: "not a date" }),
      asst("a3", "m3", "three"),
      user("u3", "local ts", { timestamp: "2026-03-08T02:30:00" }),
      asst("a4", "m4", "four"),
      user("u4", "date only", { timestamp: "2026-01-01" }),
      user("u5", "number ts", { timestamp: 1763300000000 }),
      asst("a5", "m5", "five"),
      user("u6", "offset", { timestamp: "2026-11-16T12:00:00+05:30" }),
      user("u7", "rfc", { timestamp: "Mon, 16 Nov 2026 10:00:00 GMT" }),
    ]],
  ],
  [
    "users",
    [[
      user("u1", [{ type: "text", text: "see " }, img(), { type: "text", text: " ok" }]),
      user("u2", `<session-goal>g</session-goal>${REM("todos")}real`),
      user("u3", ""),
      user("u4", [img()]),
      user("u5", "typed", { origin: { kind: "peer", from: "sess-b", name: "Bob", body: "decoded", verifiedPeerPid: 77, msg_id: "mm" } }),
      user("u6", "typed", { origin: { kind: "peer", from: "sess-b" } }),
      user("u7", "", { origin: { kind: "peer", from: "sess-b", body: "only body" } }),
      user("u8", "human", { origin: { kind: "human" } }),
      user("u9", 5),
      user("u10", null),
    ]],
  ],
  [
    "assistant flags",
    [[
      asst("a1", "m1", [{ type: "text", text: "You've hit your Opus limit \u00b7 resets 5pm" }]),
      asst("a2", "m2", [{ type: "text", text: "We are experiencing high demand for Opus 4." }]),
      asst("a3", "m3", [{ type: "text", text: FABLE_404 }]),
      asst("a4", "m4", [{ type: "text", text: "There's an issue with the selected model (claude-opus-9)." }]),
      asst("a5", "m5", [{ type: "text", text: "You've hit your limit" }, { type: "tool_use", id: "t", name: "x", input: {} }]),
      asst("a6", "", "no message id"),
      asst("a7", 5, "number message id"),
      { type: "assistant", uuid: "a8" },
      { type: "assistant", uuid: "a9", message: "str" },
      asst("a10", "m10", [{ type: "redacted_thinking" }, { type: "thinking", thinking: "hmm" }]),
    ]],
  ],
  ["assistant null block throws", [[asst("a1", "m", [null])]]],
  ["tool result null block throws", [[asst("a1", "m", "x"), user("u1", [null])]]],
  ["slash toString object throws", [[user("u1", [{ type: "text", text: { toString: 1 } }])]]],
  ["empty", [[]]],
]);

section("toolProgressInfoFromSdkMessage", us.toolProgressInfoFromSdkMessage, [
  ["main", [{ type: "tool_progress", tool_use_id: "t1", tool_name: "Bash", elapsed_time_seconds: 3, parent_tool_use_id: null }]],
  ["subagent", [{ tool_use_id: "t1", tool_name: "Read", elapsed_time_seconds: 0.5, parent_tool_use_id: "p", subagent_type: "Explore" }]],
  [
    "retry",
    [{
      tool_use_id: "t",
      tool_name: "Task",
      elapsed_time_seconds: 12,
      parent_tool_use_id: "p",
      subagent_retry: { agent_id: "ag", attempt: 2, max_retries: 5, retry_delay_ms: 4000, error_status: 529, error_category: "overloaded" },
    }],
  ],
  ["retry null status", [{ tool_use_id: "t", tool_name: "n", elapsed_time_seconds: 0, parent_tool_use_id: null, subagent_retry: { agent_id: "a", attempt: 1, max_retries: 1, retry_delay_ms: 0, error_status: null, error_category: "network" } }]],
  ["retry falsy", [{ tool_use_id: "t", tool_name: "n", elapsed_time_seconds: 1, parent_tool_use_id: null, subagent_retry: null }]],
  ["retry zero", [{ tool_use_id: "t", tool_name: "n", elapsed_time_seconds: 1, parent_tool_use_id: null, subagent_retry: 0 }]],
  ["missing fields", [{}]],
  ["odd types", [{ tool_use_id: 1, tool_name: null, elapsed_time_seconds: "3", parent_tool_use_id: 5, subagent_type: 5, subagent_retry: true }]],
  ["null throws", [null]],
  ["unicode", [{ tool_use_id: LONE_HI, tool_name: EMOJI, elapsed_time_seconds: 1e21, parent_tool_use_id: LONE_LO }]],
]);

// ---- upsertAssistantSplit

const UPSERT_ORDER = [
  "prev", "messageId", "sdkUuid", "newBlocks", "hasStreamScratch", "parentToolUseId", "at",
  "rateLimitHit", "opusHighDemand", "aborted", "errorTag",
];
const existing = (blocks, extra = {}) => ({ uuid: "msg_1", role: "assistant", blocks, foldedSdkUuids: ["sdk_prev"], streaming: true, ...extra });
const up = (o) => [{ messageId: "msg_1", sdkUuid: "sdk_new", newBlocks: [], hasStreamScratch: false, ...o }];
const HIT = { rateLimitType: "five_hour", resetsAt: 1763303600 };
section(
  "upsertAssistantSplit",
  (o) => us.upsertAssistantSplit(...UPSERT_ORDER.map((k) => o[k])),
  [
    ["new bubble", up({ prev: [], newBlocks: [text("hi")] })],
    ["new bubble, scratch", up({ prev: [], newBlocks: [text("hi")], hasStreamScratch: true })],
    ["new bubble, all tags", up({ prev: [existing([], { uuid: "other" })], newBlocks: [text("x")], parentToolUseId: "p", at: 1000, rateLimitHit: HIT, opusHighDemand: true, aborted: true, errorTag: "server_error" })],
    ["new bubble, falsy tags", up({ prev: [], parentToolUseId: "", at: 0, opusHighDemand: false, aborted: false, errorTag: "" })],
    ["new bubble, null parent", up({ prev: [], parentToolUseId: null, at: null })],
    ["new bubble, empty rate hit", up({ prev: [], rateLimitHit: {} })],
    ["fold dedupe", up({ prev: [existing([text("a"), thinking("t"), toolUse("tu1")])], newBlocks: [text("a"), text("b"), thinking("t"), thinking("u"), toolUse("tu1"), toolUse("tu2"), text("")] })],
    ["fold, duplicates within the split", up({ prev: [existing([])], newBlocks: [text("b"), text("b"), thinking(""), thinking(""), toolUse("x"), toolUse("x")] })],
    ["fold, empty thinking dedupes", up({ prev: [existing([thinking("")])], newBlocks: [thinking(""), thinking("", true)] })],
    ["fold, nothing new", up({ prev: [existing([text("a")])], newBlocks: [text("a")] })],
    ["already folded, streaming", up({ prev: [existing([text("a")])], sdkUuid: "sdk_prev", newBlocks: [text("b")] })],
    ["already folded, settled", up({ prev: [existing([text("a")], { streaming: false })], sdkUuid: "sdk_prev", newBlocks: [text("b")] })],
    ["already folded, no streaming key", up({ prev: [existing([text("a")], { streaming: undefined })], sdkUuid: "sdk_prev" })],
    ["no folded set", up({ prev: [{ uuid: "msg_1", role: "assistant", blocks: [text("a")] }], newBlocks: [text("b")] })],
    ["sticky: keep existing tags", up({ prev: [existing([], { rateLimitHit: { rateLimitType: "seven_day" }, opusHighDemand: true, aborted: true, errorTag: "billing_error" })], rateLimitHit: HIT, opusHighDemand: false, aborted: false, errorTag: "server_error" })],
    ["sticky: adopt new tags", up({ prev: [existing([])], rateLimitHit: HIT, opusHighDemand: true, aborted: true, errorTag: "server_error" })],
    ["sticky: existing false flags", up({ prev: [existing([], { opusHighDemand: false, aborted: false, errorTag: "" })], errorTag: "late" })],
    ["sticky: new empty tag", up({ prev: [existing([])], errorTag: "" })],
    ["sticky: existing empty tag, no new", up({ prev: [existing([], { errorTag: "" })] })],
    ["fold keeps createdAt and parent", up({ prev: [existing([], { createdAt: 5, parentToolUseId: "p" })], at: 99, parentToolUseId: "q" })],
    ["first of duplicate uuids", up({ prev: [existing([text("1")]), existing([text("2")], { foldedSdkUuids: ["z"] })], newBlocks: [text("3")] })],
    ["user bubble with same uuid", up({ prev: [{ uuid: "msg_1", role: "user", blocks: [text("u")] }], newBlocks: [text("a")] })],
    ["unicode", up({ prev: [], messageId: LONE_HI, sdkUuid: EMOJI, newBlocks: [text(LONE_LO)] })],
  ],
  {
    prep: ([o]) => [{ ...o, prev: toMsgs(o.prev) }],
    show: (r, [o]) => ({ list: enc(r), same: r === o.prev }),
  },
);

// ---- the filters and the slash registry

const FILTER_CONTENTS = [
  ["undefined", undefined],
  ["null", null],
  ["number", 5],
  ["object", { type: "text", text: "/compact" }],
  ["empty string", ""],
  ["spaces", `  ${FEFF}`],
  ["/compact", "/compact"],
  ["/compact args", `  /compact   keep ${NEL} notes ${FEFF}`],
  ["/compact nel", `/compact${NEL}x`],
  ["/compact feff", `/compact${FEFF}x`],
  ["/compact ideo", `/compact${IDEO}x`],
  ["/compact newline args", "/compact\nline1\nline2"],
  ["/review alias", "/code-review 123"],
  ["/fast on", "/fast on"],
  ["/model", "/model opus"],
  ["/unknown", "/unknown"],
  ["//compact", "//compact"],
  ["/compact/x", "/compact/x"],
  ["/ alone", "/"],
  ["/Compact", "/Compact"],
  ["slash array", [{ type: "text", text: "/btw" }, { type: "text", text: " why" }]],
  ["slash array with image", [{ type: "text", text: "/btw" }, { type: "image" }]],
  ["slash array empty text", [{ type: "text", text: "" }, { type: "text", text: "/btw" }]],
  ["slash array truthy number", [{ type: "text", text: "/init" }, { type: "text", text: 0 }]],
  ["slash array number text", [{ type: "text", text: 5 }]],
  ["slash array toString throws", [{ type: "text", text: { toString: 1 } }]],
  ["slash array null item", [null]],
  ["slash array lone halves", [{ type: "text", text: `/btw ${LONE_HI}` }, { type: "text", text: LONE_LO }]],
  ["wrapper array lone halves", [{ type: "text", text: `<local-command-stdout>${LONE_HI}` }, { type: "text", text: `${LONE_LO}</local-command-stdout>` }]],
  ["command wrapper", "<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args> opus </command-args>"],
  ["command wrapper upper", "<COMMAND-NAME> /Model </COMMAND-NAME>"],
  ["command wrapper trailing", "<command-name>/x</command-name>  hello there  "],
  ["command wrapper trailing tag", "<command-name>/x</command-name><skill>body</skill>"],
  ["command wrapper args before message", "<command-name>/x</command-name><command-args>a</command-args><command-message>m</command-message>tail"],
  ["command wrapper long s", `<command-name>/x</command-name><command-me${LONG_S}sage>m</command-message>`],
  ["command wrapper kelvin", `<command-name>/x</command-name><command-args>${KELVIN}</command-args>`],
  ["command wrapper no slash", "<command-name>model</command-name>"],
  ["command wrapper spaces in name", "<command-name>/a b</command-name>"],
  ["command wrapper unicode", `<command-name>/${E_ACUTE}${EMOJI}</command-name>${LONE_HI}`],
  ["stdout", "<local-command-stdout>  Set model  </local-command-stdout>"],
  ["stdout trailing", "<local-command-stdout>a</local-command-stdout>\nreal words"],
  ["stdout multiline", "<local-command-stdout>a\nb</local-command-stdout><local-command-stdout>c</local-command-stdout>"],
  ["stderr", "<LOCAL-COMMAND-STDERR>err</local-command-stderr> x"],
  ["stdout not at start", "x<local-command-stdout>a</local-command-stdout>"],
  ["wrapper array", [{ type: "text", text: "  <local-command-stdout>a</local-command-stdout>" }, { type: "image" }, { type: "text", text: 5 }]],
  ["caveat", "<local-command-caveat>Caveat</local-command-caveat>"],
  ["caveat upper", "<LOCAL-COMMAND-CAVEAT>x"],
  ["caveat no boundary", "<local-command-caveats>"],
  ["caveat feff", `<local-command-caveat${FEFF}`],
  ["caveat nel", `<local-command-caveat${NEL}`],
  ["summary", `\n${SUMMARY}`],
  ["summary array", [{ type: "text", text: SUMMARY }]],
  ["summary lower", SUMMARY.toLowerCase()],
  ["summary mid-text", `Note: ${SUMMARY}`],
  ["resize note", "[Image: original 2360x2000, displayed at 2000x1695. Multiply coordinates by 1.18 to map to original image.]"],
  ["resize notes", "[Image: original 1x2, displayed at 3x4. Multiply coordinates by . to map to original image.]\n[Image: original 5x6, displayed at 7x8. Multiply coordinates by 2 to map to original image.]  "],
  ["resize note arabic digits", `[Image: original ${U(0x661)}x2, displayed at 3x4. Multiply coordinates by 1 to map to original image.]`],
  ["resize note nel", `[Image: original 1x2, displayed at 3x4. Multiply coordinates by 1 to map to original image.]${NEL}[Image: original 1x2, displayed at 3x4. Multiply coordinates by 1 to map to original image.]`],
  ["resize note array", [{ type: "text", text: "[Image: original 1x2, displayed at 3x4. Multiply coordinates by 1 to map to original image.]" }]],
  ["resize note array with image", [{ type: "text", text: "[Image: original 1x2, displayed at 3x4. Multiply coordinates by 1 to map to original image.]" }, { type: "image" }]],
  ["resize note array null", [null]],
  ["resize note array with null", [{ type: "text", text: "[Image: original 1x2, displayed at 3x4. Multiply coordinates by 1 to map to original image.]" }, null]],
  ["resize note array with document", [{ type: "text", text: "[Image: original 1x2, displayed at 3x4. Multiply coordinates by 1 to map to original image.]" }, { type: "document" }]],
  ["task notification", "  <task-notification>\n<task-id>1</task-id>"],
  ["task notification upper", "<TASK-NOTIFICATION>"],
  ["task notification feff", `<task-notification${FEFF}`],
  ["task notification array", [{ type: "text", text: "<task-notification>" }]],
  ["plain", "hello"],
];
sections.sdkFilters = FILTER_CONTENTS.map(([label, content]) => {
  const stored = content === undefined ? undefined : JSON.parse(JSON.stringify(content));
  const each = (f) => {
    try {
      return { out: enc(f(stored)) };
    } catch (e) {
      return { throws: `${e?.name}: ${e?.message}` };
    }
  };
  return {
    name: label,
    ...(stored === undefined ? {} : { content: stored }),
    isSdkSlashUserMessage: each(filters.isSdkSlashUserMessage),
    parseSyntheticCliWrapper: each(filters.parseSyntheticCliWrapper),
    isCompactSummaryContent: each(filters.isCompactSummaryContent),
    isLocalCommandCaveatContent: each(filters.isLocalCommandCaveatContent),
    isImageResizeNoteContent: each(filters.isImageResizeNoteContent),
    isSyntheticTaskNotification: each(filters.isSyntheticTaskNotification),
  };
});
section(
  "isSdkInternalEnvelope",
  filters.isSdkInternalEnvelope,
  [
    ["undefined", []],
    ["null", [null]],
    ["string", ["isMeta"]],
    ["empty", [{}]],
    ["isMeta", [{ isMeta: true }]],
    ["isMeta truthy", [{ isMeta: 1 }]],
    ["isCompactSummary", [{ isCompactSummary: true }]],
    ["isVisibleInTranscriptOnly", [{ isVisibleInTranscriptOnly: true }]],
    ["all false", [{ isMeta: false, isCompactSummary: "true", isVisibleInTranscriptOnly: null }]],
    ["array", [[true]]],
  ],
);

const REMINDER_TEXTS = [
  "plain",
  `${GOAL}rest`,
  `  ${GOAL}  ${GOAL}rest`,
  `${FEFF}${GOAL}${FEFF}rest`,
  `${NEL}${GOAL}rest`,
  `<session-goal>a\nb</session-goal>\n\nrest`,
  `${REM(" a ")}${REM(`${FEFF}b${NEL}`)} rest`,
  `${REM("a")} x ${REM("b")}`,
  `${REM("<system-reminder>nested")}</system-reminder>tail`,
  "",
];
sections.userPrompt = REMINDER_TEXTS.map((t) => ({
  text: t,
  stripGoalReminder: prompt.stripGoalReminder(t),
  splitLeadingSystemReminders: prompt.splitLeadingSystemReminders(t),
}));

const ids = SLASH_COMMANDS.map((c) => c.id);
if (new Set(ids).size !== ids.length) throw new Error("SLASH_COMMANDS has a duplicate id: update the recorder");
sections.sdkSlashCommands = SLASH_COMMANDS.filter((c) => c.handler === "sdk" || c.forwardsArgsToSdk).map((c) => c.id);
sections.slashNames = SLASH_COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])]).map((n) => ({
  name: n,
  out: enc(filters.isSdkSlashUserMessage(`/${n} arg`)),
}));

writeFileSync(
  join(ROOT_DIR, "out.json"),
  `${JSON.stringify({ node: process.version, tz: process.env.TZ, now: NOW, sections }, null, 1)}\n`,
);
