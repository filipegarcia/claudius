#!/usr/bin/env node
// Golden fixture for the session recap (S12): `lib/server/session-recap.ts`
// (`extractTranscriptTail`, `generateRecap`) and `lib/shared/recap-cap.ts`
// (`capRecap`).
//
//   node rust/scripts/recap-golden.mjs     (node@22; builds claudius-fake-claude)
//
// Re-runs itself under `--experimental-transform-types` with a resolve hook
// for the `@/` imports. The hook also maps the SDK import of
// `session-recap.ts` to a shim that calls the real `query()` with one option
// added, `pathToClaudeCodeExecutable` (the fake CLI): `generateRecap` passes
// none, so the SDK would look for its own binary. Everything else
// `generateRecap` does runs as is.
//
// Records:
// - `extractTranscriptTail(buffer)` over hand-built broadcast buffers;
// - `capRecap(text, max?)` around its boundaries;
// - `generateRecap(input)` against scripted fake-CLI turns: the outcome, and
//   the CLI's argv, env and stdin (the `initialize` request and the prompt),
//   normalized like `golden-wire.mjs`.
//
// A JS string can hold a lone surrogate (a UTF-16 cut through a pair); a
// Rust string can't, so the Rust side drops that unit. Outputs are recorded
// with lone surrogates removed, plus `jsLength` (the JS `.length`) and
// `lone` (how many were removed), so the replay checks both.
//
// Written to rust/crates/claudius-core/tests/fixtures/recap_golden.json and
// replayed by crates/claudius-core/tests/recap_golden.rs.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "crates/claudius-core/tests/fixtures/recap_golden.json");

if (!process.env.RECAP_GOLDEN_CHILD) {
  execFileSync("cargo", ["build", "-q", "-p", "claudius-agent", "--bin", "claudius-fake-claude"], {
    cwd: rustDir,
    stdio: "inherit",
    env: { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` },
  });
  const r = spawnSync(
    process.execPath,
    ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url)],
    {
      encoding: "utf8",
      maxBuffer: 1 << 26,
      env: {
        ...process.env,
        RECAP_GOLDEN_CHILD: "1",
        RECAP_GOLDEN_FAKE: join(rustDir, "target/debug/claudius-fake-claude"),
      },
    },
  );
  if (r.status !== 0) {
    process.stderr.write(r.stderr);
    process.exit(r.status ?? 1);
  }
  const fixture = JSON.parse(r.stdout);
  writeFileSync(out, JSON.stringify(fixture, null, 1) + "\n");
  console.log(
    `wrote ${out}: ${fixture.tails.length} tails, ${fixture.caps.length} caps, ${fixture.generate.length} generateRecap runs (SDK ${fixture.sdkVersion})`,
  );
  process.exit(0);
}

// ---- child -------------------------------------------------------------------

const SDK = "@anthropic-ai/claude-agent-sdk";
const realSdk = import.meta.resolve(SDK);
const shimDir = realpathSync(mkdtempSync(join(tmpdir(), "recap-golden-shim-")));
const shim = join(shimDir, "sdk-shim.mjs");
writeFileSync(
  shim,
  `import * as real from ${JSON.stringify(realSdk)};
export * from ${JSON.stringify(realSdk)};
export function query(args) {
  return real.query({ ...args, options: { ...args.options, pathToClaudeCodeExecutable: process.env.RECAP_GOLDEN_FAKE } });
}
`,
);
const hook = `
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
const ROOT = ${JSON.stringify(pathToFileURL(repo + "/").href)};
const SHIM = ${JSON.stringify(pathToFileURL(shim).href)};
export async function resolve(spec, ctx, next) {
  if (spec === ${JSON.stringify(SDK)} && ctx.parentURL && ctx.parentURL.endsWith("/lib/server/session-recap.ts")) {
    return { url: SHIM, shortCircuit: true };
  }
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

const { extractTranscriptTail, generateRecap, RECAP_INSTRUCTION, RECAP_DEDUPE_WINDOW_MS } = await import(
  pathToFileURL(join(repo, "lib/server/session-recap.ts")).href
);
const { capRecap, RECAP_MAX_CHARS } = await import(pathToFileURL(join(repo, "lib/shared/recap-cap.ts")).href);
const sdkVersion = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(realSdk)), "package.json"), "utf8"),
).version;

/** A string as the Rust side can hold it, plus what JS had. */
function rustable(s) {
  let lone = 0;
  let text = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        text += s[i] + s[i + 1];
        i++;
      } else lone++;
    } else if (c >= 0xdc00 && c <= 0xdfff) lone++;
    else text += s[i];
  }
  return { text, jsLength: s.length, lone };
}

// ---- extractTranscriptTail -----------------------------------------------------

const sdk = (message) => ({ type: "sdk", message });
const user = (content, extra = {}) =>
  sdk({ type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: "s", ...extra });
const asst = (content, extra = {}) =>
  sdk({ type: "assistant", message: { role: "assistant", content }, parent_tool_use_id: null, session_id: "s", ...extra });
const text = (t) => ({ type: "text", text: t });
const words = (n, w = "word") => Array.from({ length: n }, (_, i) => `${w}${i}`).join(" ");

const TAILS = [
  ["empty", []],
  ["no sdk events", [{ type: "turn_status", status: "idle" }, { type: "todo_update", todos: [] }]],
  [
    "a conversation",
    [
      user("hi there"),
      asst([text("hello"), { type: "thinking", thinking: "hmm" }, text("how can I help?")]),
      user([text("part a"), { type: "image", source: {} }, text("part b")]),
      asst([{ type: "tool_use", id: "t1", name: "Bash", input: {} }]),
      user([{ type: "tool_result", tool_use_id: "t1", content: "out" }], { parent_tool_use_id: "t1" }),
      asst([text("done")]),
    ],
  ],
  [
    "skipped user shapes",
    [
      user("tool result", { parent_tool_use_id: "t1" }),
      user("synthetic", { isSynthetic: true }),
      user("synthetic 1", { isSynthetic: 1 }),
      user("synthetic empty string", { isSynthetic: "" }),
      user("synthetic 0", { isSynthetic: 0 }),
      user("parent empty string", { parent_tool_use_id: "" }),
      user("parent 0", { parent_tool_use_id: 0 }),
      user("parent object", { parent_tool_use_id: {} }),
      user("  \n\t "),
      user("\u00a0 nbsp and bom \ufeff"),
      user("\u0085 nel stays \u0085"),
      user("\u2028 line sep \u3000"),
      user(null),
      user(42),
      user({ text: "object content" }),
      user([null, 5, "str", [], { type: "text", text: 5 }, { type: "text" }, { type: "TEXT", text: "x" }]),
      user([text("  "), text(" ")]),
      user([text(" padded "), text(" both ")]),
      sdk({ type: "user", message: null, parent_tool_use_id: null }),
      sdk({ type: "user", parent_tool_use_id: null }),
      sdk({ type: "user", message: "str", parent_tool_use_id: null }),
    ],
  ],
  [
    "skipped assistant shapes",
    [
      asst([text("subagent")], { parent_tool_use_id: "t9" }),
      asst("string content"),
      asst(null),
      asst([]),
      asst([text(" a "), text("b ")]),
      sdk({ type: "assistant", message: null, parent_tool_use_id: null }),
      sdk({ type: "assistant", parent_tool_use_id: null }),
      sdk({ type: "system", subtype: "init" }),
      sdk({ type: "result", subtype: "success", result: "r" }),
      sdk({ type: "stream_event", event: {} }),
    ],
  ],
  ["one huge user turn", [user("older"), user("x".repeat(5000))]],
  ["exactly the budget", [user("older"), user("y".repeat(4000 - 6))]],
  ["one over the budget", [user("older"), user("y".repeat(4000 - 5))]],
  ["budget left for a tail", [user("hello world foo"), asst([text("z".repeat(3990 - 11))])]],
  ["budget left 1", [user("abc"), asst([text("z".repeat(3999 - 11))])]],
  ["budget left 2", [user("abc"), asst([text("z".repeat(3998 - 11))])]],
  ["budget left 0", [user("abc"), asst([text("z".repeat(4000 - 11))])]],
  ["many turns", Array.from({ length: 60 }, (_, i) => (i % 2 ? asst([text(words(12, `a${i}-`))]) : user(words(10, `u${i}-`))))],
  ["a cut through a pair", [user("older"), user("a".repeat(3998) + "\u{1F600}" + "b".repeat(10))]],
  ["a cut after a pair", [user("older"), user("a".repeat(3997) + "\u{1F600}" + "b".repeat(10))]],
  ["astral text", [user("\u{1F600}".repeat(30)), asst([text("\u{1D11E} clef")])]],
  // A broadcast `sdk` event without a message throws (`msg.type`).
  ["sdk event without message", [user("fine"), { type: "sdk" }]],
  ["sdk event with null message", [{ type: "sdk", message: null }, user("fine")]],
];

const tails = TAILS.map(([name, buffer]) => {
  try {
    const r = extractTranscriptTail(buffer);
    return { name, buffer, ...rustable(r.text), turnCount: r.turnCount };
  } catch (e) {
    return { name, buffer, throws: e instanceof TypeError ? "TypeError" : String(e) };
  }
});

// ---- capRecap -------------------------------------------------------------------

const CAPS = [
  [""],
  ["short"],
  ["a".repeat(399)],
  ["a".repeat(400)],
  ["a".repeat(401)],
  ["a".repeat(1000)],
  [words(80)],
  [words(200)],
  ["a".repeat(239) + " " + "b".repeat(300)],
  ["a".repeat(240) + " " + "b".repeat(300)],
  ["a".repeat(250) + "    " + "b".repeat(300)],
  ["a".repeat(250) + " \u00a0\u00a0 " + "b".repeat(300)],
  ["a".repeat(390) + "         " + "b".repeat(300)],
  ["a".repeat(398) + " " + "b".repeat(10)],
  ["a".repeat(397) + "\u{1F600}" + "b".repeat(10)],
  ["a".repeat(398) + "\u{1F600}" + "b".repeat(10)],
  ["a ".repeat(130) + "a".repeat(100) + "\u{1F600}".repeat(40)],
  ["\u{1F600}".repeat(300)],
  ["x\u00a0".repeat(300)],
  // JS `trimEnd` keeps NEL and strips a BOM; Rust's `trim_end` does the reverse.
  ["a".repeat(250) + "\u0085\u0085 " + "b".repeat(300)],
  ["a".repeat(250) + "\ufeff\ufeff " + "b".repeat(300)],
  ["abcdef", 1],
  ["abcdef", 2],
  ["abcdef", 0],
  ["ab cdef", 4],
  ["a b c d e f", 5],
  ["abc", 3],
  ["abcd", 3],
  // 60% of the budget is a whole number: a space exactly there is too early.
  ["abc defg", 6],
  ["abcd efg", 6],
];
const caps = CAPS.map(([input, max]) => ({
  input,
  ...(max !== undefined ? { max } : {}),
  ...rustable(max !== undefined ? capRecap(input, max) : capRecap(input)),
}));

// ---- generateRecap --------------------------------------------------------------

const turn = (steps) => ({ turns: [{ match: "stepped away", steps }] });
const longReply = words(120, "step");
const GENERATE = [
  ["plain", turn([{ $text: "Porting the recap. Next: run the gate." }]), {}],
  ["whitespace", turn([{ $text: "  Line one.\n\nLine   two.\t\u00a0end \u2028" }]), {}],
  ["long", turn([{ $text: longReply }]), {}],
  [
    "blocks and messages",
    turn([
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [text("A"), { type: "tool_use", id: "t", name: "Bash", input: {} }, text("B ")],
        },
        parent_tool_use_id: null,
      },
      { $text: "C" },
    ]),
    {},
  ],
  [
    "subagent text ignored",
    turn([
      { type: "assistant", message: { role: "assistant", content: [text("ignored")] }, parent_tool_use_id: "t1" },
      { $text: "kept" },
    ]),
    {},
  ],
  [
    "only a tool use",
    turn([
      { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t", name: "Bash", input: {} }] }, parent_tool_use_id: null },
    ]),
    {},
  ],
  ["whitespace only", turn([{ $text: " \n\t " }]), {}],
  [
    "a tool request is denied",
    turn([
      {
        $control: {
          subtype: "can_use_tool",
          tool_name: "Bash",
          input: { command: "ls" },
          tool_use_id: "toolu_1",
          permission_suggestions: [],
        },
      },
      { $text: "$LAST:/message" },
    ]),
    {},
  ],
  ["with a model", turn([{ $text: "ok" }]), { model: "claude-golden-1" }],
  ["the CLI exits", turn([{ $stderr: "boom" }, { $exit: 3 }]), {}],
  ["no result", { turns: [{ match: "stepped away", steps: [{ $text: "no result" }], result: false }] }, { abortAfterMs: 1500 }],
  ["aborted mid-flight", turn([{ $delay_ms: 4000 }, { $text: "late" }]), { abortAfterMs: 400 }],
  ["aborted before the call", turn([{ $text: "never" }]), { preAborted: true }],
];

function norm(value, tmp) {
  if (typeof value === "string") return value.split(tmp).join("$TMP");
  if (Array.isArray(value)) return value.map((v) => norm(v, tmp));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, norm(v, tmp)]));
  }
  return value;
}
const readJson = (f) => {
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return null;
  }
};

const TAIL = "USER: what's next?\n\nASSISTANT: The gate.";
const generate = [];
for (const [name, script, opts] of GENERATE) {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "recap-golden-")));
  const cwd = join(tmp, "proj");
  mkdirSync(cwd);
  const files = { argv: join(tmp, "argv.json"), env: join(tmp, "env.json"), log: join(tmp, "stdin.log") };
  const env = {
    PATH: "/usr/bin:/bin",
    HOME: join(tmp, "home"),
    FAKE_CLAUDE_SCRIPT: JSON.stringify(script),
    FAKE_CLAUDE_ARGV: files.argv,
    FAKE_CLAUDE_ENV: files.env,
    FAKE_CLAUDE_LOG: files.log,
  };
  const ctrl = new AbortController();
  if (opts.preAborted) ctrl.abort();
  const timer = opts.abortAfterMs ? setTimeout(() => ctrl.abort(), opts.abortAfterMs) : null;
  const result = await generateRecap({
    cwd,
    transcriptTail: TAIL,
    ...(opts.model ? { model: opts.model } : {}),
    env,
    signal: ctrl.signal,
  });
  if (timer) clearTimeout(timer);
  const cliEnv = readJson(files.env);
  if (cliEnv) for (const k of Object.keys(cliEnv)) if (k.startsWith("FAKE_CLAUDE_") || k.startsWith("__CF")) delete cliEnv[k];
  let stdin = null;
  try {
    const ids = new Map();
    stdin = readFileSync(files.log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .map((m) => {
        if (typeof m.request_id === "string") {
          if (!ids.has(m.request_id)) ids.set(m.request_id, `$ID${ids.size}`);
          return { ...m, request_id: ids.get(m.request_id) };
        }
        if (m.type === "control_response" && typeof m.response?.request_id === "string") {
          return { ...m, response: { ...m.response, request_id: "$CLI_ID" } };
        }
        return m;
      });
  } catch {
    stdin = null;
  }
  const outcome = result.ok
    ? { ok: true, ...rustable(result.text) }
    : { ok: false, reason: result.reason, ...(result.message !== undefined ? { message: result.message } : {}) };
  generate.push(
    norm(
      { name, script, opts, outcome, argv: readJson(files.argv), env: cliEnv, stdin },
      tmp,
    ),
  );
  rmSync(tmp, { recursive: true, force: true });
}
rmSync(shimDir, { recursive: true, force: true });

process.stdout.write(
  JSON.stringify({
    sdkVersion,
    instruction: RECAP_INSTRUCTION,
    dedupeWindowMs: RECAP_DEDUPE_WINDOW_MS,
    maxChars: RECAP_MAX_CHARS,
    tail: TAIL,
    tails,
    caps,
    generate,
  }),
);
