#!/usr/bin/env node
// Golden fixture for the per-session transcript page and search routes
// (S14), recorded from the real TS handlers:
//
//   node rust/scripts/transcript-golden.mjs     (node@22)
//
// Re-runs itself under `--experimental-transform-types` with HOME and
// CLAUDE_CONFIG_DIR at a temp dir, writes the `sessions` transcripts below
// under <config>/projects/<the SDK's dir name for $A / $B>/<id>.jsonl (each
// session's `file` text in the fixture, with the JSON-escaped `\u0001BAD\u0001`
// marker written as the invalid UTF-8 bytes FF 20 E2 82), and
// calls `GET` of app/api/sessions/[id]/transcript/route.ts and
// .../search/route.ts for every case. `$A` / `$B` in a case's query stand
// for the two project dirs; `$B` is also the cwd of the one live session
// (`LIVE`), the `dir` fallback. Each case records the HTTP status and the raw
// body text (so key order, number formatting and the escapes of lone
// surrogates count), or "threw" when the handler threw (Next's empty 500).
//
// Written to rust/crates/claudius-core/tests/fixtures/transcript_golden.json
// and replayed by crates/claudius-server/tests/transcript_search.rs.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "crates/claudius-core/tests/fixtures/transcript_golden.json");

// ─────────────────────────────── transcripts ───────────────────────────────

const S1 = "11111111-1111-4111-8111-111111111111"; // the paged chain
const S2 = "22222222-2222-4222-8222-222222222222"; // in $A and in $B (live in $B)
const S3 = "33333333-3333-4333-8333-333333333333"; // search texts
const S4 = "44444444-4444-4444-8444-444444444444"; // odd message shapes
const S5 = "55555555-5555-4555-8555-555555555555"; // a turn without `message`
const S6 = "77777777-7777-4777-8777-777777777777"; // a turn with `message: null`
const S7 = "88888888-8888-4888-8888-888888888888"; // a null content block
const S8 = "99999999-9999-4999-8999-999999999999"; // a null tool_result part
const S9 = "a9a9a9a9-a9a9-4a9a-8a9a-a9a9a9a9a9a9"; // invalid UTF-8, a torn last line
const MISSING = "66666666-6666-4666-8666-666666666666";
const LIVE = S2;
const uuidOf = (session, i) => `${session.slice(0, 8)}-0000-4000-8000-${String(i).padStart(12, "0")}`;

/** A linear chain of transcript entries. `it.raw` merges over the entry. */
function chain(sessionId, items) {
  let parent = null;
  return items.map((it, i) => {
    const uuid = it.uuid ?? uuidOf(sessionId, i + 1);
    const base = {
      parentUuid: parent,
      isSidechain: false,
      userType: "external",
      cwd: "/golden",
      sessionId,
      version: "2.1.300",
      uuid,
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    };
    parent = uuid;
    let e;
    if (it.type === "user") e = { ...base, type: "user", message: { role: "user", content: it.content } };
    else if (it.type === "assistant") {
      e = {
        ...base,
        type: "assistant",
        requestId: `req_${i}`,
        message: {
          id: `msg_${sessionId.slice(0, 4)}_${i}`,
          type: "message",
          role: "assistant",
          model: "claude-golden",
          content: it.content,
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 2.5e-7, cache_read_input_tokens: 1e21 },
        },
      };
    } else e = { ...base, type: "system", subtype: "informational", content: it.content, level: "info", isMeta: false };
    return { ...e, ...(it.raw ?? {}) };
  });
}

const text = (t) => [{ type: "text", text: t }];
const BAD = "\u0001BAD\u0001"; // written as invalid UTF-8
const pageChain = [];
for (let i = 1; i <= 12; i++) {
  if (i === 6) pageChain.push({ type: "system", content: `system note ${i}` });
  else pageChain.push({ type: i % 2 ? "user" : "assistant", content: i % 2 ? `question ${i}` : text(`answer ${i} {"1":true,"a":1}`) });
}

const ISTANBUL = "İ".repeat(30) + " then the TARGET word sits here " + "z".repeat(80);
const SURR_START = "x".repeat(5) + "😀" + "y".repeat(59) + "NEEDLE" + " tail";
const SURR_END = "head " + "NEEDLE" + "z".repeat(59) + "😀" + "w".repeat(10);
const LONG_BOTH = "a".repeat(100) + " Middle Match " + "b".repeat(100);
const searchChain = [
  { type: "user", content: "Hello World, hello again HELLO" },
  { type: "assistant", content: text("price is $5.00 (approx) [tag] a+b*c? .* ^start end$ back\\slash") },
  { type: "user", content: ISTANBUL },
  { type: "assistant", content: text(SURR_START) },
  { type: "user", content: SURR_END },
  { type: "assistant", content: text(LONG_BOTH) },
  { type: "user", content: "ws:\t\n\n  tabs\u00a0nbsp\u3000ideo\ufeffbom\u0085nel\u180emvs\u2028ls end" },
  { type: "assistant", content: text("ΣΟΣ and ΟΔΟΣ, straße ẞ, ǅ title, ﬁ ligature") },
  { type: "system", content: "system-only needle" },
  { type: "user", content: "match match match match match match match" },
  { type: "assistant", content: [{ type: "thinking", thinking: "deep thought" }, { type: "text", text: "visible" }] },
  { type: "assistant", content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls -la", n: 1.5, big: 1e21, "2": "two" } }] },
  { type: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: [{ type: "text", text: "result-a" }, { type: "text", text: "result-b" }] }] },
  { type: "user", content: [{ type: "tool_result", tool_use_id: "tu2", content: "plain result" }] },
  { type: "assistant", content: [{ type: "text", text: "p".repeat(70) }, { type: "text", text: "JOINED" }] },
];
const oddChain = [
  { type: "assistant", content: [{ type: "tool_use", id: "t1", name: 7, input: null }] },
  { type: "assistant", content: [{ type: "tool_use", id: "t2", name: { x: 1 } }] },
  { type: "assistant", content: [{ type: "tool_use", id: "t3", name: ["a", "b"], input: [] }] },
  { type: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ text: 5 }, { type: "text" }, { text: "kept" }] }] },
  { type: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: { text: "obj" } }] },
  { type: "assistant", content: [{ type: "text", text: 42 }, { type: "thinking" }, { type: "image" }] },
  { type: "user", content: 17 },
  { type: "user", content: "", raw: {} },
  { type: "user", content: "x", raw: { message: "a bare string message" } },
  { type: "assistant", content: "x", raw: { message: ["an", "array"] } },
  { type: "user", content: [1, "text", true, [{ type: "text", text: "nested" }]] },
  { type: "assistant", content: text("odd-final") },
];
const noMessage = [
  { type: "user", content: "before the hole" },
  { type: "assistant", content: text("x"), raw: { message: undefined } },
  { type: "user", content: "after the hole" },
];

const SESSIONS = [
  { project: "$A", id: S1, entries: chain(S1, pageChain) },
  { project: "$A", id: S2, entries: chain(S2, [{ type: "user", content: "copy in A: findme" }]) },
  { project: "$B", id: S2, entries: chain(S2, [{ type: "user", content: "copy in B: findme" }, { type: "assistant", content: text("B reply") }]) },
  { project: "$A", id: S3, entries: chain(S3, searchChain) },
  { project: "$A", id: S4, entries: chain(S4, oddChain) },
  { project: "$B", id: S5, entries: chain(S5, noMessage) },
  {
    project: "$A",
    id: S6,
    entries: chain(S6, [
      { type: "user", content: "null message next" },
      { type: "assistant", content: text("x"), raw: { message: null } },
    ]),
  },
  { project: "$A", id: S7, entries: chain(S7, [{ type: "user", content: [null, { type: "text", text: "null block" }] }]) },
  {
    project: "$A",
    id: S8,
    entries: chain(S8, [{ type: "user", content: [{ type: "tool_result", tool_use_id: "t", content: [{ text: "part" }, null] }] }]),
  },
  {
    project: "$B",
    id: S9,
    entries: chain(S9, [
      { type: "user", content: `bad ${BAD} byte` },
      { type: "assistant", content: text("fine") },
    ]),
    tail: `{"type":"user","uuid":"${uuidOf(S9, 3)}","parentUuid":"${uuidOf(S9, 2)}","message":{"content":"torn`,
  },
];

/**
 * The transcript file's text: the entries as JSONL plus `tail`, with numbers
 * in forms `JSON.stringify` never writes (`25E-8`, `1.0`, `1E21`, a 22-digit
 * `.0`) and integer keys after string keys, so a reader that re-serializes
 * the source text or keeps its key order is caught. Written with [`BAD`] as
 * invalid UTF-8 (see `fileBytes`).
 */
function fileText(s) {
  return (s.entries.map((e) => JSON.stringify(e)).join("\n") + "\n" + (s.tail ?? ""))
    .replaceAll('"output_tokens":2.5e-7', '"output_tokens":25E-8')
    .replaceAll('"usage":{"input_tokens":1,', '"usage":{"input_tokens":1.0,"10":"ten","2":"two",')
    .replaceAll('"cache_read_input_tokens":1e+21', '"cache_read_input_tokens":1000000000000000000000.0')
    .replaceAll('"input":{"2":"two","command":"ls -la","n":1.5,"big":1e+21}', '"input":{"command":"ls -la","2":"two","n":15e-1,"big":1E21}');
}
/** `fileText` with each `BAD` marker (as JSON escapes it) as the bytes FF 20 E2 82. */
function fileBytes(text) {
  const parts = text.split(JSON.stringify(BAD).slice(1, -1));
  return Buffer.concat(parts.flatMap((p, i) => (i ? [Buffer.from([0xff, 0x20, 0xe2, 0x82]), Buffer.from(p)] : [Buffer.from(p)])));
}

// ─────────────────────────────── cases ───────────────────────────────

const T = (id, query) => ({ route: "transcript", id, query });
const Q = (id, query) => ({ route: "search", id, query });
const enc = encodeURIComponent;
const u1 = (i) => uuidOf(S1, i);
const CASES = [
  T(S1, ""),
  T(S1, "?limit=5"),
  T(S1, `?before=${u1(8)}&limit=3`),
  T(S1, `?before=${u1(1)}`),
  T(S1, `?before=${u1(2)}&limit=50`),
  T(S1, `?before=${u1(6)}&limit=2`),
  T(S1, `?before=${u1(4)}&limit=2.5`),
  T(S1, `?before=${u1(3)}&limit=2.5`),
  T(S1, `?before=${u1(12)}&limit=0`),
  T(S1, `?before=${u1(5)}&before=nope`),
  T(S1, "?before=nope"),
  T(S1, `?before=${u1(5)}%20`),
  T(S1, `?before=${u1(5)}&limit=1e400`),
  T(S1, "?before="),
  T(S1, "?limit=2.5"),
  T(S1, "?limit=0"),
  T(S1, "?limit=-1"),
  T(S1, "?limit=-0"),
  T(S1, "?limit=abc"),
  T(S1, "?limit="),
  T(S1, "?limit=%20%203%20"),
  T(S1, "?limit=1e1"),
  T(S1, "?limit=0x2"),
  T(S1, "?limit=Infinity"),
  T(S1, "?limit=-Infinity"),
  T(S1, "?limit=inf"),
  T(S1, "?limit=1_0"),
  T(S1, "?limit=999"),
  T(S1, "?limit=2&limit=5"),
  T(S1, "?limit=%2B4"),
  T(S1, "?LIMIT=2"),
  T(S1, `?dir=${enc("$A")}`),
  T(S1, `?dir=${enc("$B")}`),
  T(S1, `?dir=${enc("$A")}&limit=1`),
  T(S1, `?dir=${enc("$A")}%2F`),
  T(S1, `?dir=${enc("/nonexistent/claudius-golden")}`),
  T(S2, `?dir=${enc("$A")}`),
  T(S2, ""), // live → $B
  T(S2, `?dir=`),
  T(S4, ""),
  T(S5, ""),
  T(S6, ""),
  T(S7, ""),
  T(S9, ""),
  T(MISSING, ""),
  T(MISSING, "?before=x"),
  T("not-a-uuid", ""),
  Q(S3, "?q=hello"),
  Q(S3, "?q=HELLO"),
  Q(S3, "?q="),
  Q(S3, ""),
  Q(S3, "?q=%20%20%20"),
  Q(S3, "?q=%09%0A"),
  Q(S3, `?q=${enc("$5.00 (approx)")}`),
  Q(S3, `?q=${enc(".*")}`),
  Q(S3, `?q=${enc("[tag]")}`),
  Q(S3, `?q=${enc("a+b*c?")}`),
  Q(S3, `?q=${enc("^start")}`),
  Q(S3, `?q=${enc("end$")}`),
  Q(S3, `?q=${enc("back\\slash")}`),
  Q(S3, `?q=${enc("(")}`),
  Q(S3, `?q=${enc("(a+)+$")}`),
  Q(S3, "?q=target"),
  Q(S3, "?q=TARGET"),
  Q(S3, `?q=${enc("i̇")}`),
  Q(S3, `?q=${enc("İ")}`),
  Q(S3, "?q=needle"),
  Q(S3, "?q=middle+match"),
  Q(S3, `?q=${enc(" match ")}`),
  Q(S3, "?q=match"),
  Q(S3, "?q=tabs"),
  Q(S3, "?q=nel"),
  Q(S3, "?q=%C2%85"),
  Q(S3, "?q=%E1%A0%8E"),
  Q(S3, "?q=ls+end"),
  Q(S3, `?q=${enc("σος")}`),
  Q(S3, `?q=${enc("Σ")}`),
  Q(S3, `?q=${enc("οδος")}`),
  Q(S3, `?q=${enc("οδοσ")}`),
  Q(S3, "?q=STRASSE"),
  Q(S3, `?q=${enc("straße")}`),
  Q(S3, `?q=${enc("ß")}`),
  Q(S3, `?q=${enc("ǆ")}`),
  Q(S3, `?q=${enc("ﬁ")}`),
  Q(S3, "?q=fi"),
  Q(S3, "?q=system-only"),
  Q(S3, "?q=%5Bthinking%5D"),
  Q(S3, "?q=deep"),
  Q(S3, "?q=tool_use+Bash"),
  Q(S3, `?q=${enc('"2": "two"')}`),
  Q(S3, "?q=1e%2B21"),
  Q(S3, "?q=result-a"),
  Q(S3, "?q=%5Btool_result%5D"),
  Q(S3, "?q=joined"),
  Q(S3, "?q=e"),
  Q(S3, "?q=e&limit=2"),
  Q(S3, "?q=e&limit=2.5"),
  Q(S3, "?q=e&limit=0"),
  Q(S3, "?q=e&limit=-3"),
  Q(S3, "?q=e&limit=x"),
  Q(S3, "?q=e&limit=1"),
  Q(S3, "?q=a&q=hello"),
  Q(S3, "?q=%F0%9F%98%80"),
  Q(S3, "?q=%FF"),
  Q(S3, "?q=%ZZ"),
  Q(S4, "?q=tool_use"),
  Q(S4, "?q=undefined"),
  Q(S4, "?q=%5Bobject"),
  Q(S4, "?q=%7B%7D"),
  Q(S4, "?q=%5B%5D"),
  Q(S4, "?q=kept"),
  Q(S4, "?q=obj"),
  Q(S4, "?q=42"),
  Q(S4, "?q=17"),
  Q(S4, "?q=odd"),
  Q(S5, "?q=hole"),
  Q(S5, "?q=hole&limit=1"),
  Q(S5, "?q=after"),
  Q(S6, "?q=next"),
  Q(S6, "?q=next&limit=1"),
  Q(S7, "?q=block"),
  Q(S8, "?q=part"),
  Q(S9, "?q=bad"),
  Q(S9, "?q=%EF%BF%BD"),
  Q(S9, "?q=torn"),
  Q(S4, "?q=nested"),
  Q(S4, "?q=bare"),
  Q(S2, "?q=findme"), // live → $B
  Q(S2, `?q=findme&dir=${enc("$A")}`),
  Q(MISSING, "?q=x"),
  Q(MISSING, "?q="),
  Q("not-a-uuid", "?q=x"),
];

// ─────────────────────────────── recording ───────────────────────────────

if (!process.env.TRANSCRIPT_GOLDEN_CHILD) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "transcript-golden-")));
  try {
    const r = spawnSync(
      process.execPath,
      ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url)],
      {
        stdio: "inherit",
        env: {
          PATH: process.env.PATH,
          HOME: join(root, "home"),
          CLAUDE_CONFIG_DIR: join(root, "config"),
          TRANSCRIPT_GOLDEN_ROOT: root,
          TRANSCRIPT_GOLDEN_CHILD: "1",
        },
      },
    );
    process.exit(r.status ?? 1);
  } finally {
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

const root = process.env.TRANSCRIPT_GOLDEN_ROOT;
const projects = { $A: join(root, "projA"), $B: join(root, "projB") };
// The SDK's project dir name for a short absolute path.
const dirName = (abs) => abs.replace(/[^a-zA-Z0-9]/g, "-");
for (const s of SESSIONS) {
  s.file = fileText(s);
  const cwd = projects[s.project];
  mkdirSync(cwd, { recursive: true });
  const dir = join(process.env.CLAUDE_CONFIG_DIR, "projects", dirName(cwd));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${s.id}.jsonl`), fileBytes(s.file));
}

const { sessionManager } = await import(join(repo, "lib/server/session-manager.ts"));
sessionManager.get = (id) => (id === LIVE ? { id: LIVE, cwd: projects.$B } : undefined);
const routes = {
  transcript: (await import(join(repo, "app/api/sessions/[id]/transcript/route.ts"))).GET,
  search: (await import(join(repo, "app/api/sessions/[id]/search/route.ts"))).GET,
};
const fill = (q) => q.replaceAll(enc("$A"), enc(projects.$A)).replaceAll(enc("$B"), enc(projects.$B));

const cases = [];
for (const c of CASES) {
  let got;
  try {
    const url = `http://localhost/api/sessions/${c.id}/${c.route}${fill(c.query)}`;
    const res = await routes[c.route](new Request(url), { params: Promise.resolve({ id: c.id }) });
    got = { status: res.status, body: await res.text() };
  } catch (e) {
    got = { threw: e instanceof Error ? e.message : String(e) };
  }
  cases.push({ ...c, got });
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify({ live: LIVE, sessions: SESSIONS, cases }, null, 2)}\n`);
console.log(`wrote ${out.slice(repo.length + 1)}: ${SESSIONS.length} transcripts, ${cases.length} cases`);
