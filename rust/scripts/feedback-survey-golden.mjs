#!/usr/bin/env node
// Golden fixture for the feedback nudge (S26), recorded from the TS sources:
//
//   node rust/scripts/feedback-survey-golden.mjs   (node@22: session.ts needs
//                                                   better-sqlite3, which bun
//                                                   can't load; builds
//                                                   claudius-fake-claude)
//
// Re-runs itself under `--experimental-transform-types` with HOME and
// CLAUDE_CONFIG_DIR in a temp root and a resolve hook for the `@/` and
// extensionless imports, twice (two temp roots); both recordings must agree
// byte for byte. Records:
//
// - `constants`: DEFAULT_FEEDBACK_SURVEY_RATE and SURVEY_MIN_INTERVAL_MS
//   (lib/server/feedback-survey.ts).
// - `rates`: `coerceSurveyRate(raw)` over JSON values (`missing` stands for
//   `undefined`).
// - `decisions`: `shouldOfferSurvey(opts)` with `Math.random` pinned to
//   `mathRandom`. Each records `offer` and `draws` (the Math.random calls).
// - `offers`: the real `Session.prototype.maybeOfferFeedbackSurvey` on bare
//   sessions (`id`, `cwd`, `sawUserInput` and a recording `broadcast`), one
//   scenario at a time, with the module's throttle reset before each.
//   Every step first writes the user settings.json under the temp HOME
//   (`settings`: absent, `text`, `bytes` or a directory) and, when `before`
//   is set, calls `noteSurveyShown(before)`. Then it pins `Date.now` to
//   `now` and `Math.random` to `mathRandom`, and awaits the call on the
//   result `message`. It records the `events` broadcast (`JSON.stringify`
//   text), `draws`, `nowCalls` (the Date.now calls: none when an input
//   gate stops it first) and `lastShownAt` afterwards. A `concurrent` step runs
//   two sessions' calls at once, so both pass the first throttle check
//   before either settings read lands, and records how many broadcast
//   (`offered`) and drew.
// - `submits`: the real `Session.prototype.submitFeedback` on a bare
//   session. Its `query` is a real SDK `query()` against the fake CLI with
//   the case's `script` (`query: "live"`), none (`"none"`), or one aborted
//   as `Session.end()` aborts it (`"ended"`). Each call records `forwarded`
//   and the `submit_feedback` control requests the SDK wrote (`wire`: the
//   raw stdin lines with the request id written `$ID`).
//
// Written to rust/crates/claudius-core/tests/fixtures/feedback_survey_golden.json
// and replayed by crates/claudius-core/tests/feedback_survey_golden.rs.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "crates/claudius-core/tests/fixtures/feedback_survey_golden.json");

// ------------------------------- recording -------------------------------

if (!process.env.FEEDBACK_SURVEY_GOLDEN_CHILD) {
  execFileSync("cargo", ["build", "-q", "-p", "claudius-agent", "--bin", "claudius-fake-claude"], {
    cwd: rustDir,
    stdio: "inherit",
    env: { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` },
  });
  const fake = join(rustDir, "target/debug/claudius-fake-claude");
  const runs = [0, 1].map(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "feedback-survey-golden-")));
    try {
      const home = join(root, "home");
      mkdirSync(home);
      mkdirSync(join(root, "project"));
      const r = spawnSync(
        process.execPath,
        ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url)],
        {
          cwd: home,
          encoding: "utf8",
          maxBuffer: 1 << 26,
          env: {
            PATH: process.env.PATH,
            HOME: home,
            CLAUDE_CONFIG_DIR: join(root, "config"),
            FEEDBACK_SURVEY_GOLDEN_CHILD: root,
            FEEDBACK_SURVEY_GOLDEN_FAKE: fake,
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
  const steps = fixture.offers.reduce((n, s) => n + s.steps.length, 0);
  const calls = fixture.submits.reduce((n, c) => n + c.calls.length, 0);
  console.log(
    `wrote ${out.slice(repo.length + 1)}: ${fixture.rates.length} rates, ${fixture.decisions.length} decisions, ` +
      `${fixture.offers.length} offer scenarios (${steps} steps), ${fixture.submits.length} submit cases (${calls} calls), ` +
      `SDK ${fixture.sdkVersion} (stable)`,
  );
  process.exit(0);
}

// --------------------------------- child ---------------------------------

const ROOT_DIR = process.env.FEEDBACK_SURVEY_GOLDEN_CHILD;
const FAKE = process.env.FEEDBACK_SURVEY_GOLDEN_FAKE;
const HOME = join(ROOT_DIR, "home");
const CWD = join(ROOT_DIR, "project");

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

const SDK = "@anthropic-ai/claude-agent-sdk";
const { Session } = await import(join(repo, "lib/server/session.ts"));
const survey = await import(join(repo, "lib/server/feedback-survey.ts"));
const { query } = await import(SDK);
const sdkVersion = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.resolve(SDK))), "package.json"), "utf8"),
).version;

const J = (v) => JSON.stringify(v);

/** Run `fn` with `Math.random` pinned to `value`, counting the draws. */
async function withRandom(value, fn) {
  const real = Math.random;
  let draws = 0;
  Math.random = () => {
    draws++;
    return value;
  };
  try {
    const result = await fn();
    return { result, draws };
  } finally {
    Math.random = real;
  }
}

// ------------------------------- constants -------------------------------

const constants = {
  defaultRate: survey.DEFAULT_FEEDBACK_SURVEY_RATE,
  minIntervalMs: survey.SURVEY_MIN_INTERVAL_MS,
};

// --------------------------------- rates ---------------------------------

const RAWS = [
  undefined, null, true, false, 0, 1, 0.05, 0.5, 0.25, 1.5, 2, 100, -0.1, -5, -1e300, 1e300,
  1e-300, 5e-324, 1.7976931348623157e308, -1.7976931348623157e308, 0.9999999999999999, 1.0000000000000002,
  0.049999999999999996, 9007199254740993, "", "0.5", "1", "abc", [], [0.5], {}, { feedbackSurveyRate: 1 },
];
const rates = RAWS.map((raw) => ({ raw: raw ?? null, missing: raw === undefined, rate: survey.coerceSurveyRate(raw) }));

// ------------------------------- decisions -------------------------------

const T0 = 1_800_000_000_000;
const H6 = survey.SURVEY_MIN_INTERVAL_MS;
const TIMES = [
  [T0, 0],
  [T0, T0 - H6],
  [T0, T0 - H6 + 1],
  [T0 - 1, T0],
  [H6 - 1, 0],
  [1000, 0],
];
const DRATES = [0, -0.5, 1e-9, 0.05, 1, 1.5];
const MINS = [undefined, 0, 1000];
const ROLLS = [
  { mathRandom: 0.03 },
  { mathRandom: 0.6 },
  { random: 0, mathRandom: 0.99 },
  { random: 0.05, mathRandom: 0 },
  { random: -1, mathRandom: 0.99 },
];

const decisions = [];
async function decide(opts, mathRandom) {
  const { result, draws } = await withRandom(mathRandom, () => survey.shouldOfferSurvey(opts));
  decisions.push({ opts, mathRandom, offer: result, draws });
}
for (const rate of DRATES) {
  for (const [now, lastShownAt] of TIMES) {
    for (const minIntervalMs of MINS) {
      for (const roll of ROLLS) {
        const opts = { rate, isError: false, sawUserInput: true, now, lastShownAt };
        if (minIntervalMs !== undefined) opts.minIntervalMs = minIntervalMs;
        if (roll.random !== undefined) opts.random = roll.random;
        await decide(opts, roll.mathRandom);
      }
    }
  }
}
// The input gates, whatever the rest says.
for (const [isError, sawUserInput] of [
  [true, true],
  [false, false],
  [true, false],
]) {
  for (const rate of [0.5, 1]) {
    for (const random of [undefined, 0]) {
      const opts = { rate, isError, sawUserInput, now: T0, lastShownAt: 0 };
      if (random !== undefined) opts.random = random;
      await decide(opts, 0);
    }
  }
}

// --------------------------------- offers ---------------------------------

const SETTINGS = join(HOME, ".claude", "settings.json");
const RESULT = { type: "result", subtype: "success", is_error: false, result: "ok", session_id: "s" };

function writeSettings(settings) {
  rmSync(SETTINGS, { recursive: true, force: true });
  mkdirSync(dirname(SETTINGS), { recursive: true });
  if (!settings) return;
  if (settings.dir) mkdirSync(SETTINGS);
  else if (settings.bytes) writeFileSync(SETTINGS, Buffer.from(settings.bytes));
  else writeFileSync(SETTINGS, settings.text);
}

function bareSession(id, sawUserInput, events) {
  const host = Object.create(Session.prototype);
  Object.assign(host, {
    id,
    cwd: CWD,
    sawUserInput,
    broadcast: (ev) => events.push(J(ev)),
  });
  return host;
}

async function runStep(step) {
  const s = { id: "sess-a", sawUserInput: true, message: RESULT, now: T0, mathRandom: 0.01, settings: null, ...step };
  writeSettings(s.settings);
  if (s.before !== undefined) survey.noteSurveyShown(s.before);
  const realNow = Date.now;
  let nowCalls = 0;
  Date.now = () => {
    nowCalls++;
    return s.now;
  };
  try {
    if (s.concurrent) {
      const events = [];
      const a = bareSession("sess-a", true, events);
      const b = bareSession("sess-b", true, events);
      const { draws } = await withRandom(s.mathRandom, () =>
        Promise.all([a.maybeOfferFeedbackSurvey(s.message), b.maybeOfferFeedbackSurvey(s.message)]),
      );
      return { ...s, offered: events.length, draws, nowCalls, lastShownAt: survey.getLastSurveyShownAt() };
    }
    const events = [];
    const host = bareSession(s.id, s.sawUserInput, events);
    const { draws } = await withRandom(s.mathRandom, () => host.maybeOfferFeedbackSurvey(s.message));
    return { ...s, events, draws, nowCalls, lastShownAt: survey.getLastSurveyShownAt() };
  } finally {
    Date.now = realNow;
  }
}

const text = (t) => ({ text: t });
const rateText = (n) => text(`{"feedbackSurveyRate": ${n}}`);
const deep = (n) => "[".repeat(n) + "]".repeat(n);
const utf8 = (s) => [...Buffer.from(s, "utf8")];

const SCENARIOS = [
  ["the default rate offers on a low roll", [{}]],
  ["a roll at the rate doesn't", [{ mathRandom: 0.05 }]],
  ["a roll just under the rate does", [{ mathRandom: 0.049999999999999996 }]],
  ["a zero roll", [{ mathRandom: 0 }]],
  ["an error result", [{ message: { ...RESULT, is_error: true } }, { message: { ...RESULT, subtype: "error_during_execution", is_error: true } }]],
  ["an error subtype without is_error still offers", [{ message: { type: "result", subtype: "error_during_execution", is_error: false } }]],
  ["is_error must be true itself", [
    { message: { ...RESULT, is_error: "true" } },
    { before: 0, message: { ...RESULT, is_error: 1 } },
    { before: 0, message: { type: "result" } },
    { before: 0, message: { ...RESULT, is_error: null } },
  ]],
  ["no prompt in this process", [{ sawUserInput: false }, { sawUserInput: false, mathRandom: 0 }]],
  ["the throttle spans sessions", [
    { id: "sess-a" },
    { id: "sess-b", now: T0 + 1000, mathRandom: 0 },
    { id: "sess-a", now: T0 + H6 - 1, mathRandom: 0 },
    { id: "sess-b", now: T0 + H6 },
    { id: "sess-c", now: T0 + H6 + 1 },
  ]],
  ["a failed roll doesn't stamp", [{ mathRandom: 0.9 }, { now: T0 + 1, mathRandom: 0.9 }, { now: T0 + 2 }]],
  ["a clock within 6 h of the epoch", [{ now: 1000 }, { now: H6 - 1 }, { now: H6 }]],
  ["a clock behind the last show", [{ before: T0, now: T0 - 5 }, { now: T0 - H6 }]],
  ["two sessions at once offer once", [{ concurrent: true }]],
  ["two sessions at once, both rolls fail", [{ concurrent: true, mathRandom: 0.9 }]],
  ["two sessions at once, throttled", [{ concurrent: true, before: T0 - 1 }]],
];

// Every settings body at several rolls, each from a reset throttle.
const SETTINGS_BODIES = [
  ["absent", null],
  ["empty object", text("{}")],
  ["rate 1", rateText("1")],
  ["rate 0", rateText("0")],
  ["rate -0", rateText("-0")],
  ["rate 0.6", rateText("0.6")],
  ["rate 0.3", rateText("0.3")],
  ["rate 0.50", rateText("0.50")],
  ["rate 5e-1", rateText("5e-1")],
  ["rate 30E-2", rateText("30E-2")],
  ["rate 1E0", rateText("1E0")],
  ["rate -1", rateText("-1")],
  ["rate 7", rateText("7")],
  ["rate 1e400", rateText("1e400")],
  ["rate -1e400", rateText("-1e400")],
  ["rate 1e-400", rateText("1e-400")],
  ["rate 5e-324", rateText("5e-324")],
  ["rate 0.049999999999999996", rateText("0.049999999999999996")],
  ["rate 100000000000000000000000", rateText("100000000000000000000000")],
  ["rate string", rateText('"1"')],
  ["rate null", rateText("null")],
  ["rate true", rateText("true")],
  ["rate array", rateText("[1]")],
  ["rate object", rateText('{"v": 1}')],
  ["duplicate keys: the last wins", text('{"feedbackSurveyRate": 1, "feedbackSurveyRate": 0}')],
  ["duplicate keys: the last wins, again", text('{"feedbackSurveyRate": 0, "feedbackSurveyRate": 1}')],
  ["__proto__ is an own key", text('{"__proto__": {"feedbackSurveyRate": 1}}')],
  ["the key is case-sensitive", text('{"FeedbackSurveyRate": 1}')],
  ["other keys around it", text('{"model": "opus", "feedbackSurveyRate": 1, "env": {"A": "1"}, "n": [1, 2.5e3]}')],
  ["a 1e400 elsewhere", text('{"feedbackSurveyRate": 1, "other": 1e400}')],
  ["a lone surrogate elsewhere", text('{"feedbackSurveyRate": 1, "s": "\\ud800"}')],
  ["deep nesting elsewhere", text(`{"feedbackSurveyRate": 1, "deep": ${deep(100)}}`)],
  ["nesting past 128 elsewhere", text(`{"feedbackSurveyRate": 1, "deep": ${deep(200)}}`)],
  ["null file", text("null")],
  ["null file, padded", text(" \n null \n")],
  ["array file", text("[1]")],
  ["number file", text("5")],
  ["string file", text('"feedbackSurveyRate"')],
  ["true file", text("true")],
  ["trailing comma", text('{"feedbackSurveyRate": 1,}')],
  ["trailing garbage", text('{"feedbackSurveyRate": 1} x')],
  ["empty file", text("")],
  ["whitespace file", text(" \n\t")],
  ["a byte-order mark", text('\ufeff{"feedbackSurveyRate": 1}')],
  ["leading and trailing whitespace", text('\n\r\t {"feedbackSurveyRate": 1} \n')],
  ["invalid UTF-8 in a string", { bytes: [...utf8('{"x": "'), 0xff, 0xc3, ...utf8('", "feedbackSurveyRate": 1}')] }],
  ["invalid UTF-8 in a key", { bytes: [...utf8('{"'), 0xed, 0xa0, 0x80, ...utf8('": 0, "feedbackSurveyRate": 1}')] }],
  ["invalid UTF-8 in the number", { bytes: [...utf8('{"feedbackSurveyRate": 1'), 0x80, ...utf8("}")] }],
  ["a directory", { dir: true }],
];
const SETTINGS_ROLLS = [0, 0.01, 0.3, 0.7];
SCENARIOS.push([
  "user settings",
  SETTINGS_BODIES.flatMap(([name, settings]) =>
    SETTINGS_ROLLS.map((mathRandom) => ({ name, settings, mathRandom, before: 0 })),
  ),
]);

const offers = [];
for (const [name, steps] of SCENARIOS) {
  survey.resetSurveyThrottle();
  const recorded = [];
  for (const step of steps) recorded.push(await runStep(step));
  offers.push({ name, steps: recorded });
}
writeSettings(null);

// --------------------------------- submits ---------------------------------

let dirs = 0;
/** A real SDK query against the fake CLI, as a bare session's `query`. */
async function openQuery(script) {
  const dir = join(ROOT_DIR, `q${dirs++}`);
  const cwd = join(dir, "proj");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(dir, "home"));
  const log = join(dir, "stdin.log");
  let finish;
  const done = new Promise((r) => (finish = r));
  async function* prompt() {
    await done;
  }
  const ctrl = new AbortController();
  const q = query({
    prompt: prompt(),
    options: {
      cwd,
      pathToClaudeCodeExecutable: FAKE,
      abortController: ctrl,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: join(dir, "home"),
        FAKE_CLAUDE_LOG: log,
        ...(script ? { FAKE_CLAUDE_SCRIPT: JSON.stringify(script) } : {}),
      },
    },
  });
  const drained = (async () => {
    try {
      for await (const m of q) void m;
    } catch {
      // the abort ends the stream with an error
    }
  })();
  await q.initializationResult();
  const close = async () => {
    finish();
    ctrl.abort();
    await drained;
  };
  return { q, log, close };
}

const readLines = (f) => {
  try {
    return readFileSync(f, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
};

/** The `submit_feedback` control requests written since line `from`, ids as `$ID`. */
function wireSince(log, from) {
  return readLines(log)
    .slice(from)
    .filter((l) => {
      const m = JSON.parse(l);
      return m.type === "control_request" && m.request?.subtype === "submit_feedback";
    })
    .map((l) => l.replace(J(JSON.parse(l).request_id), '"$ID"'));
}

// Each call: [description, surface (undefined for the default), attachTranscript (undefined for the default)].
const ODD =
  'line1\nline2\r\n\t"quoted" \\ back \u0000 \u0001 \u001f \u007f \u2028 \u2029 caf\u00e9 \u4e2d \u{1F600} </script> $1 $&';
const SUBMITS = [
  ["defaults", "live", null, [["it broke"]]],
  ["a thumbs up with the transcript", "live", null, [["[+1] great", "claudius", true]]],
  ["another surface", "live", null, [["[-1] slow", "survey", false]]],
  ["an undefined surface is the default", "live", null, [["x", undefined, true]]],
  ["an empty surface is kept", "live", null, [["x", "", false]]],
  ["an empty description", "live", null, [["", "claudius", false]]],
  ["odd characters", "live", null, [[ODD, ODD, true]]],
  ["a long description", "live", null, [["y".repeat(5000)]]],
  ["two in a row", "live", null, [["first"], ["second", "claudius", true]]],
  ["the CLI answers something", "live", { control: { submit_feedback: { ok: true, id: 1.5 } } }, [["x"]]],
  ["the CLI refuses", "live", { control: { submit_feedback: { $error: "feedback disabled" } } }, [["x", "claudius", true]]],
  ["no query", "none", null, [["x"]]],
  ["an ended query", "ended", null, [["x"], ["y", "claudius", true]]],
];

const submits = [];
for (const [name, mode, script, calls] of SUBMITS) {
  const host = Object.create(Session.prototype);
  host.id = `golden-submit-${submits.length}`;
  host.query = null;
  let q = null;
  if (mode !== "none") {
    q = await openQuery(script);
    host.query = q.q;
    if (mode === "ended") await q.close();
  }
  const recorded = [];
  for (const [description, surface, attachTranscript] of calls) {
    const from = q ? readLines(q.log).length : 0;
    const forwarded = await host.submitFeedback(description, surface, attachTranscript);
    recorded.push({
      description,
      surface: surface ?? null,
      attachTranscript: attachTranscript ?? null,
      forwarded,
      wire: q ? wireSince(q.log, from) : [],
    });
  }
  if (q && mode !== "ended") await q.close();
  submits.push({ name, query: mode, script, calls: recorded });
}

// A file, not stdout: `process.exit` would cut a piped stdout short.
writeFileSync(join(ROOT_DIR, "out.json"), J({ sdkVersion, constants, rates, decisions, offers, submits }));
process.exit(0);
