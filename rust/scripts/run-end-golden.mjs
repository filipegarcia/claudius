#!/usr/bin/env node
// Golden fixture for the SDK's single-turn mode: `query({prompt: "<string>"})`.
//
//   node rust/scripts/run-end-golden.mjs     (builds claudius-fake-claude)
//
// A string prompt is written as one user message (with `client_composed`
// under `verbatimPrompts`), and the SDK closes the CLI's stdin when the run
// ends (`endRun` / `armRunEndCeiling` in sdk.mjs): right after a `result`
// when the session state is unknown or `idle` or nothing needs the control
// channel, else on `session_state_changed: idle`, or after
// `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` with no idle.
//
// Each case runs the real SDK against `claudius-fake-claude`, whose script
// interleaves `$mark` steps with delays. `$FAKE_CLAUDE_EVENTS` records the
// marks and the moment stdin closed, so the order of `eof` among the marks
// pins when the SDK ended the run. The delays leave >= 300 ms on each side
// of every expected `eof`. Also recorded: the user line(s) written, and the
// `type/subtype` of every message the SDK yielded.
//
// Those margins are the SDK's, not the fake's: the SDK has to read each
// message within them. When it reads one late (this process busy, the
// machine loaded), it closes stdin after the fake has already exited, and
// that run simply has no `eof`. Reading the events log later can't bring it
// back: the SDK ends the stream only once the CLI has exited, so the log is
// complete by then. Starting all the cases at once made that likely (the
// synchronous spawns and SDK setup kept node from reading the first cases'
// stdout until their delays were over), so the cases run one at a time. A
// run is thrown away when this process's event loop stalled for more than
// STALL_MS while the CLI ran, or when the events log ends mid-line (the
// fake exited while writing `eof`), and a case is kept only once AGREE runs
// in a row give the same record.
//
// `ceilingTable` is the SDK's own env parser (`Ic`, extracted from sdk.mjs
// and evaluated) over a set of raw values: the ceiling in ms it derives.
//
// Written to rust/crates/claudius-agent/tests/fixtures/run_end_golden.json
// and replayed against the Rust `Query::spawn_prompt` by
// crates/claudius-agent/tests/run_end_golden.rs.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const sdkPath = join(repo, "node_modules/@anthropic-ai/claude-agent-sdk");
const sdkFile = join(sdkPath, "sdk.mjs");
const { query, createSdkMcpServer, tool } = await import(pathToFileURL(sdkFile).href);
const { z } = await import(pathToFileURL(join(repo, "node_modules/zod/index.js")).href);
const sdkVersion = JSON.parse(readFileSync(join(sdkPath, "package.json"), "utf8")).version;
const CEILING_ENV = "CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS";
// A third of the smallest margin; see the header.
const STALL_MS = 100;
const AGREE = 3;
const MAX_RUNS = 15;

const RESULT = { type: "result", subtype: "success", is_error: false, result: "ok", num_turns: 1, duration_ms: 1, duration_api_ms: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } };
const state = (s) => ({ type: "system", subtype: "session_state_changed", state: s });
const mark = (m) => ({ $mark: m });
const delay = (ms) => ({ $delay_ms: ms });
const subagentText = { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "sub" }] }, parent_tool_use_id: "toolu_1" };
const streamEvent = { type: "stream_event", event: { type: "message_start" }, parent_tool_use_id: null };

// [name, options spec, steps or {turns}]. Every script ends with `$exit 0`,
// so a case where the SDK never closes stdin still ends (with no `eof`).
// `followUp`: on the first `result`, stream one more prompt with
// `Query.streamInput()`, which starts a new run (the ceiling armed by that
// result is cleared and `resultReceived` reset).
const CASES = [
  ["no_callbacks", {}, [{ $text: "hi" }, RESULT, delay(400), mark("A")]],
  ["callbacks_no_state", { canUseTool: true }, [{ $text: "hi" }, RESULT, delay(400), mark("A")]],
  ["callbacks_running_then_idle", { canUseTool: true }, [state("running"), { $text: "hi" }, RESULT, delay(400), mark("A"), state("idle"), delay(400), mark("B")]],
  ["idle_before_result", { canUseTool: true }, [state("running"), state("idle"), { $text: "hi" }, RESULT, delay(400), mark("A")]],
  ["idle_without_result_waits", { canUseTool: true }, [state("idle"), delay(400), mark("A"), { $text: "x" }, delay(400), mark("B"), RESULT, delay(400), mark("C")]],
  ["no_callbacks_ignores_state", {}, [state("running"), { $text: "hi" }, RESULT, delay(400), mark("A")]],
  ["ceiling", { canUseTool: true, env: { [CEILING_ENV]: "600" } }, [state("running"), RESULT, delay(300), mark("A"), delay(700), mark("B")]],
  ["ceiling_zero_disables", { canUseTool: true, env: { [CEILING_ENV]: "0" } }, [state("running"), RESULT, delay(800), mark("A"), state("idle"), delay(400), mark("B")]],
  ["ceiling_grouped_digits", { canUseTool: true, env: { [CEILING_ENV]: "0_600" } }, [state("running"), RESULT, delay(300), mark("A"), delay(700), mark("B")]],
  ["requires_action_clears_ceiling", { canUseTool: true, env: { [CEILING_ENV]: "600" } }, [state("running"), RESULT, delay(200), state("requires_action"), delay(900), mark("A"), state("running"), delay(300), mark("B"), delay(700), mark("C")]],
  ["assistant_clears_ceiling", { canUseTool: true, env: { [CEILING_ENV]: "600" } }, [state("running"), RESULT, delay(200), { $text: "more" }, delay(900), mark("A"), state("idle"), delay(400), mark("B")]],
  ["stream_event_clears_ceiling", { canUseTool: true, env: { [CEILING_ENV]: "600" } }, [state("running"), RESULT, delay(200), streamEvent, delay(900), mark("A"), state("idle"), delay(400), mark("B")]],
  ["subagent_assistant_keeps_ceiling", { canUseTool: true, env: { [CEILING_ENV]: "600" } }, [state("running"), RESULT, delay(200), subagentText, delay(900), mark("A")]],
  ["hooks_with_no_matchers", { hooks: 0 }, [state("running"), RESULT, delay(400), mark("A"), state("idle"), delay(400), mark("B")]],
  ["hook_callback", { hooks: 1 }, [state("running"), RESULT, delay(400), mark("A"), state("idle"), delay(400), mark("B")]],
  ["sdk_mcp_server", { mcp: true }, [state("running"), RESULT, delay(400), mark("A"), state("idle"), delay(400), mark("B")]],
  ["elicitation", { onElicitation: true }, [state("running"), RESULT, delay(400), mark("A"), state("idle"), delay(400), mark("B")]],
  ["verbatim_prompts", { verbatimPrompts: true }, [{ $text: "hi" }, RESULT, delay(400), mark("A")]],
  ["follow_up_starts_a_new_run", { canUseTool: true, env: { [CEILING_ENV]: "600" }, followUp: "second" }, {
    turns: [
      { match: "go", steps: [state("running"), RESULT, delay(1200), mark("A")], result: false },
      // `idle` before this run's result doesn't end it: `resultReceived` was reset.
      { match: "second", steps: [state("idle"), delay(300), mark("B"), RESULT, delay(400), mark("C")], result: false },
    ],
  }],
].map(([name, spec, body]) => {
  if (Array.isArray(body)) return [name, spec, { turns: [{ steps: [...body, { $exit: 0 }], result: false }] }];
  const turns = body.turns.map((t, i) => (i === body.turns.length - 1 ? { ...t, steps: [...t.steps, { $exit: 0 }] } : t));
  return [name, spec, { turns }];
});

// Raw `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` values (null = unset).
const CEILING_INPUTS = [
  null, "", " ", "600", " 600 ", "0", "-0", "-5", "+7", "12abc", "abc", "0x10", "1.9", "1e3", "1E3", "+1e3", "-1e3",
  "1.5e3", "1.2345e3", ".5e1", "5.e1", "1e400", "1e-3", "1_000", "1,000", "1 000", "1\u00a0000", "1\u202f000",
  "1_000_000", "1_000,000", "1000_000", "12_34", "+1_000", "-1_000", "99999999999999999999", "1".repeat(40),
  "1_000_000_000_000_000_000_000_000_000", "1_000_000_000_000_000_000_000_000_0000", "\t42\n", "\u00a042", "4 2",
  "1e", "1e+", "e5", ".e1", "1.e", "+.5e1", "-.5e-1", "1e3x", "1_00", "1__000", "_1_000",
];

function buildFake() {
  execFileSync("cargo", ["build", "-q", "-p", "claudius-agent", "--bin", "claudius-fake-claude"], {
    cwd: rustDir,
    stdio: "inherit",
    env: { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` },
  });
  return join(rustDir, "target/debug/claudius-fake-claude");
}

/**
 * The SDK's env integer parser (0.3.299 `Ic`, 0.3.312 `fu`) and the run-end
 * ceiling rule, lifted out of sdk.mjs. Minification renames them on every
 * bump, so anchor on the code's shape instead: the parser is the function
 * that trims `String(e)` and falls back to `parseInt(t, 10)`, sitting right
 * after its helper and the three regexes that helper tests.
 */
function sdkCeiling() {
  const src = readFileSync(sdkFile, "utf8");
  const parser = /function ([\w$]+)\(e\)\{let t=String\(e\)\.trim\(\);return ([\w$]+)\(t\)\?\?parseInt\(t,10\)\}/.exec(src);
  if (!parser) throw new Error("the env integer parser moved in sdk.mjs; re-derive the extraction");
  const [tail, outer, inner] = parser;
  const start = src.lastIndexOf("var ", src.indexOf(`function ${inner}(e){`));
  const code = src.slice(start, parser.index + tail.length);
  if (start < 0 || code.length > 600 || !/\[eE\]\[\+-\]\?/.test(code) || !code.includes("\\u202F")) {
    throw new Error(`the ${outer}/${inner} parser's regexes moved in sdk.mjs; re-derive the extraction`);
  }
  // `<ceiling> = Number.isFinite(<parsed>) && <parsed> >= 0 ? <parsed> : <default>`.
  const rule = /=Number\.isFinite\(([\w$]+)\)&&\1>=0\?\1:([\w$]+)/.exec(src);
  if (!rule || !src.includes(`var ${rule[2]}=600000;`)) {
    throw new Error("the ceiling rule in sdk.mjs changed; re-derive the extraction");
  }
  const Ic = new Function(`${code};return ${outer};`)();
  return (raw) => {
    const z = Ic(raw === null ? undefined : raw);
    return Number.isFinite(z) && z >= 0 ? z : 600000;
  };
}

function options(spec) {
  const o = {};
  if (spec.canUseTool) o.canUseTool = async (_name, input) => ({ behavior: "allow", updatedInput: input });
  if (spec.onElicitation) o.onElicitation = async () => ({ action: "decline" });
  if (spec.hooks !== undefined) {
    o.hooks = { PreToolUse: spec.hooks ? [{ hooks: [async () => ({ continue: true })] }] : [] };
  }
  if (spec.mcp) {
    o.mcpServers = {
      srv: createSdkMcpServer({ name: "srv", version: "1.0.0", tools: [tool("echo", "Echo", { msg: z.string() }, async ({ msg }) => ({ content: [{ type: "text", text: msg }] }))] }),
    };
  }
  if (spec.verbatimPrompts) o.verbatimPrompts = true;
  return o;
}

/** The follow-up prompt, as streamed by both sides. */
const followUpMessage = (text) => ({ type: "user", session_id: "", message: { role: "user", content: text }, parent_tool_use_id: null });

/**
 * Starts timing the event loop: the returned function stops and gives the
 * longest the loop went without a turn, in ms. A plain interval, because
 * `monitorEventLoopDelay` misses a stall that starts right after `reset()`.
 */
function stallProbe() {
  const tick = 10;
  let last = performance.now();
  let worst = 0;
  const gap = () => {
    const now = performance.now();
    worst = Math.max(worst, now - last - tick);
    last = now;
  };
  const timer = setInterval(gap, tick);
  return () => {
    clearInterval(timer);
    gap();
    return worst;
  };
}

/** One run of a case: its record, or why the run doesn't count. */
async function recordOnce(fake, [name, spec, script]) {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "run-end-golden-")));
  const log = join(tmp, "stdin.log");
  const events = join(tmp, "events.log");
  const q = query({
    prompt: "go",
    options: {
      pathToClaudeCodeExecutable: fake,
      cwd: tmp,
      env: { PATH: "/usr/bin:/bin", HOME: tmp, FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_EVENTS: events, FAKE_CLAUDE_SCRIPT: JSON.stringify(script), ...spec.env },
      ...options(spec),
    },
  });
  // `query()` has spawned the CLI; time the event loop from here.
  const stopProbe = stallProbe();
  const yielded = [];
  let followedUp = false;
  let stall;
  try {
    for await (const msg of q) {
      yielded.push(msg.subtype ? `${msg.type}/${msg.subtype}` : msg.type);
      if (spec.followUp && msg.type === "result" && !followedUp) {
        followedUp = true;
        q.streamInput((async function* () {
          yield followUpMessage(spec.followUp);
        })());
      }
    }
  } finally {
    stall = stopProbe();
  }
  const text = (f) => readFileSync(f, "utf8");
  const lines = (t) => t.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const eventsText = text(events);
  const out = {
    name,
    spec,
    script,
    events: eventsText.endsWith("\n") ? lines(eventsText).map((e) => (e.eof ? "eof" : e.mark)) : null,
    userLines: lines(text(log)).filter((m) => m.type === "user"),
    yielded,
  };
  rmSync(tmp, { recursive: true, force: true });
  if (stall > STALL_MS) return { skip: `the event loop stalled ${Math.round(stall)} ms` };
  if (!out.events) return { skip: "the events log ends mid-line" };
  return { out };
}

/** A case's record, once AGREE runs in a row match. */
async function record(fake, c) {
  let last;
  let streak = 0;
  for (let run = 1; run <= MAX_RUNS; run++) {
    const { out, skip } = await recordOnce(fake, c);
    if (skip) {
      console.error(`${c[0]}: run ${run} doesn't count: ${skip}`);
      [last, streak] = [undefined, 0];
      continue;
    }
    const json = JSON.stringify(out);
    if (last !== undefined && json !== last) console.error(`${c[0]}: run ${run} differs from the run before`);
    streak = json === last ? streak + 1 : 1;
    last = json;
    if (streak === AGREE) return out;
  }
  throw new Error(`${c[0]}: no ${AGREE} matching runs in a row out of ${MAX_RUNS}; is the machine too loaded?`);
}

const fake = buildFake();
const ceiling = sdkCeiling();
const cases = [];
for (const c of CASES) cases.push(await record(fake, c));
const ceilingTable = CEILING_INPUTS.map((raw) => ({ raw, ceiling: ceiling(raw) }));
const file = join(rustDir, "crates/claudius-agent/tests/fixtures/run_end_golden.json");
writeFileSync(file, `${JSON.stringify({ sdkVersion, cases, ceilingTable }, null, 2)}\n`);
for (const c of cases) console.log(`${c.name.padEnd(34)} ${c.events.join(" ")}`);
console.log(`wrote ${file.slice(repo.length + 1)}`);
