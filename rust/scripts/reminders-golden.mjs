#!/usr/bin/env node
// Golden fixture for the session reminders (S21), recorded from the TS sources:
//
//   node rust/scripts/reminders-golden.mjs   (node@22: session.ts needs
//                                             better-sqlite3, which bun can't
//                                             load)
//
// Re-runs itself under `--experimental-transform-types` with HOME and
// CLAUDE_CONFIG_DIR in a temp root and a resolve hook for the `@/` and
// extensionless imports, twice (two temp roots); both recordings must agree
// byte for byte. Records:
//
// - `wrap`: `wrapReminder(body)`.
// - `ultrathink`: `ultrathinkReminderBody(text)` (null when it doesn't match).
// - `dates`: `localDateKey(d)` and `dateChangeReminderBody(prev, d)` for `d`
//   the local noon of `date` (`[year, month, day]`), against three previous
//   keys.
// - `linter`: `linterModifiedReminderBody(paths)`.
// - `constants`: the fixed bodies (`midturnInjectReminderBody`,
//   `autoModeExitReminderBody`, `verifyPlanReminderBody`).
// - `plans`: `planModeReentryReminderBody(prior)`.
// - `queues`: a scripted run of `queueReminder` / `takePendingReminders` /
//   `pendingReminderCount` and their mid-turn twins on two hosts that share
//   an id; each op's result.
// - `scenarios`: a real `Session` (`new Session({cwd})` + `start()`) whose
//   SDK `query` is stubbed by the resolve hook: the stub keeps the options
//   (so the real `PreToolUse` / `PostToolUse` hooks and `canUseTool` can be
//   called) and yields the messages the scenario feeds it to the real
//   `consume()`. Ops, in order:
//     ["send", text, opts?]  `sendInput(text, undefined, opts)`; records the
//                            queued message's content
//     ["emit", message]      a CLI message (session_id and uuid filled in)
//     ["end"]                the turn's success `result`
//     ["post", input]        the PostToolUse hook; records its return
//     ["pre", input]         the PreToolUse hook; records its return
//     ["plan", input, decision]  `canUseTool("ExitPlanMode", input)`, then
//                            `resolvePlan` with the decision
//     ["write", path, text | bytes], ["rm", path], ["mkdir", path],
//     ["chmod", path, mode]  file changes
//     ["state", patch]       `mergeSessionState(cwd, id, patch)`
//     ["mode", mode]         `await setPermissionMode(mode)`
//   Each scenario runs in its own cwd, written `$ROOT` in the ops and the
//   recording. Also recorded: every `cwd_changed` broadcast, and what each
//   plan prompt answered (`planReplies`).
//
// Written to rust/crates/claudius-core/tests/fixtures/reminders_golden.json
// and replayed by crates/claudius-core/tests/reminders_golden.rs.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "crates/claudius-core/tests/fixtures/reminders_golden.json");
const SDK = "@anthropic-ai/claude-agent-sdk";

// ------------------------------- recording -------------------------------

if (!process.env.REMINDERS_GOLDEN_CHILD) {
  const runs = [0, 1].map(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "reminders-golden-")));
    try {
      const home = join(root, "home");
      mkdirSync(home);
      const r = spawnSync(
        process.execPath,
        ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url)],
        {
          // db.ts reads its migrations from `process.cwd()`.
          cwd: repo,
          encoding: "utf8",
          maxBuffer: 1 << 26,
          env: {
            PATH: process.env.PATH,
            HOME: home,
            CLAUDE_CONFIG_DIR: join(root, "config"),
            REMINDERS_GOLDEN_CHILD: root,
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
  const ops = fixture.scenarios.reduce((n, s) => n + s.ops.length, 0);
  console.log(
    `wrote ${out.slice(repo.length + 1)}: ${fixture.ultrathink.length} ultrathink texts, ${fixture.dates.length} dates, ` +
      `${fixture.linter.length} path lists, ${fixture.queues.length} queue ops, ` +
      `${fixture.scenarios.length} scenarios (${ops} ops) (stable)`,
  );
  process.exit(0);
}

// --------------------------------- child ---------------------------------

const ROOT_DIR = process.env.REMINDERS_GOLDEN_CHILD;

// session.ts's SDK import gets a module that re-exports the SDK with
// `query` swapped for `globalThis.__remindersQuery`.
const hook = `
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
const ROOT = ${JSON.stringify(pathToFileURL(repo + "/").href)};
export async function resolve(spec, ctx, next) {
  if (spec === ${JSON.stringify(SDK)} && ctx.parentURL?.endsWith("/lib/server/session.ts")) {
    const real = (await next(spec, ctx)).url;
    const src =
      "export * from " + JSON.stringify(real) + ";\\n" +
      "export function query(args) { return globalThis.__remindersQuery(args); }\\n";
    return { url: "data:text/javascript," + encodeURIComponent(src), shortCircuit: true };
  }
  const s = spec.startsWith("@/") ? new URL(spec.slice(2), ROOT).href : spec;
  if ((s.startsWith(".") || s.startsWith("file:")) && ctx.parentURL?.startsWith("file:")) {
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

/** The stubbed `query()`: an async iterator the scenario feeds, plus the options. */
let lastQuery = null;
globalThis.__remindersQuery = (args) => {
  const queued = [];
  const waiting = [];
  const q = {
    options: args.options,
    feed(m) {
      if (waiting.length) waiting.shift()({ value: m, done: false });
      else queued.push(m);
    },
    [Symbol.asyncIterator]() {
      return this;
    },
    next() {
      if (queued.length) return Promise.resolve({ value: queued.shift(), done: false });
      return new Promise((r) => waiting.push(r));
    },
    return() {
      return Promise.resolve({ value: undefined, done: true });
    },
  };
  lastQuery = q;
  // Any other control call fails, as an unavailable one would.
  return new Proxy(q, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === "then") return undefined;
      return () => Promise.reject(new Error(`stubbed query: ${String(k)}`));
    },
  });
};

const session = await import(join(repo, "lib/server/session.ts"));
const reminders = await import(join(repo, "lib/server/system-reminders.ts"));
const { mergeSessionState } = await import(join(repo, "lib/server/sessions-db.ts"));
const { Session } = session;

const J = (v) => JSON.stringify(v);
const settle = () => new Promise((r) => setTimeout(r, 40));

// --------------------------------- bodies ---------------------------------

const wrap = ["", "x", "a\nb", "<system-reminder>nested</system-reminder>", "trailing\n", "\u00e9 \u2028 \ud83d\ude00"].map(
  (body) => ({ body, xml: reminders.wrapReminder(body) }),
);

const ULTRATHINK = [
  "ultrathink",
  "ULTRATHINK",
  "UltraThink about it",
  "Ultrathink.",
  "please ultrathink this",
  "(ultrathink)",
  "ultrathink-mode",
  "say ultrathink\nthen stop",
  "ultrathinking",
  "preultrathink",
  "ultra think",
  "ultrathin",
  "_ultrathink",
  "ultrathink_",
  "1ultrathink",
  "ultrathink2",
  "$ultrathink$",
  "\u00e9ultrathink",
  "ultrathink\u00e9",
  "ultrathink\u0301",
  "\u0301ultrathink",
  "ultrathink\u0663",
  "\u03bbultrathink\u03bb",
  "ultrathin\u212a",
  "ultrath\u0131nk",
  "ultrath\u0130nk",
  "\uff55ltrathink",
  "",
];
const ultrathink = ULTRATHINK.map((text) => ({ text, body: session.ultrathinkReminderBody(text) }));

// [year, month, day]: years past 9999, below 1000, 0 and negative too.
const DATES = [
  [2026, 10, 27],
  [2026, 1, 1],
  [2026, 12, 31],
  [2024, 2, 29],
  [2000, 3, 5],
  [1999, 12, 31],
  [1970, 1, 1],
  [2100, 7, 4],
  [999, 6, 15],
  [1000, 1, 1],
  [9999, 12, 31],
  [10000, 1, 1],
  [42, 4, 2],
  [0, 3, 1],
  [-1, 6, 15],
  [-2000, 2, 29],
];
const dates = [];
for (const date of DATES) {
  const [y, m, d] = date;
  const at = new Date(y, m - 1, d, 12);
  at.setFullYear(y); // two-digit years would land in the 1900s
  const key = session.localDateKey(at);
  for (const prev of [key, "2026-10-26", ""]) {
    dates.push({ date, key, prev, body: session.dateChangeReminderBody(prev, at) });
  }
}

const LINTER = [
  [],
  ["/a.txt"],
  ["/a.txt", "/b.txt"],
  ["/a.txt", "/a.txt"],
  [""],
  ["/p with space/\u00e9t\u00e9.txt", "rel/x.ts", "C:\\win\\path.ts"],
  ["a\nb", "tab\there"],
];
const linter = LINTER.map((paths) => ({ paths, body: session.linterModifiedReminderBody(paths) }));

const constants = {
  midturnInject: session.midturnInjectReminderBody(),
  autoModeExit: session.autoModeExitReminderBody(),
  verifyPlan: session.verifyPlanReminderBody(),
};

const plans = ["1. Read\n2. Fix", "x", "", "\u00e9 \ud83d\ude00", "  padded  "].map((prior) => ({
  prior,
  body: session.planModeReentryReminderBody(prior),
}));

// --------------------------------- queues ---------------------------------

const QUEUE_OPS = [
  ["take", "a"],
  ["takeMid", "a"],
  ["count", "a"],
  ["countMid", "a"],
  ["q", "a", "date-change", "one"],
  ["q", "a", "date-change", "one"],
  ["m", "a", "todos-stale-midturn", "mid one"],
  ["q", "b", "verify-plan", "b one"],
  ["count", "a"],
  ["countMid", "a"],
  ["count", "b"],
  ["countMid", "b"],
  ["takeMid", "b"],
  ["take", "a"],
  ["take", "a"],
  ["count", "a"],
  ["takeMid", "a"],
  ["takeMid", "a"],
  ["q", "a", "ultrathink-prose", ""],
  ["q", "a", "mcp-delta", "multi\nline"],
  ["m", "a", "truncated-read", "mid two"],
  ["m", "a", "mcp-delta-midturn", "mid three"],
  ["q", "a", "linter-modified-file", "\u00e9"],
  ["take", "b"],
  ["take", "b"],
  ["takeMid", "a"],
  ["take", "a"],
  ["countMid", "a"],
];
const hosts = { a: { id: "shared" }, b: { id: "shared" } };
const queues = QUEUE_OPS.map((op) => {
  const host = hosts[op[1]];
  let result = null;
  switch (op[0]) {
    case "q":
      reminders.queueReminder(host, op[2], op[3]);
      break;
    case "m":
      reminders.queueMidTurnReminder(host, op[2], op[3]);
      break;
    case "take":
      result = reminders.takePendingReminders(host);
      break;
    case "takeMid":
      result = reminders.takeMidTurnReminders(host);
      break;
    case "count":
      result = reminders.pendingReminderCount(host);
      break;
    case "countMid":
      result = reminders.midTurnReminderCount(host);
      break;
  }
  return { op, result };
});

// -------------------------------- scenarios --------------------------------

const post = (tool_name, tool_input) => [
  "post",
  { session_id: "s", hook_event_name: "PostToolUse", tool_name, tool_input, tool_response: {}, tool_use_id: "toolu_x" },
];
const postRaw = (input) => ["post", { session_id: "s", hook_event_name: "PostToolUse", ...input }];
const pre = (tool_name, tool_input) => [
  "pre",
  { session_id: "s", hook_event_name: "PreToolUse", tool_name, tool_input, tool_use_id: "toolu_y" },
];
const edit = (p) => post("Edit", { file_path: p, old_string: "x", new_string: "y" });
const write = (p, text) => ["write", p, text];
const R = (rel) => `$ROOT/${rel}`;
const assistant = (content) => [
  "emit",
  {
    type: "assistant",
    message: { id: "msg_1", role: "assistant", model: "fake", content, stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 } },
    parent_tool_use_id: null,
  },
];
const toolUse = (id, name, input) => ({ type: "tool_use", id, name, input });

const todoList = (n) =>
  Array.from({ length: n }, (_, i) => ({ id: String(i + 1), content: `step ${i + 1}`, status: "pending", activeForm: "Stepping" }));

// The TodoWrite turn, then silent turns that complete one item every third
// turn (progress, so the no-progress clear never takes the list) without a
// TodoWrite (so the stale-TodoWrite count climbs to 15).
function todosScenario() {
  const ops = [write(R("a.txt"), "a1"), ["send", "[[1]] plan"], assistant([toolUse("toolu_w", "TodoWrite", { todos: todoList(7) })]), ["end"]];
  let done = 0;
  for (let i = 2; i <= 15; i++) {
    ops.push(["send", `[[${i}]] go`]);
    if (i === 3) {
      // Twelve actions without touching the list: the mid-turn nudge, once.
      ops.push(assistant(Array.from({ length: 12 }, (_, k) => toolUse(`toolu_b${k}`, "Bash", { command: "ls" }))));
      ops.push(pre("Bash", { command: "ls" }));
      ops.push(pre("Bash", { command: "ls" }));
    }
    if (i % 3 === 0) {
      done += 1;
      ops.push(assistant([toolUse(`toolu_u${i}`, "TaskUpdate", { taskId: String(done), status: "completed" })]));
    }
    if (i === 15) ops.push(edit(R("a.txt")));
    ops.push(["end"]);
  }
  ops.push(write(R("a.txt"), "a2"));
  ops.push(["send", "[[16]] ultrathink and go"]);
  ops.push(["end"]);
  return ops;
}

const SCENARIOS = [
  [
    "a rewritten file rides the next prompt, once",
    [
      write(R("a.txt"), "one\n"),
      ["send", "[[1]] edit it"],
      edit(R("a.txt")),
      ["end"],
      write(R("a.txt"), "one (formatted)\n"),
      ["send", "[[2]] next"],
      ["end"],
      write(R("a.txt"), "changed again\n"),
      ["send", "[[3]] again"],
      ["end"],
    ],
  ],
  [
    "the same bytes are no change",
    [write(R("a.txt"), "same"), ["send", "[[1]] go"], post("Write", { file_path: R("a.txt"), content: "same" }), ["end"], write(R("a.txt"), "same"), ["send", "[[2]] go"], ["end"]],
  ],
  [
    "a deleted file is skipped",
    [
      write(R("a.txt"), "a"),
      write(R("b.txt"), "b"),
      ["send", "[[1]] go"],
      edit(R("a.txt")),
      edit(R("b.txt")),
      ["end"],
      ["rm", R("a.txt")],
      write(R("b.txt"), "b2"),
      ["send", "[[2]] go"],
      ["end"],
    ],
  ],
  [
    "paths keep their first-write order and the last write's hash",
    [
      write(R("a.txt"), "a"),
      write(R("b.txt"), "b"),
      write(R("c.ipynb"), "{}"),
      write(R("d.txt"), "d1"),
      ["send", "[[1]] go"],
      edit(R("a.txt")),
      post("MultiEdit", { file_path: R("b.txt"), edits: [] }),
      post("NotebookEdit", { notebook_path: R("c.ipynb"), new_source: "x" }),
      edit(R("d.txt")),
      write(R("a.txt"), "a again"),
      edit(R("a.txt")),
      write(R("d.txt"), "d2"),
      edit(R("d.txt")),
      ["end"],
      write(R("c.ipynb"), '{"cells": []}'),
      write(R("b.txt"), "b2"),
      write(R("a.txt"), "a2"),
      ["send", "[[2]] go"],
      ["end"],
    ],
  ],
  [
    "a failed read keeps the earlier hash",
    [
      write(R("a.txt"), "v1"),
      write(R("b.txt"), "v1"),
      ["send", "[[1]] go"],
      edit(R("a.txt")),
      edit(R("b.txt")),
      ["rm", R("a.txt")],
      ["rm", R("b.txt")],
      edit(R("a.txt")),
      edit(R("b.txt")),
      ["end"],
      write(R("a.txt"), "v1"),
      write(R("b.txt"), "v2"),
      ["send", "[[2]] go"],
      ["end"],
    ],
  ],
  [
    "which hook inputs are snapshotted",
    [
      ...Array.from({ length: 12 }, (_, i) => write(R(`f${i + 1}.txt`), `x${i + 1}`)),
      ["mkdir", R("dir")],
      ["mkdir", R("sp ace")],
      write(R("sp ace/\u00e9t\u00e9 \u201cq\u201d.txt"), "u"),
      write(R("empty.txt"), ""),
      write(R("bin.dat"), [0, 255, 254, 10]),
      write(R("locked.txt"), "l"),
      ["send", "[[1]] go"],
      post("Read", { file_path: R("f1.txt") }),
      post("edit", { file_path: R("f2.txt") }),
      postRaw({ tool_input: { file_path: R("f3.txt") } }),
      postRaw({ tool_name: 5, tool_input: { file_path: R("f3.txt") } }),
      post("Write", { file_path: 7, notebook_path: R("f4.txt") }),
      post("NotebookEdit", { file_path: null, notebook_path: R("f5.txt") }),
      post("Edit", { file_path: "", notebook_path: R("f6.txt") }),
      post("MultiEdit", { file_path: R("f7.txt"), notebook_path: R("f8.txt") }),
      post("Edit", null),
      post("Edit", R("f9.txt")),
      postRaw({ tool_name: "Edit" }),
      post("Write", { file_path: R("dir") }),
      post("Edit", { file_path: R("missing.txt") }),
      ["chmod", R("locked.txt"), 0],
      post("Edit", { file_path: R("locked.txt") }),
      ["chmod", R("locked.txt"), 0o644],
      post("Edit", { notebook_path: R("f10.txt") }),
      post("Write", { file_path: [R("f11.txt")] }),
      post("Write", { file_path: R("sp ace/\u00e9t\u00e9 \u201cq\u201d.txt") }),
      post("Write", { file_path: R("empty.txt") }),
      post("Write", { file_path: R("bin.dat") }),
      post("Edit", { file_path: R("f12.txt"), replace_all: true }),
      post("Edit", { file_path: R("dir/../f1.txt") }),
      ["end"],
      ...Array.from({ length: 12 }, (_, i) => write(R(`f${i + 1}.txt`), `y${i + 1}`)),
      write(R("sp ace/\u00e9t\u00e9 \u201cq\u201d.txt"), "u2"),
      write(R("empty.txt"), "now"),
      write(R("bin.dat"), [1, 2, 3]),
      write(R("locked.txt"), "l2"),
      ["send", "[[2]] go"],
      ["end"],
    ],
  ],
  [
    "an unreadable file is skipped at the flush",
    [
      write(R("a.txt"), "a"),
      write(R("b.txt"), "b"),
      ["send", "[[1]] go"],
      edit(R("a.txt")),
      edit(R("b.txt")),
      ["end"],
      write(R("a.txt"), "a2"),
      write(R("b.txt"), "b2"),
      ["chmod", R("a.txt"), 0],
      ["send", "[[2]] go"],
      ["end"],
      ["chmod", R("a.txt"), 0o644],
    ],
  ],
  [
    "a slash command doesn't flush",
    [
      write(R("a.txt"), "a"),
      ["send", "[[1]] go"],
      edit(R("a.txt")),
      ["end"],
      write(R("a.txt"), "a2"),
      ["send", "/compact [[2]]", { slash: true }],
      ["end"],
      ["send", "[[3]] go"],
      ["end"],
    ],
  ],
  [
    "mid-turn: after ultrathink and the mid-turn nudge",
    [
      write(R("a.txt"), "a"),
      ["send", "[[1]] go"],
      edit(R("a.txt")),
      write(R("a.txt"), "a2"),
      ["send", "[[2]] ultrathink please"],
      ["end"],
    ],
  ],
  [
    "queued earlier: plan re-entry and auto-mode exit, then the prompt's own",
    [
      ["state", { priorPlan: "\ufeff  1. Read the code\n2. Fix it \u0085" }],
      ["mode", "plan"],
      ["mode", "default"],
      ["mode", "plan"],
      write(R("a.txt"), "a"),
      ["send", "[[1]] go"],
      edit(R("a.txt")),
      ["end"],
      write(R("a.txt"), "a2"),
      ["mode", "auto"],
      ["mode", "acceptEdits"],
      ["mode", "plan"],
      ["send", "[[2]] ultrathink"],
      ["end"],
    ],
  ],
  [
    "an accepted plan: the verify nudge, then its text on re-entry",
    [
      ["mode", "plan"],
      ["send", "[[1]] plan it"],
      ["plan", { plan: " the draft " }, { kind: "accept", editedPlan: "\ufeff the edit \u0085" }],
      ["end"],
      ["send", "[[2]] go"],
      ["end"],
      ["mode", "plan"],
      ["send", "[[3]] again"],
      ["plan", { plan: "\ufeffsecond draft\u0085" }, { kind: "accept", editedPlan: " \u00a0 " }],
      ["end"],
      ["mode", "default"],
      ["mode", "plan"],
      ["send", "[[4]] once more"],
      ["plan", { plan: " rejected draft " }, { kind: "reject" }],
      ["end"],
      ["mode", "default"],
      ["mode", "plan"],
      ["send", "[[5]] then"],
      ["end"],
      // The same plan once trimmed the JS way: not an edit.
      ["send", "[[6]] same"],
      ["plan", { plan: "\ufeffsame\u0085" }, { kind: "accept", editedPlan: "same\u0085" }],
      ["end"],
      ["mode", "plan"],
      ["send", "[[7]] last"],
      ["end"],
    ],
  ],
  [
    "PreToolUse: worktree targets",
    [
      ["send", "[[1]] go"],
      pre("Read", { file_path: R(".claude/worktrees/w0/a.ts") }),
      pre("Edit", { file_path: R(".claude/worktrees/w1/src/a.ts") }),
      pre("Edit", { file_path: R(".claude/worktrees/w1/b.ts") }),
      pre("NotebookEdit", { file_path: null, notebook_path: R(".claude/worktrees/w2/n.ipynb") }),
      pre("Write", { file_path: 5, notebook_path: R(".claude/worktrees/w3/x") }),
      pre("Write", { file_path: R("a\rb/.claude/worktrees/w4/x") }),
      pre("Write", { file_path: R("a\u2028b/.claude/worktrees/w5/x") }),
      pre("MultiEdit", { file_path: R(".claude/worktrees/w6") }),
      pre("Write", { file_path: R(".claude/worktrees/w7\n/x") }),
      pre("Edit", { notebook_path: R(".claude/worktrees/w8/y") }),
      ["end"],
    ],
  ],
  ["todos: the turn-end list, the mid-turn nudge and the stale-TodoWrite nudge, around the linter's", todosScenario()],
];

function deepSub(v, from, to) {
  if (typeof v === "string") return v.split(from).join(to);
  if (Array.isArray(v)) return v.map((x) => deepSub(x, from, to));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deepSub(x, from, to)]));
  return v;
}

async function runScenario([name, ops], n) {
  const cwd = join(ROOT_DIR, `scenario-${n}`);
  mkdirSync(cwd);
  const sub = (v) => deepSub(v, "$ROOT", cwd);
  const unsub = (v) => deepSub(v, cwd, "$ROOT");
  const s = new Session({ cwd });
  const sent = [];
  const hooks = [];
  const cwds = [];
  const plans = [];
  const planReplies = [];
  s.inputQueue.push = (m) => sent.push(unsub(m.message.content));
  const realBroadcast = s.broadcast.bind(s);
  s.broadcast = (ev) => {
    if (ev.type === "cwd_changed") cwds.push(unsub(ev.cwd));
    if (ev.type === "plan_approval_request") plans.push(ev.requestId);
    realBroadcast(ev);
  };
  await s.start();
  const q = lastQuery;
  const call = (event, input) =>
    q.options.hooks[event][0].hooks[0](sub(input), input.tool_use_id, { signal: new AbortController().signal });
  for (const op of ops) {
    switch (op[0]) {
      case "send":
        s.sendInput(sub(op[1]), undefined, op[2]);
        break;
      case "emit":
        q.feed({ ...sub(op[1]), session_id: s.id, uuid: randomUUID() });
        await settle();
        break;
      case "end":
        q.feed({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "",
          duration_ms: 1,
          duration_api_ms: 1,
          num_turns: 1,
          total_cost_usd: 0,
          usage: { input_tokens: 1, output_tokens: 1 },
          session_id: s.id,
          uuid: randomUUID(),
        });
        await settle();
        break;
      case "post":
        hooks.push(unsub(await call("PostToolUse", op[1])));
        break;
      case "pre":
        hooks.push(unsub(await call("PreToolUse", op[1])));
        break;
      case "plan": {
        const asked = q.options.canUseTool("ExitPlanMode", sub(op[1]), {
          signal: new AbortController().signal,
          toolUseID: "toolu_plan",
          suggestions: [],
        });
        const id = plans.at(-1);
        await s.resolvePlan(id, sub(op[2]));
        planReplies.push(unsub(await asked));
        await settle();
        break;
      }
      case "write":
        writeFileSync(sub(op[1]), typeof op[2] === "string" ? op[2] : Buffer.from(op[2]));
        break;
      case "rm":
        rmSync(sub(op[1]), { recursive: true, force: true });
        break;
      case "mkdir":
        mkdirSync(sub(op[1]), { recursive: true });
        break;
      case "chmod":
        chmodSync(sub(op[1]), op[2]);
        break;
      case "state":
        await mergeSessionState(cwd, s.id, sub(op[1]));
        break;
      case "mode":
        await s.setPermissionMode(op[1]);
        await settle();
        break;
      default:
        throw new Error(`unknown op ${J(op)}`);
    }
  }
  return { name, ops, sent, hooks, cwds, planReplies };
}

const scenarios = [];
for (const [i, sc] of SCENARIOS.entries()) scenarios.push(await runScenario(sc, i));

// A file, not stdout: `process.exit` would cut a piped stdout short.
writeFileSync(
  join(ROOT_DIR, "out.json"),
  J({ wrap, ultrathink, dates, linter, constants, plans, queues, scenarios }),
);
process.exit(0);
