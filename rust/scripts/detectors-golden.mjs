#!/usr/bin/env node
// Golden fixture for the session's nudge detectors (S20), recorded from the
// real TS sources:
//
//   node rust/scripts/detectors-golden.mjs     (node@22)
//
// Re-runs itself under `--experimental-transform-types` with HOME and
// CLAUDE_CONFIG_DIR at a temp dir and an `@/` resolve hook, twice; both
// recordings must agree byte for byte. Records:
//
// - `constants`: `OPUS_OVERLOAD_NUDGE_THRESHOLD` (read from session.ts, where
//   it isn't exported) and `TOKEN_EXPIRY_WARNING_WINDOW_MS`;
// - `texts`: `isOverloadErrorText` / `isAuthFailedErrorText` /
//   `isOAuthRevokedText`;
// - `models`: `isOpusModelId` (an absent `model` is `undefined`);
// - `messages`: `isOverloadSignal` / `isBillingErrorSignal` /
//   `isAuthFailedSignal` / `isOAuthRevokedSignal`;
// - `expiry`: `shouldWarnTokenExpiring(expiresAt, now)`. Numbers JSON can't
//   hold are `{"$num": "NaN" | "Infinity" | "-Infinity" | "-0"}`, `undefined`
//   is `{"$undefined": true}`;
// - `sessions`: the real `Session.prototype` methods `noteOverloadObservation`,
//   `noteLongContextCreditsObservation`, `noteAuthFailedObservation` and
//   `noteTokenExpiringAtStartup` on a bare session object (the class fields
//   they use at their initial values, `broadcast` recorded, `Date.now`
//   pinned per step), called the way `consume()` and `broadcast()` call them.
//   Those call sites are checked against session.ts's syntax tree first (each
//   statement's text, its enclosing conditions and their order), and every
//   write to the nudge fields in the class is accounted for. Steps: `live`
//   (a message from the SDK iterator), `replay` (a message broadcast while
//   the transcript replays), `thrown` (the iterator throws an Error with that
//   message) and `model` (the session's model changes). After each step: the
//   events broadcast, as `JSON.stringify` text, and the fields.
//
// Written to rust/crates/claudius-core/tests/fixtures/detectors_golden.json
// and replayed by crates/claudius-core/tests/detectors_golden.rs.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "crates/claudius-core/tests/fixtures/detectors_golden.json");

// ------------------------------- recording -------------------------------

if (!process.env.DETECTORS_GOLDEN_CHILD) {
  const runs = [0, 1].map(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "detectors-golden-")));
    try {
      mkdirSync(join(root, "home"));
      const r = spawnSync(
        process.execPath,
        ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url)],
        {
          cwd: repo,
          encoding: "utf8",
          maxBuffer: 1 << 26,
          env: {
            PATH: process.env.PATH,
            HOME: join(root, "home"),
            CLAUDE_CONFIG_DIR: join(root, "config"),
            DETECTORS_GOLDEN_CHILD: root,
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
  if (runs[0] !== runs[1]) {
    console.error("detectors-golden: the two runs disagree");
    process.exit(1);
  }
  const fixture = JSON.parse(runs[0]);
  writeFileSync(out, `${JSON.stringify(fixture, null, 1)}\n`);
  const steps = fixture.sessions.reduce((n, c) => n + c.steps.length, 0);
  const fired = fixture.sessions.reduce((n, c) => n + c.steps.reduce((m, s) => m + s.events.length, 0), 0);
  console.log(
    `wrote ${out.slice(repo.length + 1)}: ${fixture.texts.length} texts, ${fixture.models.length} models, ${fixture.messages.length} messages, ${fixture.expiry.length} expiry cases, ${fixture.sessions.length} sessions (${steps} steps, ${fired} nudges) (stable)`,
  );
  process.exit(0);
}

// --------------------------------- child ---------------------------------

const ROOT_DIR = process.env.DETECTORS_GOLDEN_CHILD;

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
    // A bare CJS subpath without an exports map (\`next/server\`).
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

const lib = (p) => pathToFileURL(join(repo, "lib/server", p)).href;
const { isOpusModelId, isOverloadErrorText, isOverloadSignal } = await import(lib("opus-overload-detector.ts"));
const { isBillingErrorSignal } = await import(lib("long-context-credits-detector.ts"));
const { isAuthFailedErrorText, isAuthFailedSignal, isOAuthRevokedSignal, isOAuthRevokedText } = await import(
  lib("auth-failed-detector.ts")
);
const { TOKEN_EXPIRY_WARNING_WINDOW_MS, shouldWarnTokenExpiring } = await import(lib("token-expiry.ts"));
const { Session } = await import(lib("session.ts"));
const { default: ts } = await import("typescript");

// ------------------------- the call sites in session.ts -------------------------

const SOURCE = readFileSync(join(repo, "lib/server/session.ts"), "utf8");
const sf = ts.createSourceFile("session.ts", SOURCE, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const norm = (s) => s.replace(/\s+/g, " ").trim();

let sessionClass;
let threshold;
ts.forEachChild(sf, (n) => {
  if (ts.isClassDeclaration(n) && n.name?.text === "Session") sessionClass = n;
  if (ts.isVariableStatement(n)) {
    for (const d of n.declarationList.declarations) {
      if (d.name.getText(sf) === "OPUS_OVERLOAD_NUDGE_THRESHOLD") threshold = Number(d.initializer.getText(sf));
    }
  }
});
if (!sessionClass || !Number.isInteger(threshold)) throw new Error("session.ts: no Session class / threshold");

const FIELDS = {
  opusOverloadStreak: "0",
  opusOverloadNudgeFired: "false",
  opusOverloadCountedThisTurn: "false",
  longContextCreditsNudgeFired: "false",
  authFailedNudgeFired: "false",
  tokenExpiringNudgeFired: "false",
  activeProfileExpiresAt: "null",
};
for (const m of sessionClass.members) {
  const name = m.name?.getText(sf);
  if (ts.isPropertyDeclaration(m) && name in FIELDS && m.initializer?.getText(sf) !== FIELDS[name]) {
    throw new Error(`session.ts: ${name} starts as ${m.initializer?.getText(sf)}`);
  }
}

// Where a statement sits: its method, then each enclosing loop / try part /
// if branch (with its condition) from the outside in; a nested function
// marks a callback.
function placeOf(node) {
  const path = [];
  let method = null;
  for (let n = node; n; n = n.parent) {
    const p = n.parent;
    if (!p) break;
    if (ts.isIfStatement(p) && n !== p.expression) {
      path.unshift(`${n === p.thenStatement ? "if" : "else"} (${norm(p.expression.getText(sf))})`);
    } else if (ts.isForOfStatement(p) && n === p.statement) {
      path.unshift(`for ${norm(p.initializer.getText(sf))} of ${norm(p.expression.getText(sf))}`);
    } else if (ts.isTryStatement(p)) {
      path.unshift(n === p.tryBlock ? "try" : n === p.catchClause ? "catch" : "finally");
    } else if (ts.isArrowFunction(p) || ts.isFunctionExpression(p)) {
      path.unshift("callback");
    }
    if ((ts.isMethodDeclaration(p) || ts.isConstructorDeclaration(p)) && p.parent === sessionClass) {
      method = p.name ? p.name.getText(sf) : "constructor";
      break;
    }
  }
  return { method, path };
}

const NOTES = /^(noteOverloadObservation|noteLongContextCreditsObservation|noteAuthFailedObservation|noteTokenExpiringAtStartup)$/;
const sites = [];
const visit = (n) => {
  let hit = false;
  if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && NOTES.test(n.expression.name.text)) {
    hit = true;
  }
  const writes = (t) =>
    ts.isPropertyAccessExpression(t) && t.expression.kind === ts.SyntaxKind.ThisKeyword && t.name.text in FIELDS;
  if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      n.operatorToken.kind <= ts.SyntaxKind.LastAssignment && writes(n.left)) {
    hit = true;
  }
  if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) && writes(n.operand)) hit = true;
  if (hit) {
    let stmt = n;
    while (stmt.parent && !ts.isExpressionStatement(stmt)) stmt = stmt.parent;
    sites.push({ pos: stmt.getStart(sf), text: norm(stmt.getText(sf)), ...placeOf(stmt) });
  }
  ts.forEachChild(n, visit);
};
ts.forEachChild(sessionClass, visit);

const LOOP = "for const message of this.query as AsyncIterable<SDKMessage>";
const RESULT = 'if ((message as { type?: string }).type === "result")';
const SUCCESS = 'if ((message as { subtype?: string }).subtype === "success")';
const INIT = [
  'if (event.type === "sdk")',
  'if (sdkMsg?.type === "system")',
  'if (sdkMsg.subtype === "init" && !this.isReplayingTranscript)',
];
const CATCH = ["catch", "if (!this.abortController.signal.aborted)"];
// Every call of a note method and every write to a nudge field, in source
// order. The ones in `consume` / `broadcast` are what `live`, `replay` and
// `thrown` below run; the rest are the note methods' own writes and the
// account profile read (G02a / S30).
const EXPECTED = [
  { method: "start", path: [], text: "this.activeProfileExpiresAt = activeProfile?.expiresAt ?? null;" },
  { method: "noteOverloadObservation", path: [], text: "this.opusOverloadCountedThisTurn = true;" },
  { method: "noteOverloadObservation", path: [], text: "this.opusOverloadStreak += 1;" },
  { method: "noteOverloadObservation", path: [], text: "this.opusOverloadNudgeFired = true;" },
  { method: "noteLongContextCreditsObservation", path: [], text: "this.longContextCreditsNudgeFired = true;" },
  { method: "noteAuthFailedObservation", path: [], text: "this.authFailedNudgeFired = true;" },
  { method: "noteTokenExpiringAtStartup", path: [], text: "this.tokenExpiringNudgeFired = true;" },
  { method: "broadcast", path: INIT, text: "this.noteTokenExpiringAtStartup();" },
  { method: "consume", path: ["try", LOOP], text: "this.noteOverloadObservation(isOverloadSignal(message));" },
  {
    method: "consume",
    path: ["try", LOOP],
    text: "this.noteLongContextCreditsObservation(isBillingErrorSignal(message));",
  },
  {
    method: "consume",
    path: ["try", LOOP],
    text: "this.noteAuthFailedObservation(isAuthFailedSignal(message), isOAuthRevokedSignal(message));",
  },
  { method: "consume", path: ["try", LOOP, RESULT, SUCCESS], text: "this.opusOverloadStreak = 0;" },
  { method: "consume", path: ["try", LOOP, RESULT], text: "this.opusOverloadCountedThisTurn = false;" },
  { method: "consume", path: CATCH, text: "this.noteOverloadObservation(isOverloadErrorText(message));" },
  {
    method: "consume",
    path: CATCH,
    text: "this.noteAuthFailedObservation(isAuthFailedErrorText(message), isOAuthRevokedText(message));",
  },
];
sites.sort((a, b) => a.pos - b.pos);
const got = JSON.stringify(sites.map(({ method, path, text }) => ({ method, path, text })), null, 1);
if (got !== JSON.stringify(EXPECTED, null, 1)) {
  throw new Error(`session.ts: the nudge call sites moved:\n${got}`);
}
// The order around them: the notes run after the message's `sdk` broadcast,
// and the token note inside `broadcast()` after the event is buffered and
// before it reaches subscribers.
const at = (needle, from = 0) => {
  const i = SOURCE.indexOf(needle, from);
  if (i < 0) throw new Error(`session.ts: no ${needle}`);
  return i;
};
const loopStart = at("for await (const message of this.query as AsyncIterable<SDKMessage>)");
const ordered = (...xs) => xs.every((x, i) => i === 0 || xs[i - 1] < x);
const pos = (text) => sites.find((s) => s.text === text).pos;
const bcast = at("private broadcast(event: ServerEvent): void {");
if (
  !ordered(
    loopStart,
    at('this.broadcast({ type: "sdk", message });', loopStart),
    pos("this.noteOverloadObservation(isOverloadSignal(message));"),
    at(`${RESULT} {`, loopStart),
  ) ||
  !ordered(
    at("} catch (err) {", loopStart),
    at("const message = err instanceof Error ? err.message : String(err);", loopStart),
    // CC 2.1.311 (R03) flags the thrown-iterator error with `sessionEnded`.
    at('this.broadcast({ type: "error", message, sessionEnded: true });', loopStart),
    pos("this.noteOverloadObservation(isOverloadErrorText(message));"),
  ) ||
  !ordered(bcast, at("this.buffer.push(event);", bcast), pos("this.noteTokenExpiringAtStartup();"), at("for (const sub of this.subscribers)", bcast))
) {
  throw new Error("session.ts: the nudges moved relative to the broadcasts");
}

// ------------------------------- predicates -------------------------------

const O529 =
  'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_011"}';
const A401 =
  'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}';
const REVOKED = "Failed to authenticate: OAuth token revoked";

const TEXTS = [
  "",
  "Overloaded",
  "overloaded",
  "OVERLOADED",
  "overload",
  "over loaded",
  "0verloaded",
  "Repeated 529 Overloaded errors",
  O529,
  "API Error: 529",
  "api error 529",
  "API ERROR: 529",
  "529",
  "status 529",
  "Status: 529",
  "529 STATUS",
  "HTTP 529",
  "error 529",
  "request 529e1b2c-api error",
  "uuid 9f3a529c",
  "52 9 status",
  "5 2 9 api error",
  "status\n529",
  "API\nError 529",
  "apierror 529",
  "API Error: 500 Internal server error",
  "API Error: 429 rate_limit_error",
  "\uFF15\uFF12\uFF19 status",
  "AP\u0130 ERROR: 529",
  "x".repeat(5000) + "overloaded",
  A401,
  "Failed to authenticate",
  "failed to authenticate.",
  "FAILED TO AUTHENTICATE",
  "Failed  to authenticate",
  "failed to authenticat",
  "Fa\u0130led to authenticate",
  "API Error: 401 authentication_error",
  "401 Unauthorized",
  "authentication failed",
  "401 authentication",
  "authenticat 401",
  "403 authentication",
  "API Error: 403 Forbidden: authentication required",
  'API Error: 403 {"error":{"type":"permission_error"}}',
  "port 4013 authenticated",
  "1403 AUTHENTICATED",
  "402 authentication",
  "authent\u0130cation 401",
  REVOKED,
  "OAuth token revoked",
  "oauth token revoked",
  "OAUTH TOKEN REVOKED",
  "OAUTH TO\u212AEN REVOKED",
  "OAuth  token revoked",
  "OAuth token has been revoked",
  "oauth_token_revoked",
  "oauth token revoked\u0130",
  "\u03A3 overloaded \u03A3",
  "\u{1F600} 529 status \u{1F600}",
  "Claude Code process exited with code 1. stderr: " + O529,
  "Claude Code returned an error result: " + A401,
  "Claude Code returned an error result: " + REVOKED + " 529 status",
];

const MODELS = [
  undefined,
  null,
  "",
  "opus",
  "Opus",
  "OPUS",
  "claude-opus-4-1",
  "claude-opus-4-1[1m]",
  "claude-3-opus-20240229",
  "us.anthropic.claude-opus-4-20250514-v1:0",
  "opusplan",
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
  "sonnet",
  "default",
  "opu",
  "o pus",
  "op\u0130us",
  "\u24C4PUS",
];

const textBlock = (text) => ({ type: "text", text });
const asst = (content, extra = {}) => ({
  type: "assistant",
  message: { role: "assistant", content },
  parent_tool_use_id: null,
  ...extra,
});
const result = (subtype, extra = {}) => ({
  type: "result",
  subtype,
  is_error: subtype !== "success",
  num_turns: 1,
  ...extra,
});

const MESSAGES = [
  null,
  0,
  "",
  "assistant",
  5,
  true,
  [],
  {},
  { type: "assistant" },
  { type: "assistant", message: null },
  { type: "assistant", message: O529 },
  { type: "assistant", message: [textBlock(O529)] },
  { type: "assistant", message: { content: O529 } },
  { type: "assistant", message: { message: { content: O529 } } },
  { type: "assistant", content: O529 },
  asst([textBlock(O529)]),
  asst([textBlock("API Error: "), textBlock("529 status")]),
  asst([null, 3, "Overloaded", { type: "text" }, { type: "text", text: 7 }, { type: "Text", text: "Overloaded" }]),
  asst([{ type: "thinking", thinking: "Overloaded" }, textBlock("fine")]),
  asst([{ type: "thinking", thinking: "x" }, textBlock("Overloaded")]),
  asst({ type: "text", text: "Overloaded" }),
  asst(42),
  asst("all good"),
  asst([textBlock(O529)], { parent_tool_use_id: "toolu_sub" }),
  { type: "Assistant", message: { content: O529 } },
  { type: "user", message: { role: "user", content: O529 } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t", content: O529 }] } },
  { type: "system", subtype: "api_retry", error_status: 529, error: "overloaded" },
  { type: "system", subtype: "init", model: "claude-opus-4-1" },
  result("error_during_execution", { errors: ["Overloaded"] }),
  result("error_during_execution", { errors: [O529] }),
  result("error_during_execution", { errors: ["fine", "API Error: 529 status"] }),
  result("error_during_execution", { errors: [] }),
  result("error_during_execution", { errors: "Overloaded" }),
  result("error_during_execution", { errors: [529, null, { message: "Overloaded" }, ["Overloaded"]] }),
  result("error_during_execution", { errors: { 0: "Overloaded", length: 1 } }),
  result("error_during_execution"),
  result("error_during_execution", { errors: [A401], error: "authentication_failed" }),
  result("success", { api_error_status: 529, result: "Overloaded" }),
  result("success", { errors: ["Overloaded"] }),
  result("error_max_turns", { errors: ["Overloaded"] }),
  result("Error_During_Execution", { errors: ["Overloaded"] }),
  { type: "result", errors: ["Overloaded"] },
  { type: "result", subtype: "error_during_execution", message: { content: O529 } },
  asst([], { error: "billing_error" }),
  asst([textBlock("API Error: 400 credit balance is too low")], { error: "billing_error" }),
  asst([], { error: "Billing_Error" }),
  asst([], { error: "billing_error " }),
  asst([], { error: ["billing_error"] }),
  asst([], { error: { type: "billing_error" } }),
  asst([textBlock("billing_error")]),
  asst([], { error: "rate_limit" }),
  { type: "assistant", error: "billing_error" },
  { type: "result", subtype: "error_during_execution", error: "billing_error" },
  { type: "user", error: "billing_error" },
  asst([], { error: "authentication_failed" }),
  asst([], { error: "cloud_credential_error" }),
  asst([], { error: "oauth_org_not_allowed" }),
  asst([textBlock("Your organization does not have access")], { error: "oauth_org_not_allowed" }),
  asst([], { error: "AUTHENTICATION_FAILED" }),
  asst([], { error: true }),
  asst([textBlock(A401)]),
  asst([textBlock(A401)], { error: "authentication_failed" }),
  asst(A401),
  asst([textBlock("Failed to "), textBlock("authenticate")]),
  asst([textBlock("OAuth token revoked")]),
  asst([textBlock(REVOKED)]),
  asst([textBlock(REVOKED)], { error: "authentication_failed" }),
  asst([textBlock("OAuth token"), textBlock(" revoked")], { error: "authentication_failed" }),
  asst([textBlock("API Error: 403 authentication required by the gateway")], { error: "cloud_credential_error" }),
  { type: "assistant", error: "authentication_failed" },
  { type: "assistant", error: "authentication_failed", message: "OAuth token revoked" },
  { type: "user", message: { content: REVOKED } },
  { type: "result", subtype: "error_during_execution", error: "authentication_failed", errors: [REVOKED] },
  asst([textBlock(O529 + " " + A401 + " " + REVOKED)], { error: "billing_error" }),
];

const T = 1_761_500_000_000;
const W = TOKEN_EXPIRY_WARNING_WINDOW_MS;
const EXPIRY = [
  [undefined, T],
  [null, T],
  [T + 1, T],
  [T + 0.5, T],
  [T, T],
  [T - 1, T],
  [T - W, T],
  [T + 2 * 60 * 60 * 1000, T],
  [T + W - 1, T],
  [T + W - 0.5, T],
  [T + W, T],
  [T + W + 0.5, T],
  [T + W + 1, T],
  [T + 5 * 24 * 60 * 60 * 1000, T],
  [0, 0],
  [1, 0],
  [W, 0],
  [W + 1, 0],
  [5e-324, 0],
  [0, 5e-324],
  [-0, -1],
  [0, -0],
  [-0, 0],
  [-1, -W - 1],
  [-1, -W - 2],
  [1e16 + W, 1e16],
  [1e16 + W + 2, 1e16],
  [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER - W],
  [Number.MAX_VALUE, Number.MAX_VALUE],
  [Number.MAX_VALUE, -Number.MAX_VALUE],
  [-Number.MAX_VALUE, Number.MAX_VALUE],
  [NaN, T],
  [Infinity, T],
  [-Infinity, T],
  [T + 1, NaN],
  [T + 1, Infinity],
  [T + 1, -Infinity],
  [Infinity, Infinity],
  [String(T + 1), T],
  ["", T],
  [true, T],
  [false, T],
  [{}, T],
  [[T + 1], T],
  [{ expiresAt: T + 1 }, T],
];
const enc = (x) => {
  if (x === undefined) return { $undefined: true };
  if (typeof x === "number" && (!Number.isFinite(x) || Object.is(x, -0))) {
    return { $num: Object.is(x, -0) ? "-0" : String(x) };
  }
  return x;
};

// --------------------------------- sessions ---------------------------------

const INIT_MSG = { type: "system", subtype: "init", model: "claude-opus-4-1", session_id: "s" };
const over = asst([textBlock(O529)]);
const overResult = result("error_during_execution", { errors: [O529] });
const ok = result("success", { result: "done" });
const billing = asst([textBlock("API Error: 400 credit balance is too low")], { error: "billing_error" });
const authed = asst([textBlock(A401)], { error: "authentication_failed" });
const revoked = asst([textBlock(REVOKED)], { error: "authentication_failed" });
const live = (m, clock) => (clock === undefined ? { live: m } : { live: m, clock });
const thrown = (message) => ({ thrown: message });
const OPUS = "claude-opus-4-1";
const SONNET = "claude-sonnet-4-5";

const SESSIONS = [
  {
    name: "two overloaded turns in a row on Opus",
    model: OPUS,
    steps: [live(over), live(overResult), live(over), live(overResult), live(ok)],
  },
  {
    name: "a turn's assistant 529 and its error result count once",
    model: OPUS,
    steps: [live(over), live(over), live(overResult), live(overResult), live(overResult)],
  },
  {
    name: "the result alone counts for its turn",
    model: OPUS,
    steps: [live(overResult), live(overResult)],
  },
  {
    name: "a success clears the streak",
    model: OPUS,
    steps: [live(over), live(overResult), live(ok), live(over), live(overResult), live(over), live(overResult)],
  },
  {
    name: "any other result ends the turn but keeps the streak",
    model: OPUS,
    steps: [
      live(over),
      live(result("error_max_turns", { errors: ["Overloaded"] })),
      live(result("error_during_execution", { errors: ["boom"] })),
      live({ type: "result" }),
      live(over),
    ],
  },
  {
    name: "a fallback-rescued success is no signal",
    model: OPUS,
    steps: [live(result("success", { api_error_status: 529 })), live(result("success", { api_error_status: 529 })), live(over)],
  },
  {
    name: "fires once, the streak keeps counting",
    model: OPUS,
    steps: [live(over), live(overResult), live(over), live(overResult), live(over), live(overResult), live(over), live(ok), live(over), live(overResult), live(over), live(overResult)],
  },
  {
    name: "not on Sonnet; Opus picks the streak up",
    model: SONNET,
    steps: [
      live(over),
      live(overResult),
      live(over),
      live(overResult),
      live(over),
      live(overResult),
      { model: OPUS },
      live(over),
      live(overResult),
      { model: SONNET },
      live(over),
    ],
  },
  {
    name: "a model switch mid-turn",
    model: SONNET,
    steps: [live(over), live(overResult), live(over), { model: "Claude-OPUS-4" }, live(overResult), live(over)],
  },
  { name: "no model", steps: [live(over), live(overResult), live(over), live(overResult), live(billing), live(authed)] },
  { name: "an empty model", model: "", enable1mContext: true, steps: [live(over), live(overResult), live(over), live(billing), live(authed)] },
  {
    name: "user, system and subagent messages",
    model: OPUS,
    steps: [
      live({ type: "user", message: { role: "user", content: O529 } }),
      live({ type: "system", subtype: "api_retry", error_status: 529, error: "overloaded" }),
      live(ok),
      live(asst([textBlock(O529)], { parent_tool_use_id: "toolu_1" })),
      live(overResult),
      live(asst([textBlock(O529)], { parent_tool_use_id: "toolu_1" })),
    ],
  },
  {
    name: "a thrown 529 after an overloaded turn",
    model: OPUS,
    steps: [live(over), live(overResult), thrown("Claude Code process exited with code 1. stderr: " + O529)],
  },
  {
    name: "a thrown 529 in the overloaded turn counts once",
    model: OPUS,
    steps: [live(overResult), live(over), thrown("Claude Code returned an error result: " + O529), thrown("Overloaded")],
  },
  {
    name: "thrown errors without a turn between",
    model: OPUS,
    steps: [thrown("API Error: 529 status"), thrown("API Error: 529 status"), thrown("Claude Code process exited with code 1")],
  },
  {
    name: "a thrown non-overload",
    model: OPUS,
    steps: [live(over), live(overResult), thrown("Claude Code process exited with code 1"), thrown("")],
  },
  {
    name: "billing on a 1M-context session",
    model: OPUS,
    enable1mContext: true,
    steps: [live(billing), live(result("error_during_execution", { errors: ["credit balance is too low"] })), live(billing)],
  },
  { name: "billing without 1M context", model: OPUS, enable1mContext: false, steps: [live(billing), live(billing)] },
  { name: "billing, 1M context unset", model: OPUS, steps: [live(billing)] },
  {
    name: "billing only as the structured tag",
    model: SONNET,
    enable1mContext: true,
    steps: [
      live(asst([textBlock("billing_error")])),
      live({ type: "result", subtype: "error_during_execution", error: "billing_error" }),
      live(asst([], { error: "Billing_Error" })),
      live(asst([], { error: "billing_error" })),
    ],
  },
  {
    name: "a thrown billing error",
    model: OPUS,
    enable1mContext: true,
    steps: [thrown("Claude Code returned an error result: billing_error credit balance is too low")],
  },
  { name: "auth: the structured tag", model: OPUS, steps: [live(authed), live(authed), live(revoked)] },
  { name: "auth: a gateway credential", model: SONNET, steps: [live(asst([], { error: "cloud_credential_error" }))] },
  { name: "auth: the text", steps: [live(asst([textBlock(A401)])), live(ok)] },
  { name: "auth: a revoked login", model: OPUS, steps: [live(revoked), live(authed)] },
  { name: "auth: revoked text alone is no failure", model: OPUS, steps: [live(asst([textBlock("OAuth token revoked")])), live(asst([textBlock("401 Unauthorized")]))] },
  {
    name: "auth: org not allowed",
    model: OPUS,
    steps: [live(asst([textBlock("Your organization does not have access")], { error: "oauth_org_not_allowed" }))],
  },
  { name: "auth: a thrown 401", model: OPUS, steps: [thrown("Claude Code returned an error result: " + A401), thrown(A401)] },
  { name: "auth: a thrown revoked login", steps: [thrown("Claude Code returned an error result: " + REVOKED)] },
  { name: "auth: a thrown 403", model: SONNET, steps: [thrown("API Error: 403 authentication required")] },
  {
    name: "one message trips all three",
    model: OPUS,
    enable1mContext: true,
    steps: [live(overResult), live(asst([textBlock(O529 + " " + REVOKED)], { error: "billing_error" }))],
  },
  {
    name: "a thrown message trips both",
    model: OPUS,
    steps: [live(overResult), thrown("Claude Code returned an error result: " + O529 + " " + REVOKED)],
  },
  { name: "token: inside the window", model: OPUS, expiresAt: T + 2 * 60 * 60 * 1000, steps: [live(INIT_MSG, T), live(INIT_MSG, T)] },
  {
    name: "token: a replayed init doesn't check",
    expiresAt: T + 1000,
    steps: [{ replay: INIT_MSG, clock: T }, live(over, T), live(INIT_MSG, T), { replay: INIT_MSG, clock: T }, live(INIT_MSG, T)],
  },
  { name: "token: no profile", steps: [live(INIT_MSG, T), live(INIT_MSG, T)] },
  { name: "token: the first check uses it up", expiresAt: T + 1000, steps: [live(INIT_MSG, T - W), live(INIT_MSG, T)] },
  { name: "token: expired", expiresAt: T - 1, steps: [live(INIT_MSG, T)] },
  { name: "token: expiring now", expiresAt: T, steps: [live(INIT_MSG, T)] },
  { name: "token: exactly the window", expiresAt: T + W, steps: [live(INIT_MSG, T)] },
  { name: "token: past the window", expiresAt: T + W + 1, steps: [live(INIT_MSG, T)] },
  { name: "token: a fractional expiry", expiresAt: T + 0.5, steps: [live(INIT_MSG, T)] },
  { name: "token: a huge expiry", expiresAt: 1e21, steps: [live(INIT_MSG, 1e21 - 1e6)] },
  { name: "token: a NaN expiry", expiresAt: NaN, steps: [live(INIT_MSG, T)] },
  { name: "token: an infinite expiry", expiresAt: Infinity, steps: [live(INIT_MSG, T)] },
  { name: "token: a string expiry", expiresAt: String(T + 1000), steps: [live(INIT_MSG, T)] },
  {
    name: "token: other system messages",
    expiresAt: T + 1000,
    steps: [
      live({ type: "system", subtype: "status", status: "compacting" }, T),
      live({ type: "system", subtype: "Init" }, T),
      live({ type: "assistant", subtype: "init", message: { content: "hi" } }, T),
      live({ ...INIT_MSG, type: "System" }, T),
      live(INIT_MSG, T),
    ],
  },
  {
    name: "token: an init that is also a nudge turn",
    model: OPUS,
    enable1mContext: true,
    expiresAt: T + 1,
    steps: [live(overResult, T), live({ ...INIT_MSG, type: "system" }, T), live(over, T), live(overResult, T), live(billing, T)],
  },
];

const STATE_FIELDS = Object.keys(FIELDS).filter((k) => k !== "activeProfileExpiresAt");
let CLOCK = T;
Date.now = () => CLOCK;

function runSession(c) {
  const host = Object.create(Session.prototype);
  // The class fields the note methods use, at their initial values.
  Object.assign(host, {
    id: "golden",
    model: c.model,
    enable1mContext: c.enable1mContext,
    isReplayingTranscript: false,
    opusOverloadStreak: 0,
    opusOverloadNudgeFired: false,
    opusOverloadCountedThisTurn: false,
    longContextCreditsNudgeFired: false,
    authFailedNudgeFired: false,
    tokenExpiringNudgeFired: false,
    activeProfileExpiresAt: c.expiresAt ?? null,
  });
  let events = [];
  host.broadcast = (ev) => events.push(JSON.stringify(ev));
  // `broadcast({ type: "sdk", message })`, as far as the nudges go.
  const sdkBroadcast = (message) => {
    const sdkMsg = message;
    if (sdkMsg?.type === "system") {
      if (sdkMsg.subtype === "init" && !host.isReplayingTranscript) host.noteTokenExpiringAtStartup();
    }
  };
  const steps = [];
  for (const step of c.steps) {
    CLOCK = step.clock ?? T;
    if ("live" in step) {
      // `consume()`'s loop body, as far as the nudges go.
      const message = step.live;
      sdkBroadcast(message);
      host.noteOverloadObservation(isOverloadSignal(message));
      host.noteLongContextCreditsObservation(isBillingErrorSignal(message));
      host.noteAuthFailedObservation(isAuthFailedSignal(message), isOAuthRevokedSignal(message));
      if (message.type === "result") {
        if (message.subtype === "success") host.opusOverloadStreak = 0;
        host.opusOverloadCountedThisTurn = false;
      }
    } else if ("replay" in step) {
      host.isReplayingTranscript = true;
      sdkBroadcast(step.replay);
      host.isReplayingTranscript = false;
    } else if ("thrown" in step) {
      // `consume()`'s catch.
      const err = new Error(step.thrown);
      const message = err instanceof Error ? err.message : String(err);
      host.noteOverloadObservation(isOverloadErrorText(message));
      host.noteAuthFailedObservation(isAuthFailedErrorText(message), isOAuthRevokedText(message));
    } else {
      host.model = step.model;
    }
    const state = Object.fromEntries(STATE_FIELDS.map((k) => [k, host[k]]));
    steps.push({ ...step, events, state });
    events = [];
  }
  return {
    name: c.name,
    ...(c.model === undefined ? {} : { model: c.model }),
    ...(c.enable1mContext === undefined ? {} : { enable1mContext: c.enable1mContext }),
    expiresAt: enc(c.expiresAt ?? null),
    steps,
  };
}

const fixture = {
  constants: { OPUS_OVERLOAD_NUDGE_THRESHOLD: threshold, TOKEN_EXPIRY_WARNING_WINDOW_MS },
  texts: TEXTS.map((text) => ({
    text,
    overload: isOverloadErrorText(text),
    authFailed: isAuthFailedErrorText(text),
    oauthRevoked: isOAuthRevokedText(text),
  })),
  models: MODELS.map((model) => ({ ...(model === undefined ? {} : { model }), opus: isOpusModelId(model) })),
  messages: MESSAGES.map((message) => ({
    message,
    overload: isOverloadSignal(message),
    billingError: isBillingErrorSignal(message),
    authFailed: isAuthFailedSignal(message),
    oauthRevoked: isOAuthRevokedSignal(message),
  })),
  expiry: EXPIRY.map(([expiresAt, now]) => ({
    expiresAt: enc(expiresAt),
    now: enc(now),
    warn: shouldWarnTokenExpiring(expiresAt, now),
  })),
  sessions: SESSIONS.map(runSession),
};
if (isOverloadSignal(undefined) || isBillingErrorSignal(undefined) || isAuthFailedSignal(undefined) || isOAuthRevokedSignal(undefined)) {
  throw new Error("a signal on undefined");
}
// A file, not stdout: `process.exit` would cut a piped stdout short.
writeFileSync(join(ROOT_DIR, "out.json"), JSON.stringify(fixture));
process.exit(0);
