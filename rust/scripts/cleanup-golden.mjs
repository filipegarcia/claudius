#!/usr/bin/env node
// Golden fixture for control requests at and after the SDK's cleanup: what
// the REAL TypeScript SDK's `Query.request` (here `backgroundTasks()`) and
// `initializationResult()` settle with once the CLI is gone, dying, or the
// host aborted.
//
//   node rust/scripts/cleanup-golden.mjs     (builds claudius-fake-claude)
//
// The SDK pieces in play (sdk.mjs):
//   - `Query.request` rejects up front with "Query closed before response
//     received" once `cleanupPerformed` is set (the reader ended);
//   - `performCleanup(cause)` rejects every pending control response,
//     `initialize` included, with the cause (the exit / error-result error)
//     or that same "Query closed…" error;
//   - `ProcessTransport.write` throws "Operation aborted" once the abort
//     signal fired, and silently drops a write to an ended stdin.
//
// Each case runs `query()` against `claudius-fake-claude` and walks a list of
// steps (replayed step for step by
// crates/claudius-agent/tests/cleanup_golden.rs against the Rust `Query`):
//   ["request", label]  start `backgroundTasks()`; its outcome goes to label
//   ["settle", label]   wait for it (≤ SETTLE_MS, else "pending")
//   ["init"]            record `initializationResult()` under "init"
//   ["drain"]           read messages to the end; the end goes to "stream"
//   ["until_result"]    read messages up to the first `result`
//   ["next"]            read one message (or the end)
//   ["abort"]           `abortController.abort()` (the Rust `close()`)
//   ["sleep", ms]
// An outcome is {ok: value} or {error: message}. `mode` is "stream" (an
// AsyncIterable prompt that never yields, like the session's queue) or
// "single" (a string prompt: the SDK closes stdin when the run ends). A
// case with `exe` runs that shell script as the CLI instead of the fake.
//
// Every case runs RUNS times and must record the same outcomes each time;
// a race shows up as a failure here rather than as a flaky Rust test.
//
// Written to rust/crates/claudius-agent/tests/fixtures/cleanup_golden.json.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const sdkPath = join(repo, "node_modules/@anthropic-ai/claude-agent-sdk");
const { query } = await import(pathToFileURL(join(sdkPath, "sdk.mjs")).href);
const sdkVersion = JSON.parse(readFileSync(join(sdkPath, "package.json"), "utf8")).version;
const SETTLE_MS = 5000;
const RUNS = 5;

const errorResult = { type: "result", subtype: "error_during_execution", is_error: true, errors: ["  model fell over "], num_turns: 1, duration_ms: 1, duration_api_ms: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } };
const okResult = { type: "result", subtype: "success", is_error: false, result: "ok", num_turns: 1, duration_ms: 1, duration_api_ms: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } };
const noReply = (...emit) => ({ control: { background_tasks: { $no_reply: true, $emit: emit } } });
const boom = [{ $stderr: "boom" }, { $exit: 3 }];

// A CLI that takes `initialize`, closes its stdin and stays up: the next
// write hits a dead pipe, which Node reports later as a stdin `error`. It
// prints a line once stdin is closed, so a `next` step can wait for that
// instead of guessing how long the shell takes to start.
const CLOSES_STDIN =
  "#!/bin/sh\nread -r line\nexec 0<&-\nprintf '%s\\n' '{\"type\":\"system\",\"subtype\":\"stdin_closed\"}'\nsleep 1.5\nexit 3\n";

// [name, mode, fake script, steps, exe?]
const CASES = [
  // After the reader ended: `cleanupPerformed` → "Query closed…", whatever the cause was.
  ["after_clean_exit", "stream", { on_init: [{ $exit: 0 }] }, [["drain"], ["request", "r"], ["settle", "r"]]],
  ["after_exit_3", "stream", { on_init: boom }, [["drain"], ["request", "r"], ["settle", "r"]]],
  ["after_error_result_exit", "stream", { on_init: [errorResult, { $exit: 1 }] }, [["drain"], ["request", "r"], ["settle", "r"]]],
  ["after_signal", "stream", { on_init: [{ $kill: "SIGTERM" }] }, [["drain"], ["request", "r"], ["settle", "r"]]],
  // In flight when the CLI goes: rejected with the cleanup cause, or "Query closed…".
  ["inflight_exit_0", "stream", noReply({ $exit: 0 }), [["request", "r"], ["settle", "r"], ["drain"]]],
  ["inflight_exit_3", "stream", noReply(...boom), [["request", "r"], ["settle", "r"], ["drain"]]],
  ["inflight_error_result", "stream", noReply(errorResult, { $exit: 1 }), [["request", "r"], ["settle", "r"], ["drain"]]],
  ["inflight_error_result_exit_0", "stream", noReply(errorResult, { $exit: 0 }), [["request", "r"], ["settle", "r"], ["drain"]]],
  ["inflight_signal", "stream", noReply({ $kill: "SIGTERM" }), [["request", "r"], ["settle", "r"], ["drain"]]],
  ["two_inflight_exit_3", "stream", noReply(...boom), [["request", "a"], ["request", "b"], ["settle", "a"], ["settle", "b"], ["drain"]]],
  // The host aborts.
  ["inflight_abort", "stream", noReply(), [["request", "r"], ["sleep", 300], ["abort"], ["settle", "r"], ["drain"]]],
  ["request_right_after_abort", "stream", {}, [["sleep", 300], ["abort"], ["request", "r"], ["settle", "r"], ["drain"]]],
  ["request_after_abort_drained", "stream", {}, [["sleep", 300], ["abort"], ["drain"], ["request", "r"], ["settle", "r"]]],
  // `initialize` never answered.
  ["init_unanswered_exit_0", "stream", { control: { initialize: { $no_reply: true, $emit: [{ $exit: 0 }] } } }, [["init"], ["drain"], ["request", "r"], ["settle", "r"]]],
  ["init_unanswered_exit_3", "stream", { control: { initialize: { $no_reply: true, $emit: boom } } }, [["init"], ["drain"], ["request", "r"], ["settle", "r"]]],
  ["init_unanswered_abort", "stream", { control: { initialize: { $no_reply: true } } }, [["sleep", 300], ["abort"], ["init"], ["drain"]]],
  // Stdin already ended (single-turn run over), process still alive: the
  // write is dropped and the request waits for the cleanup.
  ["after_run_end_exit_0", "single", { turns: [{ steps: [{ $text: "hi" }, okResult, { $delay_ms: 600 }, { $exit: 0 }], result: false }] }, [["until_result"], ["request", "r"], ["settle", "r"], ["drain"]]],
  ["after_run_end_exit_3", "single", { turns: [{ steps: [{ $text: "hi" }, okResult, { $delay_ms: 600 }, ...boom], result: false }] }, [["until_result"], ["request", "r"], ["settle", "r"], ["drain"]]],
  // Exited, but a grandchild holds stdout open so the reader hasn't ended:
  // the transport isn't `ready`, and waiters wait for the reader.
  ["exited_reader_open", "stream", { on_init: [{ $hold_stdout_ms: 1500 }, { $exit: 0 }] }, [["sleep", 500], ["request", "r"], ["settle", "r"], ["drain"]]],
  ["inflight_exit_3_reader_open", "stream", noReply({ $hold_stdout_ms: 1500 }, ...boom), [["request", "a"], ["sleep", 500], ["request", "b"], ["settle", "b"], ["settle", "a"], ["drain"]]],
  // A write into the dead pipe doesn't fail its request; the next write does.
  ["cli_closed_stdin", "stream", {}, [["next"], ["request", "a"], ["sleep", 200], ["request", "b"], ["settle", "b"], ["settle", "a"], ["init"], ["drain"]], CLOSES_STDIN],
];

function buildFake() {
  execFileSync("cargo", ["build", "-q", "-p", "claudius-agent", "--bin", "claudius-fake-claude"], {
    cwd: rustDir,
    stdio: "inherit",
    env: { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` },
  });
  return join(rustDir, "target/debug/claudius-fake-claude");
}

const outcome = (p) => p.then((ok) => ({ ok }), (e) => ({ error: e instanceof Error ? e.message : String(e) }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(fake, [, mode, script, steps, exe]) {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "cleanup-golden-")));
  let cli = fake;
  if (exe) {
    cli = join(tmp, "cli");
    writeFileSync(cli, exe, { mode: 0o755 });
  }
  let finish;
  const done = new Promise((r) => (finish = r));
  async function* prompt() {
    await done; // never yields: the session's queue between prompts
  }
  const abortController = new AbortController();
  const q = query({
    prompt: mode === "single" ? "hi" : prompt(),
    options: {
      pathToClaudeCodeExecutable: cli,
      cwd: tmp,
      abortController,
      env: { PATH: "/usr/bin:/bin", HOME: tmp, FAKE_CLAUDE_SCRIPT: JSON.stringify(script) },
    },
  });
  const it = q[Symbol.asyncIterator]();
  const out = {};
  const started = {};
  let ended = false;
  const next = async () => {
    try {
      const r = await it.next();
      if (r.done) {
        ended = true;
        out.stream = { ok: null };
      }
      return r;
    } catch (e) {
      ended = true;
      out.stream = { error: e instanceof Error ? e.message : String(e) };
      return { done: true };
    }
  };
  try {
    for (const [op, arg] of steps) {
      if (op === "request") started[arg] = outcome(q.backgroundTasks());
      else if (op === "settle") out[arg] = await Promise.race([started[arg], sleep(SETTLE_MS).then(() => "pending")]);
      else if (op === "init") out.init = await Promise.race([outcome(q.initializationResult()).then((o) => ("ok" in o ? { ok: "initialized" } : o)), sleep(SETTLE_MS).then(() => "pending")]);
      else if (op === "drain") while (!ended && !(await next()).done);
      else if (op === "next") {
        if (!ended) await next();
      }
      else if (op === "until_result") {
        for (;;) {
          const r = await next();
          if (r.done || r.value?.type === "result") break;
        }
      } else if (op === "abort") abortController.abort();
      else if (op === "sleep") await sleep(arg);
      else throw new Error(`unknown step ${op}`);
    }
  } finally {
    finish();
    abortController.abort();
    rmSync(tmp, { recursive: true, force: true });
  }
  return out;
}

const fake = buildFake();
const cases = [];
for (const c of CASES) {
  const [name, mode, script, steps, exe] = c;
  let first;
  for (let i = 0; i < RUNS; i++) {
    const out = await run(fake, c);
    if (i === 0) first = out;
    else if (!isDeepStrictEqual(out, first)) {
      console.error(`${name}: run ${i} differs\n  ${JSON.stringify(first)}\n  ${JSON.stringify(out)}`);
      process.exitCode = 1;
    }
  }
  console.log(`${name}: ${JSON.stringify(first)}`);
  cases.push({ name, mode, script, steps, ...(exe && { exe }), want: first });
}
if (process.exitCode) throw new Error("racy cases: not writing the fixture");
const file = join(rustDir, "crates/claudius-agent/tests/fixtures/cleanup_golden.json");
writeFileSync(file, `${JSON.stringify({ sdkVersion, settleMs: SETTLE_MS, runs: RUNS, cases }, null, 2)}\n`);
console.log(`wrote ${file.slice(repo.length + 1)}`);
