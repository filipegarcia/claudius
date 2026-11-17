#!/usr/bin/env node
// Golden fixture for how the REAL TS SDK ends the CLI once the host is done
// with a query: when the CLI sees its stdin close, when it gets SIGTERM and
// SIGKILL, when the host's call resolves and when the message stream ends
// (R13).
//
//   node rust/scripts/close-timing-golden.mjs     (builds claudius-fake-claude)
//
// The SDK pieces in play (sdk.mjs, 0.3.312):
//   - `ProcessTransport.close()` ends stdin at once. If the CLI is still
//     running, an unref'd `D9e` (2000 ms) timer checks again: exited by then,
//     nothing more; else `kill("SIGTERM")` and an unref'd 5000 ms timer that
//     calls `kill("SIGKILL")` while `exitCode === null` (also true after a
//     death by signal, when Node's kill() is a no-op). When the query was
//     aborted, the 2 s timer also forwards the abort to the spawn's `signal`
//     option, so Node sends a second SIGTERM in the same tick (none once the
//     CLI has exited: Node drops that listener at the exit).
//   - Four ways to get there. `Query.close()` runs `cleanup()` without
//     awaiting it. The abort signal's handler calls `ProcessTransport.close()`
//     (what session.ts `end()` reaches: `inputQueue.close()`, then
//     `abortController.abort()`). `return()` (breaking out of `for await`, as
//     the one-shot callers do) awaits `cleanup()`, which resolves once the
//     CLI exited or after 2000 ms (`Promise.race([waitForExit(), 2000 ms])`).
//     The reader throwing (R12: a malformed `initialize` reply) runs
//     `cleanup(e)`.
//   - The stream the host reads (`readSdkMessages`) awaits that same cleanup
//     in its `finally`, so after `close()` or the throw its end (or error)
//     comes once the CLI exited or after 2 s. After the abort the reader
//     runs until the CLI's stdout closes.
//
// The CLI is claudius-fake-claude in four behaviours: `eof` exits at stdin's
// EOF, `term` ignores EOF and dies by SIGTERM, `stubborn` ignores both, and
// `term_late` ignores EOF and exits 3.5 s after SIGTERM. The fake logs when
// it saw EOF and SIGTERM ($FAKE_CLAUDE_TIMES). `child_process.spawn` is
// wrapped before the SDK is imported, to log every `kill()` the SDK and Node
// make on the CLI (with whether a signal was sent) and the exit. Times are ms
// after the host's call (for the throw, after the CLI saw EOF), put in coarse
// buckets so the fixture is deterministic under load; a time between buckets
// fails the recording. Each case runs RUNS times and must agree; the cases
// of a round run at once.
//
// Written to rust/crates/claudius-agent/tests/fixtures/close_timing_golden.json,
// replayed by crates/claudius-agent/tests/close_timing_golden.rs.
import childProcess, { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const sdkPath = join(repo, "node_modules/@anthropic-ai/claude-agent-sdk");

// Every CLI the SDK spawns, by its $FAKE_CLAUDE_TIMES path: the kill() calls
// on it and its exit. The SDK binds `spawn` with an ESM import, which
// `syncBuiltinESMExports` points at this wrapper.
const spawned = new Map();
const realSpawn = childProcess.spawn;
childProcess.spawn = function spawn(...args) {
  const child = realSpawn.apply(this, args);
  const key = args[2]?.env?.FAKE_CLAUDE_TIMES;
  if (key) {
    const rec = { kills: [], exit: null };
    spawned.set(key, rec);
    const kill = child.kill;
    child.kill = function (signal) {
      const sent = kill.call(this, signal);
      rec.kills.push({ signal: signal ?? "SIGTERM", sent, ms: Date.now() });
      return sent;
    };
    child.once("exit", (code, signal) => {
      rec.exit = { code, signal, ms: Date.now() };
    });
  }
  return child;
};
syncBuiltinESMExports();
const { query } = await import(pathToFileURL(join(sdkPath, "sdk.mjs")).href);
const sdkVersion = JSON.parse(readFileSync(join(sdkPath, "package.json"), "utf8")).version;

const RUNS = 3;
// Long enough to see the 7 s SIGKILL timer fire.
const OBSERVE_MS = 9500;
// [label, from, to): ms after the call. The gaps catch a time that moved.
const BUCKETS = [
  ["0-1s", -500, 1000],
  ["2-3.5s", 1800, 3500],
  ["5-6.5s", 5000, 6500],
  ["7-9s", 6800, 9000],
];

const ignoreEof = [{ $delay_ms: 60_000 }];
const BEHAVIORS = {
  eof: {},
  term: { on_eof: ignoreEof, on_sigterm: "die" },
  stubborn: { on_eof: ignoreEof, on_sigterm: "ignore" },
  term_late: { on_eof: ignoreEof, on_sigterm: { exit: 0, after_ms: 3500 } },
};
const PATHS = ["close", "abort", "return", "throw"];

// The fake says "ready" once initialized (after its system/init), so every
// path starts with the CLI idle in its read loop. The throw path's `initialize` reply makes the
// SDK's reader throw ("e is not iterable") before that.
function script(path, behavior) {
  return {
    ...BEHAVIORS[behavior],
    on_init: [{ $text: "ready" }],
    ...(path === "throw" && { control: { initialize: { $envelope: { pending_permission_requests: 5 } } } }),
  };
}

function buildFake() {
  execFileSync("cargo", ["build", "-q", "-p", "claudius-agent", "--bin", "claudius-fake-claude"], {
    cwd: rustDir,
    stdio: "inherit",
    env: { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` },
  });
  return join(rustDir, "target/debug/claudius-fake-claude");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

function bucket(ms, what) {
  const hit = BUCKETS.find(([, from, to]) => ms >= from && ms < to);
  if (!hit) throw new Error(`${what}: ${ms} ms is between buckets (load?); rerun`);
  return hit[0];
}

async function run(fake, path, behavior) {
  const name = `${path}/${behavior}`;
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "close-timing-golden-")));
  const times = join(tmp, "times.log");
  let finish;
  const done = new Promise((r) => (finish = r));
  async function* prompt() {
    await done; // never yields: the session's queue between prompts
  }
  const abortController = new AbortController();
  const q = query({
    prompt: prompt(),
    options: {
      pathToClaudeCodeExecutable: fake,
      cwd: tmp,
      abortController,
      env: { PATH: "/usr/bin:/bin", HOME: tmp, FAKE_CLAUDE_TIMES: times, FAKE_CLAUDE_SCRIPT: JSON.stringify(script(path, behavior)) },
    },
  });
  const it = q[Symbol.asyncIterator]();
  // How the stream ended, and when.
  let streamEnd;
  const settle = (p) =>
    p.then(
      (r) => {
        if (!r.done) throw new Error(`${name}: a message after the call: ${JSON.stringify(r.value)}`);
        streamEnd = { error: null, ms: Date.now() };
      },
      (e) => {
        streamEnd = { error: e.message, ms: Date.now() };
      },
    );
  let t0;
  let resolved;
  try {
    if (path === "throw") {
      // system/init, then the throw.
      for (;;) {
        let r;
        try {
          r = await it.next();
        } catch (e) {
          streamEnd = { error: e.message, ms: Date.now() };
          break;
        }
        if (r.done) throw new Error(`${name}: the stream ended without throwing`);
      }
    } else {
      // system/init, then "ready".
      for (;;) {
        const r = await it.next();
        if (r.done) throw new Error(`${name}: the stream ended before "ready"`);
        if (r.value.type === "assistant") break;
      }
      t0 = Date.now();
      if (path === "close") q.close();
      else if (path === "abort") {
        finish();
        abortController.abort();
      } else await it.return();
      resolved = Date.now() - t0;
      if (path !== "return") await settle(it.next());
    }
    // Long enough for the last timer, counted from the call (or the EOF).
    await sleep((t0 ?? Date.now()) + OBSERVE_MS - Date.now());
  } finally {
    finish();
    abortController.abort();
  }
  const rec = spawned.get(times);
  spawned.delete(times);
  if (!rec?.exit) throw new Error(`${name}: the CLI is still running`);
  const seen = existsSync(times) ? readFileSync(times, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  rmSync(tmp, { recursive: true, force: true });
  const first = (event) => seen.find((e) => e.event === event)?.ms;
  const at = { eof: first("eof"), sigterm: first("SIGTERM"), exit: rec.exit.ms };
  if (at.eof === undefined) throw new Error(`${name}: the CLI never saw EOF`);
  t0 ??= at.eof;
  const order = Object.keys(at)
    .filter((k) => at[k] !== undefined)
    .sort((a, b) => at[a] - at[b]);
  const when = (k) => (at[k] === undefined ? null : bucket(at[k] - t0, `${name} ${k}`));
  return {
    eof: when("eof"),
    sigterm: when("sigterm"),
    exit: { ...(rec.exit.signal ? { signal: rec.exit.signal } : { code: rec.exit.code }), at: when("exit") },
    order,
    ...(resolved !== undefined && { resolved: bucket(resolved, `${name} resolved`) }),
    ...(streamEnd && { streamEnd: { error: streamEnd.error, at: bucket(streamEnd.ms - t0, `${name} stream end`) } }),
    kills: rec.kills.map((k) => ({ signal: k.signal, sent: k.sent, at: bucket(k.ms - t0, `${name} kill`) })),
  };
}

const fake = buildFake();
const cases = PATHS.flatMap((path) => Object.keys(BEHAVIORS).map((behavior) => ({ path, behavior })));
const rounds = [];
for (let i = 0; i < RUNS; i++) rounds.push(await Promise.all(cases.map((c) => run(fake, c.path, c.behavior))));
const out = cases.map((c, n) => {
  const want = rounds[0][n];
  for (let i = 1; i < RUNS; i++) {
    if (!isDeepStrictEqual(rounds[i][n], want)) {
      console.error(`${c.path}/${c.behavior}: run ${i} differs\n  ${JSON.stringify(want)}\n  ${JSON.stringify(rounds[i][n])}`);
      process.exitCode = 1;
    }
  }
  console.log(`${c.path}/${c.behavior}: ${JSON.stringify(want)}`);
  return { ...c, script: script(c.path, c.behavior), want };
});
if (process.exitCode) throw new Error("runs disagree: not writing the fixture");
const file = join(rustDir, "crates/claudius-agent/tests/fixtures/close_timing_golden.json");
writeFileSync(file, `${JSON.stringify({ sdkVersion, observeMs: OBSERVE_MS, buckets: BUCKETS, runs: RUNS, cases: out }, null, 2)}\n`);
console.log(`wrote ${file.slice(repo.length + 1)}`);
