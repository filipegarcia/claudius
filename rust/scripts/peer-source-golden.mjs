#!/usr/bin/env node
// Golden fixture for the peer-message sender lookup (G11):
// `lib/server/peer-source.ts` (`resolvePeerSource`), `lib/server/jsonl-lines.ts`
// and `GET /api/sessions/peer-source` (app/api/sessions/peer-source/route.ts),
// recorded from the real TS:
//
//   node rust/scripts/peer-source-golden.mjs     (node@22)
//
// Re-runs itself under `--experimental-transform-types` with the repo as its
// cwd, HOME and CLAUDE_CONFIG_DIR at a temp dir (CLAUDIUS_ACCOUNTS_DIR unset,
// so the profiles live under $HOME/.claude/.claudius/profiles) and a resolve
// hook for the `@/` imports. Three parts:
// * `lines`: byte strings written to a file and read back through the real
//   `jsonlLines(createReadStream(file, { encoding: "utf8" }))`: the lines it
//   yields (`parts`: UTF-8 text, `{hex}` or `{rep, n}`). Invalid UTF-8,
//   CR / CRLF / U+2028, and characters cut by node's 64 KiB read chunks.
// * `core`: `resolvePeerSource(q, roots)` called directly on copies of
//   peer-source.ts whose bound constants are replaced (`limits`; `defaults`
//   holds the real ones, and each replaced line must exist once), each copy
//   with its own cache, over a world under its own root (`claude/`,
//   `profiles/`). `Date.now` is a virtual clock during each call: `now.set`
//   is its value before the call, and each read adds `now.tick` first;
//   `nowCalls` counts the reads. `got` is `JSON.stringify(result)` or null.
//   The query's `snippet16` is its UTF-16 units.
// * `route`: one world under $HOME and the route's GET, in order (one
//   module cache throughout): `ops` change the disk (`dir`, `file`, `link`,
//   `rm`, `chmod`; a file's mtime is set and recorded as `mtimeNs`), `get`
//   answers status, content type and body text, or `threw` (`name:
//   message`; Next's empty 500), and `fill` sends `n` socket-only misses.
//   `sessionManager.get` is stubbed to know one session (`hosted`); the Rust
//   replay starts that session on the fake CLI instead. `needsPerms` marks
//   steps whose answer relies on a mode-000 file or folder being refused.
//
// `@LIVE@` in a path, a text part or a query stands for a running process's
// pid (the recorder's own here). Every other pid is one no process can have
// (above macOS's 99 999 and Linux's 4 194 304), or 1, or 0.
//
// Written to rust/crates/claudius-core/tests/fixtures/peer_source_golden.json
// (or $PS_GOLDEN_OUT); replayed by crates/claudius-core/tests/peer_source_golden.rs
// (`lines`, `core`) and crates/claudius-server/tests/peer_source.rs (`route`,
// on the real binary).
import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = process.env.PS_GOLDEN_OUT || join(rustDir, "crates/claudius-core/tests/fixtures/peer_source_golden.json");

/** chmod u+rwx every directory (and file) under `dir`, so it can be removed. */
function openUp(dir) {
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    return;
  }
  if (st.isSymbolicLink()) return;
  try {
    chmodSync(dir, st.isDirectory() ? 0o755 : 0o644);
  } catch {
    // best effort
  }
  if (!st.isDirectory()) return;
  for (const n of readdirSync(dir)) openUp(join(dir, n));
}

if (!process.env.PS_GOLDEN_CHILD) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "peer-source-golden-")));
  try {
    mkdirSync(join(root, "home"));
    mkdirSync(join(root, "config"));
    const r = spawnSync(
      process.execPath,
      ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url)],
      {
        cwd: repo,
        stdio: "inherit",
        env: {
          PATH: process.env.PATH,
          HOME: join(root, "home"),
          CLAUDE_CONFIG_DIR: join(root, "config"),
          PS_GOLDEN_ROOT: root,
          PS_GOLDEN_CHILD: "1",
          PS_GOLDEN_OUT: out,
        },
      },
    );
    process.exit(r.status ?? 1);
  } finally {
    openUp(root);
    rmSync(root, { recursive: true, force: true });
  }
}

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

const ROOT = process.env.PS_GOLDEN_ROOT;
const HOME = process.env.HOME;
const LIVE = String(process.pid);
const sub = (s) => s.replaceAll("@LIVE@", LIVE);

/** A part list as bytes: UTF-8 text (with `@LIVE@`), `{hex}` or `{rep, n}`. */
function bytesOf(parts) {
  return Buffer.concat(
    parts.map((p) => {
      if (typeof p === "string") return Buffer.from(sub(p));
      if (p.hex !== undefined) return Buffer.from(p.hex, "hex");
      return Buffer.from(p.rep.repeat(p.n));
    }),
  );
}

/** Apply one disk op under `base`; a set mtime is recorded as `mtimeNs`. */
function apply(base, op) {
  const p = join(base, sub(op.path));
  const setTime = () => {
    if (op.mtimeMs === undefined) return;
    // node reads a negative number as "now"; a Date it doesn't.
    const t = op.mtimeMs < 0 ? new Date(op.mtimeMs) : op.mtimeMs / 1000;
    utimesSync(p, t, t);
    op.mtimeNs = String(statSync(p, { bigint: true }).mtimeNs);
    delete op.mtimeMs;
  };
  switch (op.op) {
    case "dir":
      mkdirSync(p, { recursive: true });
      setTime();
      break;
    case "file":
      if (op.path.endsWith(".jsonl") && op.mtimeMs === undefined) throw new Error(`${op.path}: no mtime`);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, bytesOf(op.parts));
      setTime();
      break;
    case "link":
      mkdirSync(dirname(p), { recursive: true });
      symlinkSync(op.target, p);
      break;
    case "rm":
      rmSync(p, { recursive: true, force: true });
      break;
    case "chmod":
      chmodSync(p, op.mode);
      break;
    default:
      throw new Error(`op ${op.op}`);
  }
}

const units = (s) => Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));
const enc = encodeURIComponent;

const AT = 1_800_000_000_000;
const HOSTED = "00000000-0000-4000-8000-0000000000aa";
const M = (n) => `${String(n).padStart(8, "0")}-1111-4111-8111-${String(n).padStart(12, "0")}`;
const line = (o) => JSON.stringify(o) + "\n";
/** The sender's `SendMessage` call. */
const sendCall = (sessionId, body, extra = {}) =>
  line({
    type: "assistant",
    sessionId,
    ...extra,
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "sending" },
        { type: "tool_use", id: "toolu_1", name: "SendMessage", input: { to: "peer", message: body } },
      ],
    },
  });
/** The sender's `SendMessage` result, carrying the message id. */
const sendResult = (sessionId, msgId, extra = {}) =>
  line({
    type: "user",
    sessionId,
    ...extra,
    toolUseResult: { success: true, msg_id: msgId },
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "sent" }] },
  });
const file = (path, parts, mtimeMs) => ({ op: "file", path, parts: Array.isArray(parts) ? parts : [parts], mtimeMs });

// ---- lines -----------------------------------------------------------------------

const { jsonlLines } = await import(join(repo, "lib/server/jsonl-lines.ts"));
const K64 = 64 * 1024;
const lineCases = [
  [""],
  ["\n"],
  ["a"],
  ["a\n"],
  ["a\r\n"],
  ["a\rb\n"],
  ["a\r\r\n"],
  ["\r"],
  ["\r\n\r\n"],
  ["x\n\n\ny"],
  ["a\u2028b\nc\u2029"],
  ["\u00e9\u20ac\ud83d\ude00\n"],
  [{ hex: "efbbbf" }, "{\"bom\":1}\n"],
  [{ hex: "fffe" }, "\n"],
  ["a", { hex: "c3" }],
  [{ hex: "e282" }, "\n", { hex: "e282" }, "A\n"],
  [{ hex: "eda080" }, "\n"],
  [{ hex: "c080f5808080" }, "\n"],
  // Cut by the 64 KiB chunks: a valid pair 2|2, a euro 1|2, invalid tails.
  [{ rep: "a", n: K64 - 2 }, { hex: "f09f9880" }, "\nz\n"],
  [{ rep: "a", n: K64 - 1 }, { hex: "e282ac" }, "\n"],
  [{ rep: "a", n: K64 - 2 }, { hex: "f09f" }, "A\n"],
  [{ rep: "a", n: K64 - 1 }, { hex: "eda080" }, "\n"],
  [{ rep: "a", n: K64 - 1 }, { hex: "c080" }, "\n"],
  [{ rep: "a", n: K64 - 1 }, { hex: "f5808080" }, "\n"],
  [{ rep: "a", n: K64 - 3 }, { hex: "f09f98" }],
  [{ rep: "a", n: K64 - 1 }, "\r\nb"],
  [{ rep: "a", n: K64 }, "\r\n", { rep: "b", n: K64 - 1 }, "\r"],
  [{ rep: "q", n: 3 * K64 + 17 }, "\nend"],
  [{ rep: "\u20ac", n: 50_000 }, "\n", { rep: "\ud83d\ude00", n: 40_000 }],
];
/** `s` as parts: runs of 32+ equal code points as `{rep, n}`, the rest as text. */
function rle(s) {
  const cps = Array.from(s);
  const parts = [];
  let text = "";
  for (let i = 0; i < cps.length; ) {
    let j = i;
    while (j < cps.length && cps[j] === cps[i]) j++;
    if (j - i >= 32) {
      if (text) parts.push(text);
      text = "";
      parts.push({ rep: cps[i], n: j - i });
    } else {
      text += cps.slice(i, j).join("");
    }
    i = j;
  }
  if (text) parts.push(text);
  return parts;
}
const lines = [];
for (const [i, parts] of lineCases.entries()) {
  const p = join(ROOT, `lines-${i}.jsonl`);
  writeFileSync(p, bytesOf(parts));
  const got = [];
  for await (const l of jsonlLines(createReadStream(p, { encoding: "utf8" }))) got.push(rle(l));
  lines.push({ parts, got });
}

// ---- core ------------------------------------------------------------------------

const SRC = readFileSync(join(repo, "lib/server/peer-source.ts"), "utf8");
const CONSTS = {
  SCAN_SLACK_MS: "5 * 60_000",
  SCAN_BYTE_BUDGET: "512 * 1024 * 1024",
  SCAN_TIME_BUDGET_MS: "5_000",
  CACHE_MAX: "500",
  MISS_TTL_MS: "30_000",
};
const defaults = {};
for (const [k, expr] of Object.entries(CONSTS)) {
  const decl = `const ${k} = ${expr};`;
  if (SRC.split(decl).length !== 2) throw new Error(`peer-source.ts: no single \`${decl}\``);
  defaults[k] = Function(`return ${expr}`)();
}
defaults.MIN_SNIPPET = Number(/const MIN_SNIPPET = (\d+);/.exec(SRC)[1]);
defaults.PEER_SNIPPET_MAX = (await import(join(repo, "lib/shared/peer-source.ts"))).PEER_SNIPPET_MAX;
if (!SRC.includes("rec.startedAt > q.at + 5_000")) throw new Error("peer-source.ts: the startedAt slack moved");

let variants = 0;
/** A copy of peer-source.ts with `limits` replaced, as a fresh module. */
async function variant(limits) {
  let s = SRC;
  for (const [k, v] of Object.entries(limits)) s = s.replace(`const ${k} = ${CONSTS[k]};`, `const ${k} = ${v};`);
  for (const dep of ["accounts-store", "jsonl-lines"]) {
    const spec = `from "./${dep}";`;
    if (s.split(spec).length !== 2) throw new Error(`peer-source.ts: no single ${spec}`);
    s = s.replace(spec, `from ${JSON.stringify(pathToFileURL(join(repo, `lib/server/${dep}.ts`)).href)};`);
  }
  const p = join(ROOT, `peer-source-${variants++}.ts`);
  writeFileSync(p, s);
  return import(pathToFileURL(p).href);
}

const realNow = Date.now;
let clock = 0;
let tick = 0;
let nowCalls = 0;

const reg = (o) => [JSON.stringify(o)];
const coreGroups = [];
const A = (s) => ({ from: `uds:/s/${s}` });
const regFor = (s, sessionId) => {
  const pid = 99999000 + s.charCodeAt(0);
  return file(`claude/sessions/${pid}.json`, reg({ pid, sessionId, messagingSocketPath: `/s/${s}` }));
};
const T0 = 1_000_000;
coreGroups.push({
  name: "miss TTL, kept transcript hits, uncached registry hits",
  limits: {},
  steps: [
    { op: "dir", path: "claude/projects/p" },
    { op: "resolve", q: { msgId: M(1) }, now: { set: T0 } },
    file("claude/projects/p/s.jsonl", [sendResult("ttl-sender", M(1))], AT),
    { op: "resolve", q: { msgId: M(1) }, now: { set: T0 + 29_999 } },
    { op: "resolve", q: { msgId: M(1) }, now: { set: T0 + 30_000 } },
    { op: "rm", path: "claude/projects/p/s.jsonl" },
    { op: "resolve", q: { msgId: M(1) }, now: { set: 9e12 } },
    file("claude/sessions/@LIVE@.json", ['{"pid":@LIVE@,"sessionId":"reg-live"}']),
    { op: "resolve", q: { pid: "@LIVE@" }, now: { set: T0 } },
    { op: "rm", path: "claude/sessions/@LIVE@.json" },
    { op: "resolve", q: { pid: "@LIVE@" }, now: { set: T0 + 1 } },
    file("claude/sessions/@LIVE@.json", ['{"pid":@LIVE@,"sessionId":"reg-live"}']),
    { op: "resolve", q: { pid: "@LIVE@" }, now: { set: T0 + 30_000 } },
    { op: "resolve", q: { pid: "@LIVE@" }, now: { set: T0 + 30_001 } },
  ],
});
coreGroups.push({
  name: "eviction order (CACHE_MAX 3)",
  limits: { CACHE_MAX: "3" },
  steps: [
    { op: "resolve", q: A("a"), now: { set: T0 } },
    { op: "resolve", q: A("b"), now: { set: T0 + 10 } },
    { op: "resolve", q: A("c"), now: { set: T0 + 20 } },
    regFor("d", "reg-d"),
    { op: "resolve", q: A("d"), now: { set: T0 + 30 } },
    regFor("a", "reg-a"),
    { op: "resolve", q: A("a"), now: { set: T0 + 40 } },
    { op: "resolve", q: A("b"), now: { set: T0 + 30_010 } },
    { op: "resolve", q: A("e"), now: { set: T0 + 30_011 } },
    regFor("b", "reg-b"),
    regFor("c", "reg-c"),
    { op: "resolve", q: A("f"), now: { set: T0 + 30_012 } },
    { op: "resolve", q: A("b"), now: { set: T0 + 30_013 } },
    { op: "resolve", q: A("c"), now: { set: T0 + 30_014 } },
    { op: "resolve", q: A("e"), now: { set: T0 + 30_015 } },
  ],
});
const tbFiles = [
  { op: "dir", path: "profiles" },
  file("claude/projects/p1/a.jsonl", [line({ sessionId: "a", toolUseResult: { msg_id: "none" } })], AT + 1000),
  file("claude/projects/p1/b.jsonl", [line({ sessionId: "b" })], AT + 2000),
  file("claude/projects/p1/c.jsonl", [sendResult("time-sender", M(2), { cwd: "/t" })], AT + 3000),
];
coreGroups.push({
  name: "time budget",
  limits: {},
  steps: [
    ...tbFiles,
    { op: "resolve", q: { msgId: M(2) }, now: { set: 0, tick: 2000 } },
    { op: "resolve", q: { msgId: M(2), at: AT }, now: { set: 0, tick: 1000 } },
    { op: "resolve", q: { msgId: M(2), from: "x" }, now: { set: 0, tick: 2500 } },
    { op: "resolve", q: { msgId: M(2), from: "y" }, now: { set: 0, tick: 2499 } },
  ],
});
const bbFiles = [
  file("claude/projects/p/a.jsonl", [{ rep: "x", n: 59 }, "\n"], AT + 1000),
  file("claude/projects/p/b.jsonl", [{ rep: "y", n: 40 }, "\n"], AT + 2000),
  file("claude/projects/p/c.jsonl", [sendResult("bytes-sender", M(3))], AT + 3000),
];
for (const budget of ["100", "101"]) {
  coreGroups.push({
    name: `byte budget ${budget}`,
    limits: { SCAN_BYTE_BUDGET: budget },
    steps: [...structuredClone(bbFiles), { op: "resolve", q: { msgId: M(3) }, now: { set: T0 } }],
  });
}
coreGroups.push({
  name: "mtime window and order",
  limits: {},
  steps: [
    file("claude/projects/p/exact.jsonl", [sendResult("slack-exact", M(4))], AT - 300_000),
    file("claude/projects/p/before.jsonl", [sendResult("slack-before", M(5))], AT - 300_001),
    file("claude/projects/p/ancient.jsonl", [sendResult("ancient", M(6))], -1000),
    file("claude/projects/p1/z.jsonl", [sendResult("tie-first-dir", M(7))], AT),
    file("claude/projects/p2/a.jsonl", [sendResult("tie-second-dir", M(7))], AT),
    file("claude/projects/p3/new.jsonl", [sendResult("newer", M(8))], AT + 10_000),
    file("claude/projects/p4/old.jsonl", [sendResult("older", M(8))], AT + 5_000),
    file("claude/projects/p/body.jsonl", [sendCall("body-sender", "a message body long enough")], AT - 299_999),
    { op: "resolve", q: { msgId: M(4), at: AT }, now: { set: T0 } },
    { op: "resolve", q: { msgId: M(5), at: AT }, now: { set: T0 } },
    { op: "resolve", q: { msgId: M(5) }, now: { set: T0 } },
    { op: "resolve", q: { msgId: M(6) }, now: { set: T0 } },
    { op: "resolve", q: { msgId: M(6), at: 100_000 }, now: { set: T0 } },
    { op: "resolve", q: { msgId: M(7) }, now: { set: T0 } },
    { op: "resolve", q: { msgId: M(8) }, now: { set: T0 } },
    { op: "resolve", q: { snippet: "a message body long" }, now: { set: T0 } },
    { op: "resolve", q: { snippet: "a message body long", at: AT }, now: { set: T0 } },
    { op: "resolve", q: { snippet: "  a message body long\ud83d", at: AT }, now: { set: T0 } },
    { op: "resolve", q: { snippet: "\u3000a message body long e", at: AT }, now: { set: T0 } },
    { op: "resolve", q: { pid: 1.5, msgId: M(4), at: AT + 1 }, now: { set: T0 } },
  ],
});

// Gates and prefilters: the early returns (pid 0, no msgId / snippet, a
// non-UUID msgId), the `.jsonl` suffix, `stat` through a symlink (the link
// itself is too old for the window), and the raw-text prefilters before
// the structural match: a mention, a non-SendMessage tool, an escaped tool
// name / msg_id / `cwd` key, and a body match next to an unknown msgId.
const AT2 = 4_000_000_000_000;
coreGroups.push({
  name: "gates and prefilters",
  limits: {},
  steps: [
    file("claude/sessions/0.json", ['{"pid":0,"sessionId":"pid-zero"}']),
    file("claude/projects/g/a-jsonl", [sendResult("no-dot", M(60))], AT),
    file("claude/projects/g/b.JSONL", [sendResult("upper-ext", M(60))], AT),
    file("claude/projects/g/c.jsonl", [line({ sessionId: "not-uuid", toolUseResult: { msg_id: "not-a-uuid" } })], AT),
    file("claude/elsewhere/t.jsonl", [sendResult("via-link", M(61))], AT2),
    { op: "link", path: "claude/projects/g/link.jsonl", target: "../../elsewhere/t.jsonl" },
    file(
      "claude/projects/h/d.jsonl",
      [
        line({ sessionId: "mention", text: `see ${M(62)}`, toolUseResult: { msg_id: "other" } }),
        line({
          sessionId: "bash-tool",
          note: "SendMessage",
          message: { content: [{ type: "tool_use", name: "Bash", input: { message: "odd gate body long enough" } }] },
        }),
        '{"sessionId":"escaped-name","message":{"content":[{"type":"tool_use","name":"Send\\u004dessage","input":{"message":"escaped gate body long enough"}}]}}\n',
        `{"sessionId":"escaped-id","toolUseResult":{"msg_id":"${M(63).replace("-1111", "-\\u0031111")}"}}\n`,
        `{"sessionId":"escaped-cwd","c\\u0077d":"/esc","toolUseResult":{"msg_id":"${M(64)}"}}\n`,
      ],
      AT,
    ),
    file("claude/projects/h/e.jsonl", [sendCall("body-fallback", "fallback gate body long enough")], AT),
    { op: "resolve", q: { pid: 0 }, now: { set: T0 } },
    { op: "resolve", q: { at: AT, from: "x" }, now: { set: T0 } },
    { op: "resolve", q: { msgId: "not-a-uuid", at: AT }, now: { set: T0 } },
    { op: "resolve", q: { msgId: M(60), at: AT }, now: { set: T0 } },
    { op: "resolve", q: { msgId: M(61), at: AT2 }, now: { set: T0 } },
    { op: "resolve", q: { msgId: M(62), at: AT }, now: { set: T0 } },
    { op: "resolve", q: { snippet: "odd gate body long", at: AT }, now: { set: T0 } },
    { op: "resolve", q: { snippet: "escaped gate body long", at: AT }, now: { set: T0 } },
    { op: "resolve", q: { msgId: M(63), at: AT }, now: { set: T0 } },
    { op: "resolve", q: { msgId: M(64), at: AT }, now: { set: T0 } },
    { op: "resolve", q: { msgId: M(65), snippet: "fallback gate body long", at: AT }, now: { set: T0 } },
  ],
});

const core = [];
for (const [gi, g] of coreGroups.entries()) {
  const mod = await variant(g.limits);
  const base = join(ROOT, `core-${gi}`);
  mkdirSync(base);
  const roots = { claudeDir: join(base, "claude"), profilesRoot: join(base, "profiles") };
  for (const step of g.steps) {
    if (step.op !== "resolve") {
      apply(base, step);
      continue;
    }
    const q = {};
    for (const [k, v] of Object.entries(step.q)) q[k] = v === "@LIVE@" ? Number(LIVE) : v;
    clock = step.now.set;
    tick = step.now.tick ?? 0;
    nowCalls = 0;
    Date.now = () => {
      nowCalls++;
      clock += tick;
      return clock;
    };
    let r;
    try {
      r = await mod.resolvePeerSource(q, roots);
    } finally {
      Date.now = realNow;
    }
    if (typeof step.q.snippet === "string") {
      step.q.snippet16 = units(step.q.snippet);
      delete step.q.snippet;
    }
    step.got = r === null ? null : JSON.stringify(r);
    step.nowCalls = nowCalls;
  }
  core.push(g);
}

// ---- route -----------------------------------------------------------------------

const { sessionManager } = await import(join(repo, "lib/server/session-manager.ts"));
const route = await import(join(repo, "app/api/sessions/peer-source/route.ts"));
sessionManager.get = (id) => (id === HOSTED ? {} : undefined);

const S = ".claude/sessions";
const P = ".claude/.claudius/profiles";
const PR = ".claude/projects";
const rec = (name, text) => file(`${S}/${name}`, Array.isArray(text) ? text : [text]);
const big = (n) => ({ rep: "A", n });

const routeSteps = [];
const step = (s) => routeSteps.push(s);
const get = (query, extra = {}) => step({ op: "get", query, ...extra });

const WS_OK = [
  "{\"version\":1,\"workspaces\":[",
  "{\"id\":\"wks_a\",\"name\":\"A\",\"rootPath\":\"/work/proj-a\"},",
  "{\"id\":\"wks_a_pkgs\",\"rootPath\":\"/work/proj-a/packages/\"},",
  "{\"id\":\"wks_b\",\"rootPath\":\"/work/proj-b\"},",
  "{\"id\":\"wks_b_dup\",\"rootPath\":\"/work/proj-b\"},",
  "{\"id\":7,\"rootPath\":\"/elsewhere\"},",
  "{\"id\":{\"n\":1.0,\"k\":[1e2,\"\\u00e9\"]},\"rootPath\":\"/work/proj-c\"},",
  "{\"rootPath\":\"/work/proj-d\"},",
  "{\"id\":null,\"rootPath\":\"/c\"},",
  "{\"id\":\"wks_root\",\"rootPath\":\"/\"},",
  "{\"id\":\"wks_prefix\",\"rootPath\":\"/work/proj\"},",
  "{\"id\":\"wks_lone_\\udc00\",\"rootPath\":\"/work/lone\\ud800\"},",
  "{\"id\":\"wks_first\",\"rootPath\":\"/work/dup\",\"id\":\"wks_last\"}",
  "]}",
];
const WS = ".claude/.claudius/workspaces.json";

// The registry.
for (const s of [
  file(`${S}/@LIVE@.json`, [
    `{"pid":@LIVE@,"sessionId":"sender-live-1","cwd":"/work/proj-a/packages/web","name":"afrexim-99","messagingSocketPath":"/tmp/cc-socks/live.sock","startedAt":${AT - 60_000}}`,
  ]),
  rec("1.json", JSON.stringify({ pid: 1, sessionId: "init-record", cwd: "/", name: "launchd" })),
  rec("99999001.json", JSON.stringify({ pid: 99999002, sessionId: "rec-mismatch", messagingSocketPath: "/tmp/s/mismatch.sock" })),
  rec("99999003.json", JSON.stringify({ pid: 99999003, sessionId: "has space" })),
  rec("99999004.json", JSON.stringify({ pid: 99999004, sessionId: "a".repeat(129) })),
  rec("99999005.json", JSON.stringify({ pid: 99999005, sessionId: "b".repeat(128), cwd: "/work/dup/x" })),
  rec("99999006.json", JSON.stringify({ pid: "99999006", sessionId: "string-pid" })),
  rec("99999007.json", '{"pid":99999007.0,"sessionId":"float-text-pid","cwd":"/work/proj-b/x"}'),
  rec("99999008.json", '{"pid":99999008,"sessionId":"torn"'),
  rec("99999009.json", [{ hex: "efbbbf" }, '{"pid":99999009,"sessionId":"bom"}']),
  rec("99999010.json", "null"),
  { op: "dir", path: `${S}/99999011.json` },
  file("records/r12.json", [JSON.stringify({ pid: 99999012, sessionId: "via-symlink", cwd: "/elsewhere" })]),
  { op: "link", path: `${S}/99999012.json`, target: "../../records/r12.json" },
  { op: "link", path: `${S}/99999013.json`, target: "../../records/missing.json" },
  rec("99999014.json", JSON.stringify({ pid: 99999014, sessionId: "locked" })),
  { op: "chmod", path: `${S}/99999014.json`, mode: 0 },
  rec(
    "99999015.json",
    '{"pid":99999015,"sessionId":"lone-cwd","cwd":"/work/lone\\ud800/sub","name":"caf\\u00e9 \\ud83d\\ude00 \\udc00 \u00e9"}',
  ),
  rec("99999016.json", '{"pid":99999016,"sessionId":"inf-start","startedAt":1e400}'),
  rec("99999017.json", JSON.stringify({ pid: 99999017, sessionId: "num-socket", messagingSocketPath: 17 })),
  rec("99999018.json", '{"pid":99999018,"sessionId":"first","sessionId":"second"}'),
  rec("99999019.json", JSON.stringify({ pid: 99999019, sessionId: "odd-fields", cwd: 19, name: "" })),
  rec("99999020.json", JSON.stringify({ pid: 1.5, sessionId: "frac", messagingSocketPath: "/tmp/s/frac.sock" })),
  rec("99999021.json", JSON.stringify({ pid: 99999021, sessionId: "frac-next", messagingSocketPath: "/tmp/s/frac.sock" })),
  rec("10.json", JSON.stringify({ pid: 99999030, sessionId: "order-ten", messagingSocketPath: "/tmp/s/order.sock" })),
  rec("9.json", JSON.stringify({ pid: 99999031, sessionId: "order-nine", messagingSocketPath: "/tmp/s/order.sock" })),
  rec("99999040.json", JSON.stringify({ pid: 0, sessionId: "pid-zero", messagingSocketPath: "/tmp/s/zero.sock" })),
  rec("2147483648.json", JSON.stringify({ pid: 2147483648, sessionId: "big-pid", messagingSocketPath: "/tmp/s/int32.sock" })),
  rec("99999041.json", JSON.stringify({ pid: -2147483648, sessionId: "int-min", messagingSocketPath: "/tmp/s/intmin.sock" })),
  rec("99999042.json", JSON.stringify({ pid: -99999042, sessionId: "neg-pid", messagingSocketPath: "/tmp/s/neg.sock" })),
  rec("99999043.json", JSON.stringify({ pid: 9007199254740991, sessionId: "max-safe", messagingSocketPath: "/tmp/s/maxsafe.sock" })),
  rec("99999044.json", '{"pid":9007199254740992,"sessionId":"unsafe","messagingSocketPath":"/tmp/s/unsafe.sock"}'),
  rec("99999050.json", JSON.stringify({ pid: 99999050, sessionId: "both-main", messagingSocketPath: "/tmp/s/both.sock" })),
  rec("99999060.json", '{"pid":99999060,"sessionId":"lone-socket","messagingSocketPath":"/tmp/s/\\ud800.sock"}'),
  rec("99999061.json", '{"pid":99999061,"sessionId":"euro-socket","messagingSocketPath":"/tmp/s/\\u20ac.sock"}'),
  rec("99999062.json", JSON.stringify({ pid: 99999062, sessionId: "pct-socket", messagingSocketPath: "/tmp/s/100%.sock" })),
  rec("99999063.json", JSON.stringify({ pid: 99999063, sessionId: "raw-pct", messagingSocketPath: "%E2%82" })),
  rec("abc.json", JSON.stringify({ pid: 99999070, sessionId: "abc-name", messagingSocketPath: "/tmp/s/names.sock" })),
  rec("12.json.bak", JSON.stringify({ pid: 99999070, sessionId: "bak-name", messagingSocketPath: "/tmp/s/names.sock" })),
  rec("\u0663.json", JSON.stringify({ pid: 99999070, sessionId: "arabic-name", messagingSocketPath: "/tmp/s/names.sock" })),
  rec("99999071.JSON", JSON.stringify({ pid: 99999071, sessionId: "upper-ext", messagingSocketPath: "/tmp/s/names.sock" })),
  rec("0099999072.json", JSON.stringify({ pid: 99999072, sessionId: "leading-zero-name", messagingSocketPath: "/tmp/s/lz.sock" })),
  rec("99999073.json", JSON.stringify([{ pid: 99999073, sessionId: "arr" }])),
  rec("99999074.json", JSON.stringify("99999074")),
  rec("99999075.json", ""),
  rec("99999077.json", JSON.stringify({ pid: 99999077, sessionId: "str-start", startedAt: "1" })),
  rec("99999078.json", JSON.stringify({ pid: 99999078, sessionId: "late-start", startedAt: AT + 5001 })),
  rec("99999079.json", ['{"pid":99999079,"sessionId":"bad-utf8","cwd":"/work/', { hex: "fffe" }, '"}']),
  rec("99999400.json", JSON.stringify({ pid: 99999400, sessionId: HOSTED, cwd: "/work/proj-b" })),
  // Profiles: real registry dirs only.
  file(`${P}/acc_a/sessions/@LIVE@.json`, [
    '{"pid":@LIVE@,"sessionId":"live-in-profile","messagingSocketPath":"/tmp/cc-socks/other.sock"}',
  ]),
  file(`${P}/acc_a/sessions/99999051.json`, [
    JSON.stringify({ pid: 99999051, sessionId: "both-profile", messagingSocketPath: "/tmp/s/both.sock" }),
  ]),
  file(`${P}/acc_a/sessions/99999100.json`, [
    JSON.stringify({ pid: 99999100, sessionId: "from-profile-a", messagingSocketPath: "/tmp/s/prof.sock" }),
  ]),
  { op: "link", path: `${P}/acc_b/sessions`, target: "../../../sessions" },
  { op: "dir", path: `${P}/acc_c` },
  file(`${P}/acc_d/sessions`, ["not a dir"]),
  file(`${P}/acc_e/projects/-work-proj-e/e.jsonl`, [sendResult("profile-transcript", M(10))], AT + 100),
  file(`${P}/acc_f/sessions/99999101.json`, [JSON.stringify({ pid: 99999101, sessionId: "only-in-f" })]),
  file("linked-registry/99999102.json", [JSON.stringify({ pid: 99999102, sessionId: "via-linked-registry" })]),
  { op: "link", path: `${P}/acc_g/sessions`, target: "../../../../linked-registry" },
  file(`${P}/README`, ["profiles"]),
  file(WS, WS_OK),
]) {
  step(s);
}

// Transcripts.
const PA = `${PR}/-work-proj-a`;
const PB = `${PR}/-work-proj-b`;
const PC = `${PR}/-work-proj-c`;
const PD = `${PR}/-work-proj-d`;
const BODY1 = "  Please review the PR #42 when you get a chance.\n";
for (const s of [
  file(
    `${PA}/receiver.jsonl`,
    [
      line({ type: "system", subtype: "init", cwd: "/work/receiver", sessionId: "receiver-1", tools: ["Bash", "SendMessage"] }),
      line({
        type: "user",
        sessionId: "receiver-1",
        origin: { kind: "peer", from: "uds:/tmp/cc-socks/live.sock", msg_id: M(1) },
        message: { role: "user", content: `<cross-session-message>${BODY1}</cross-session-message>` },
      }),
      line({ type: "assistant", sessionId: "receiver-1", toolUseResult: `msg_id ${M(1)} was received` }),
      line({ type: "assistant", sessionId: "receiver-1", message: { content: [{ type: "text", text: "SendMessage" }] } }),
    ],
    AT + 500,
  ),
  file(
    `${PA}/s1.jsonl`,
    [
      line({ type: "system", subtype: "init", cwd: "/work/proj-a", sessionId: "sender-transcript-1" }),
      sendCall("sender-transcript-1", BODY1, { cwd: "/work/proj-a/sub" }),
      sendResult("sender-transcript-1", M(1), { cwd: "/work/proj-a/sub" }),
    ],
    AT + 1000,
  ),
  file(`${PA}/old.jsonl`, [sendResult("old-sender", M(2), { cwd: "/work/proj-a" })], AT - 400_000),
  file(`${PA}/.jsonl`, [sendResult("dot-jsonl-name", M(11))], AT + 1100),
  file(`${PA}/x.JSONL`, [sendResult("upper-jsonl", M(12))], AT + 1200),
  { op: "dir", path: `${PA}/dir.jsonl`, mtimeMs: AT + 1250 },
  file("outside/linked.jsonl", [sendResult("linked-sender", M(7), { cwd: "/elsewhere/deep" })], AT + 1300),
  { op: "link", path: `${PA}/link.jsonl`, target: "../../../outside/linked.jsonl" },
  { op: "link", path: `${PA}/dangling.jsonl`, target: "../../../outside/nope.jsonl" },
  file(`${PA}/locked.jsonl`, [sendResult("locked-sender", M(8))], AT + 1400),
  { op: "chmod", path: `${PA}/locked.jsonl`, mode: 0 },
  file(
    `${PB}/crlf.jsonl`,
    [
      '{"type":"system","cwd": "/spaced","sessionId":"crlf-sender"}\r\n',
      '{"type":"x","cwd":""}\r\n',
      '[{"cwd":"/in-array"}]\r\n',
      '{"cwd":"/torn"\r\n',
      '{"type":"system","cwd":"/work/proj-b/deeper","sessionId":"crlf-sender"}\r\n',
      JSON.stringify({ type: "user", sessionId: "crlf-sender", cwd: "/work/proj-b/other", toolUseResult: { msg_id: M(3) } }) + "\r\n",
    ],
    AT + 2000,
  ),
  file(`${PB}/u2028.jsonl`, [sendCall("u2028-sender", "Line one\u2028line two\u2029 and more text", { cwd: "/work/proj-b" })], AT + 2100),
  file(
    `${PB}/badsession.jsonl`,
    [
      line({ type: "user", sessionId: "bad id!", toolUseResult: { msg_id: M(5) } }),
      line({ type: "user", sessionId: 5, toolUseResult: { msg_id: M(5) } }),
      line({ type: "user", sessionId: "good-after-bad", cwd: "/work/proj-b/g", toolUseResult: { msg_id: M(5) } }),
    ],
    AT + 2200,
  ),
  file(`${PB}/upper.jsonl`, [sendResult("lower-sender", M(6).replace("1111-4111", "aaaa-4aaa"))], AT + 2300),
  file(`${PB}/nocwd.jsonl`, [line({ sessionId: "no-cwd", cwd: 5, toolUseResult: { msg_id: M(13) } })], AT + 2400),
  file(
    `${PB}/torn.jsonl`,
    [`{"sessionId":"torn-1","toolUseResult":{"msg_id":"${M(14)}"\n`, line({ sessionId: "after-torn", toolUseResult: { msg_id: M(14) } })],
    AT + 2500,
  ),
  file(`${PB}/toolstr.jsonl`, [line({ sessionId: "tool-str", toolUseResult: M(15) })], AT + 2600),
  file(`${PB}/hosted.jsonl`, [line({ sessionId: HOSTED, cwd: "/work/proj-b", toolUseResult: { msg_id: M(30) } })], AT + 2700),
  file(
    `${PB}/shapes.jsonl`,
    [
      line({ sessionId: "shape-1", message: { content: "SendMessage body text here" } }),
      line({ sessionId: "shape-2", message: { content: [null, "x", { type: "tool_use", name: "SendMessage", input: null }] } }),
      line({ sessionId: "shape-3", message: { content: [{ type: "tool_use", name: "SendMessage", input: { message: 5 } }] } }),
      line({ sessionId: "shape-4", message: { content: [{ type: "text", name: "SendMessage", input: { message: "Shapes body text here" } }] } }),
      line({ sessionId: "shape-5", message: "SendMessage" }),
      line({ sessionId: "shape-6", message: { content: [{ type: "tool_use", name: "SendMessage", input: { message: "Shapes body text here!" } }] } }),
    ],
    AT + 2800,
  ),
  // Characters cut by node's 64 KiB chunks inside the start cwd.
  ...[
    ["inv1", "f09f9880ff", 2, "e282", "A"],
    ["inv2", "e282ac", 1, "", ""],
    ["inv3", "f09f41", 2, "", ""],
    ["inv4", "eda080", 1, "", ""],
    ["inv5", "c080", 1, "", ""],
    ["inv6", "f5808080", 1, "", ""],
  ].map(([name, hex, before, hex2, tail], i) => {
    const prefix = '{"pad":"';
    const mid = '","cwd":"/c/';
    const pad = 64 * 1024 - prefix.length - mid.length - before;
    return file(
      `${PC}/${name}.jsonl`,
      [
        prefix,
        { rep: "x", n: pad },
        mid,
        { hex },
        ...(hex2 ? [{ hex: hex2 }] : []),
        `${tail}","sessionId":"${name}"}\n`,
        sendResult(name, M(40 + i)),
      ],
      AT + 3000 + i,
    );
  }),
  file(
    `${PC}/huge.jsonl`,
    [
      line({ type: "system", cwd: "/work/proj-c", sessionId: "huge-sender" }),
      '{"type":"user","blob":"',
      big(3_000_000),
      '"}\n',
      '{"type":"assistant","sessionId":"huge-sender","message":{"content":[{"type":"tool_use","name":"SendMessage","input":{"message":"Huge transcript message body here","image":"',
      { rep: "B", n: 1_500_000 },
      '"}}]}}\n',
      `{"type":"user","sessionId":"huge-sender","toolUseResult":{"msg_id":"${M(9)}","blob":"`,
      { rep: "C", n: 2_000_000 },
      '"}}',
    ],
    AT + 3500,
  ),
  file(`${PD}/decoy.jsonl`, [sendCall("astral-decoy", "x".repeat(199) + "\ud83d\ude01 decoy")], AT + 4000),
  file(`${PD}/real.jsonl`, [sendCall("astral-real", "x".repeat(199) + "\ud83d\ude00 real")], AT + 4100),
  file(`${PD}/real2.jsonl`, [sendCall("astral-two", "x".repeat(198) + "\ud83d\ude00 two")], AT + 4200),
  file(`${PD}/trim.jsonl`, [sendCall("trim-sender", "\u00a0\u3000 \ufeffHello from the other session, friend\u2028")], AT + 4300),
  file(
    `${PD}/lone.jsonl`,
    [
      '{"type":"assistant","sessionId":"lone-body","message":{"content":[{"type":"tool_use","name":"SendMessage","input":{"message":"',
      "z".repeat(199),
      '\\ud83d!"}}]}}\n',
    ],
    AT + 4400,
  ),
  file(`${PR}/not-a-dir.txt`, ["x"]),
  file(`${PR}/-locked-dir/l.jsonl`, [sendResult("locked-dir-sender", M(17))], AT + 4500),
  { op: "chmod", path: `${PR}/-locked-dir`, mode: 0 },
]) {
  step(s);
}

// Params and the 400.
for (const q of [
  null,
  "",
  "pid=",
  "pid=abc",
  "pid=12345678901",
  "pid=-5",
  "pid=1.0",
  "pid=%EF%BC%91",
  "pid=+1",
  "msgId=",
  "from=",
  "snippet=",
  "at=123",
  "PID=1",
  "pid=abc&pid=1",
  "&&=&pid&at=1",
]) {
  get(q);
}
for (const q of [
  "pid=0",
  "pid=1",
  "pid=1&pid=abc",
  "p%69d=1",
  "from=tcp%3A127.0.0.1",
  "from=uds%3A",
  "snippet=%20%20",
  "snippet=+++",
  "msgId=not-a-uuid",
  `msgId=${M(99)}`,
  // `at` is 1 to 16 digits: 17 are ignored (a hit as without `at`), 16
  // put the window past every file.
  `msgId=${M(1)}&at=12345678901234567`,
  `msgId=${M(1)}&at=1234567890123456`,
]) {
  get(q);
}

// The registry.
for (const q of [
  "pid=@LIVE@",
  "pid=0@LIVE@",
  "pid=@LIVE@&from=uds%3A%2Ftmp%2Fcc-socks%2Flive.sock",
  "pid=@LIVE@&from=uds%3A%2Ftmp%2Fcc-socks%2Fother.sock",
  `pid=@LIVE@&at=${AT - 70_000}`,
  `pid=@LIVE@&at=${AT - 65_000}`,
  `pid=@LIVE@&at=${AT - 65_001}`,
  "from=uds%3A%2Ftmp%2Fcc-socks%2Fother.sock",
  "from=uds:/tmp/cc-socks/live.sock",
  "pid=99999001",
  "from=uds%3A%2Ftmp%2Fs%2Fmismatch.sock",
  "pid=99999002&from=uds%3A%2Ftmp%2Fs%2Fmismatch.sock",
  "pid=99999003",
  "pid=99999004",
  "pid=99999005",
  "pid=99999006",
  "pid=99999007",
  "pid=99999008",
  "pid=99999009",
  "pid=99999010",
  "pid=99999011",
  "pid=99999012",
  "pid=99999013",
  "pid=99999015",
  `pid=99999016&at=${AT}`,
  "pid=99999016",
  "pid=99999017&from=uds%3A%2Fsome%2Fsock",
  "pid=99999018",
  "pid=99999019",
  "from=uds%3A%2Ftmp%2Fs%2Ffrac.sock",
  "from=uds%3A%2Ftmp%2Fs%2Forder.sock",
  "from=uds%3A%2Ftmp%2Fs%2Fzero.sock",
  "from=uds%3A%2Ftmp%2Fs%2Fint32.sock",
  "pid=2147483648",
  "from=uds%3A%2Ftmp%2Fs%2Fintmin.sock",
  "from=uds%3A%2Ftmp%2Fs%2Fneg.sock",
  "from=uds%3A%2Ftmp%2Fs%2Fmaxsafe.sock",
  "from=uds%3A%2Ftmp%2Fs%2Funsafe.sock",
  "from=uds%3A%2Ftmp%2Fs%2Fboth.sock",
  "pid=99999051",
  "pid=99999101",
  "pid=99999102",
  "from=uds%3A%2Ftmp%2Fs%2Fprof.sock",
  "from=uds%3A%2Ftmp%2Fs%2F%EF%BF%BD.sock",
  "from=uds%3A%2Ftmp%2Fs%2F%E2%82%AC.sock",
  "from=uds%3A%252Ftmp%252Fs%252F%25E2%2582%25AC.sock",
  "from=uds%3A%2Ftmp%2Fs%2F100%25.sock",
  "from=uds%3A%2525E2%252582",
  "from=uds%3A%25E2%2582",
  "from=uds%3A%2Ftmp%2Fs%2Fnames.sock",
  "from=uds%3A%2Ftmp%2Fs%2Flz.sock",
  "pid=99999072",
  "pid=99999073",
  "pid=99999074",
  "pid=99999075",
  `pid=99999077&at=${AT}`,
  `pid=99999078&at=${AT}`,
  `pid=99999078&at=${AT + 1}`,
  "pid=99999079",
  "pid=99999400",
  "pid=9999999999",
]) {
  get(q);
}
get("pid=99999014", { needsPerms: true });

// Transcripts.
const sn = (s) => `snippet=${enc(s)}`;
for (const q of [
  `msgId=${M(1)}`,
  `msgId=${M(1).toUpperCase()}`,
  `${sn("Please review the PR #42")}&at=${AT}`,
  `${sn("  Please review the PR #42 when you get a chance.\n\n\n")}&at=${AT}`,
  sn("Please review the PR #42 when"),
  `${sn("Please review")}&at=${AT}`,
  `msgId=${M(2)}&at=${AT}`,
  `msgId=${M(2)}`,
  `msgId=${M(3)}`,
  `${sn("Line one\u2028line two\u2029")}&at=${AT}`,
  `msgId=${M(5)}`,
  `msgId=${M(6).replace("1111-4111", "aaaa-4aaa").toUpperCase()}`,
  `msgId=${M(6).replace("1111-4111", "aaaa-4aaa")}`,
  `msgId=${M(7)}`,
  `msgId=${M(9)}`,
  `${sn("Huge transcript message body")}&at=${AT}`,
  `msgId=${M(10)}`,
  `msgId=${M(11)}`,
  `msgId=${M(12)}`,
  `msgId=${M(13)}`,
  `msgId=${M(14)}`,
  `msgId=${M(15)}`,
  `msgId=${M(30)}`,
  `${sn("Shapes body text here")}&at=${AT}`,
  `${sn("SendMessage body text")}&at=${AT}`,
  ...[40, 41, 42, 43, 44, 45].map((n) => `msgId=${M(n)}`),
  `${sn("x".repeat(199) + "\ud83d\ude00 real")}&at=${AT}`,
  `${sn("x".repeat(198) + "\ud83d\ude00")}&at=${AT}`,
  `${sn("x".repeat(198) + "\ud83d\ude00 two and more")}&at=${AT}`,
  `${sn("z".repeat(199) + "\ud83d\ude00")}&at=${AT}`,
  `${sn("  Hello from the other session  ")}&at=${AT}`,
  `${sn("Hello from")}&at=${AT}`,
  `${sn("Hello from the o")}&at=${AT}`,
  `${sn("  Hello from the  ")}&at=${AT}`,
  `${sn("\u3000Hello from the other session, friend\u2028\u2028")}&at=${AT}`,
  `msgId=${M(1)}&snippet=${enc("Line one\u2028line two\u2029")}&at=${AT}`,
  `msgId=bad&${sn("Please review the PR #42")}&at=${AT}`,
  `pid=99999001&msgId=${M(3)}&from=uds%3A%2Fnone`,
]) {
  get(q);
}
get(`msgId=${M(8)}`, { needsPerms: true });
get(`msgId=${M(17)}`, { needsPerms: true });

// Cache: misses for 30 s, transcript hits for good, registry hits never;
// the key is the parsed query.
const LATE = `${PR}/-work-proj-late/late.jsonl`;
get(`msgId=${M(20)}`);
step(file(LATE, [sendResult("late-sender", M(20), { cwd: "/work/proj-a" })], AT + 5000));
get(`msgId=${M(20)}`);
get(`msgId=${M(20)}&at=${AT}`);
step({ op: "rm", path: LATE });
get(`msgId=${M(20)}&at=${AT}`);
get(`msgId=${M(20)}&at=0${AT}`);
get(`msgId=${M(20)}&at=${AT}&from=x`);
get("pid=99999300");
step(rec("99999300.json", JSON.stringify({ pid: 99999300, sessionId: "reg-late" })));
get("pid=099999300");
get(`pid=99999300&at=${AT}`);
get(`pid=99999300&at=${AT}`);
step({ op: "rm", path: `${S}/99999300.json` });
get(`pid=99999300&at=${AT}`);
// Eviction past 500 entries: k0..k2 are cached misses, then turn into
// registry hits; 498 more misses push out exactly the oldest entries up to
// k0, and k0's (uncached) registry hit pushes out k1.
for (const k of ["k0", "k1", "k2"]) get(`from=uds%3A%2Ftmp%2Ffill%2F${k}.sock`);
for (const k of ["k0", "k1", "k2"]) {
  step(rec(`9999920${k[1]}.json`, JSON.stringify({ pid: 99999200 + Number(k[1]), sessionId: `fill-${k}`, messagingSocketPath: `/tmp/fill/${k}.sock` })));
}
get("from=uds%3A%2Ftmp%2Ffill%2Fk0.sock");
step({ op: "fill", n: 498 });
for (const k of ["k1", "k0", "k1", "k2"]) get(`from=uds%3A%2Ftmp%2Ffill%2F${k}.sock`);

// Workspaces: the deepest root, then entries the TS filter throws on.
for (const [text, queries] of [
  [WS_OK, ["pid=99999015", "pid=1", "pid=99999012", "pid=99999005"]],
  [['{"version":1,"workspaces":[{"id":"w","rootPath":"/work"},null]}'], ["pid=@LIVE@", "pid=99999019"]],
  [['{"version":1,"workspaces":[5]}'], ["pid=@LIVE@"]],
  [['{"version":1,"workspaces":["/work"]}'], ["pid=@LIVE@"]],
  [['{"version":1,"workspaces":[{"id":"w"}]}'], ["pid=@LIVE@"]],
  [['{"version":1,"workspaces":[{"id":"w","rootPath":null}]}'], ["pid=@LIVE@"]],
  [['{"version":1,"workspaces":[{"id":"w","rootPath":7}]}'], ["pid=@LIVE@"]],
  [['{"version":1,"workspaces":[{"id":"w","rootPath":["/work"]}]}'], ["pid=@LIVE@"]],
  [['{"version":1,"workspaces":[{"id":"w","rootPath":"/work/proj-a/packages/web"}]}'], ["pid=@LIVE@"]],
  [['{"version":1,"workspaces":[{"id":"w","rootPath":""}]}'], ["pid=@LIVE@"]],
  [['{"version":2,"workspaces":[{"id":"w","rootPath":"/"}]}'], ["pid=@LIVE@"]],
  [['{"version":1,"workspaces":{"0":{"id":"w","rootPath":"/"}}}'], ["pid=@LIVE@"]],
  [["null"], ["pid=@LIVE@"]],
  [["{oops"], ["pid=@LIVE@"]],
]) {
  step(file(WS, text));
  for (const q of queries) get(q);
}
step({ op: "rm", path: WS });
get("pid=@LIVE@");
step({ op: "dir", path: WS });
get("pid=@LIVE@");

let fills = 0;
for (const s of routeSteps) {
  if (s.op === "get") {
    const url = `http://localhost/api/sessions/peer-source${s.query === null ? "" : `?${sub(s.query)}`}`;
    try {
      const res = await route.GET(new Request(url));
      s.got = { status: res.status, type: res.headers.get("content-type"), body: await res.text() };
    } catch (e) {
      s.got = { threw: `${e.name}: ${e.message}` };
    }
  } else if (s.op === "fill") {
    for (let i = 0; i < s.n; i++) {
      const res = await route.GET(
        new Request(`http://localhost/api/sessions/peer-source?from=uds%3A%2Ftmp%2Ffill%2F${fills++}.sock`),
      );
      const body = await res.text();
      if (res.status !== 200 || body !== '{"source":null}') throw new Error(`fill ${i}: ${res.status} ${body}`);
    }
  } else {
    apply(HOME, s);
  }
}

const fixture = {
  node: process.version,
  defaults,
  lines,
  core,
  route: { hosted: HOSTED, steps: routeSteps },
};
writeFileSync(process.env.PS_GOLDEN_OUT, `${JSON.stringify(fixture, null, 1)}\n`);
console.log(
  `peer-source golden: ${lines.length} line cases, ${core.length} core groups (${core.reduce((n, g) => n + g.steps.filter((s) => s.op === "resolve").length, 0)} calls), ${routeSteps.filter((s) => s.op === "get").length} requests + ${fills} fills -> ${process.env.PS_GOLDEN_OUT}`,
);
process.exit(0);
