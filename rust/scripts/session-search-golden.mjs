#!/usr/bin/env node
// Golden fixture for the cross-session full-text search (D20),
// `GET /api/sessions/search` (app/api/sessions/search/route.ts), recorded
// from the real TS:
//
//   node rust/scripts/session-search-golden.mjs     (node@22: better-sqlite3)
//
// Re-runs itself under `--experimental-transform-types` with the repo as its
// cwd, HOME and CLAUDE_CONFIG_DIR at a temp dir, a resolve hook for the `@/`
// imports, and UV_THREADPOOL_SIZE=1: the route pushes matches as its 8
// concurrent reads complete, and with one libuv thread reads of files with
// the same number of read calls complete in the order they start, so the
// recorded order is the scan order (newest first) that Rust answers in.
// Three parts:
// * `canon`: the case-insensitive literal match itself. For every UTF-16
//   unit c, the route's own escape + `new RegExp(escaped, "gi")` (sliced out
//   of route.ts) run over a two-byte string holding all 65 536 units, and
//   over a one-byte (Latin-1) string of 256: the units it matches, wherever
//   that isn't just c itself.
// * `pure`: the route's match walk + snippet block (sliced out of route.ts,
//   from `re.lastIndex = 0;` to the `snippet` line, wrapped in a function
//   and type-stripped) on text / query pairs: hand-written edges
//   (case-folding classes, surrogate pairs at the window edges, the escape
//   passes, whitespace, the CC 2.1.300 `api-request*` skip and the snippet
//   clamped to the matched line) and seeded random strings over
//   case-variant alphabets, two-byte and Latin-1-only. `got` is null or the
//   match index and `JSON.stringify(snippet)`.
// * `worlds` + `steps`: transcript folders under $HOME/.claude/projects/
//   (`encoded` is encodeProjectDir(dir); `base` says what sits there),
//   with each entry's bytes (`parts`: UTF-8 text, `{hex}` or `{rep, n}`),
//   symlink target, mode and exact mtime (`mtimeNs`, as stat reads it back),
//   and `outside` files under $HOME they link to. Then the route's GET for
//   every step: the raw query, the three `searchParams.get` values, and the
//   status, content type and raw body text (or `threw`).
//
// Written to rust/crates/claudius-core/tests/fixtures/session_search_golden.json
// (or $SS_GOLDEN_OUT); replayed by crates/claudius-core/tests/session_search_golden.rs
// (`canon`, `pure`, and the steps through `session_search::respond`) and by
// crates/claudius-server/tests/session_search.rs (the steps on the real binary).
import { spawnSync } from "node:child_process";
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
import { register, stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = process.env.SS_GOLDEN_OUT || join(rustDir, "crates/claudius-core/tests/fixtures/session_search_golden.json");

/** chmod u+rwx every directory under `dir` (lstat, so links aren't followed). */
function restorePerms(dir) {
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    return;
  }
  if (!st.isDirectory()) return;
  try {
    chmodSync(dir, 0o755);
  } catch {
    // best effort
  }
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) restorePerms(join(dir, n));
}

if (!process.env.SS_GOLDEN_CHILD) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "session-search-golden-")));
  let status = 1;
  try {
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
          UV_THREADPOOL_SIZE: "1",
          SS_GOLDEN_CHILD: "1",
          ...(process.env.SS_GOLDEN_OUT ? { SS_GOLDEN_OUT: process.env.SS_GOLDEN_OUT } : {}),
        },
      },
    );
    status = r.status ?? 1;
  } finally {
    restorePerms(root);
    rmSync(root, { recursive: true, force: true });
  }
  process.exit(status);
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
}`;
register(`data:text/javascript,${encodeURIComponent(hook)}`);

const HOME = process.env.HOME;
const PROJECTS = join(HOME, ".claude", "projects");
const ROUTE = join(repo, "app/api/sessions/search/route.ts");
const route = await import(ROUTE);
const { projectRoot } = await import(join(repo, "lib/server/db.ts"));
const { encodeProjectDir } = await import(join(repo, "lib/server/auto-memory.ts"));

// --------------------------- the route's own code ---------------------------

const src = readFileSync(ROUTE, "utf8");
function sliceOut(re, what) {
  const m = src.match(re);
  if (!m) throw new Error(`route.ts changed: no ${what}`);
  return m[0];
}
const escLine = sliceOut(/^\s*const escaped = q\.replace\(.*\);$/m, "escape line");
const reLine = sliceOut(/^\s*const re = new RegExp\(escaped, "gi"\);$/m, "RegExp line");
const RADIUS = Number(sliceOut(/const SNIPPET_RADIUS = \d+;/, "SNIPPET_RADIUS").match(/\d+/)[0]);
// CC 2.1.300: the constant marker, taken from the route so a change to it
// fails here instead of going unrecorded.
const markerLine = sliceOut(/^const API_REQUEST_LINE_MARKER = .*;$/m, "api-request marker");
const MARKER = new Function(`${markerLine}\nreturn API_REQUEST_LINE_MARKER;`)();
/** The route's `re` for a query. */
const buildRe = new Function("q", `${escLine}\n${reLine}\nreturn re;`);
const from = src.indexOf("re.lastIndex = 0;");
const to = src.indexOf("matches.push(");
if (from < 0 || to < from || !src.slice(from, to).includes("if (!hit) continue;")) {
  throw new Error("route.ts changed: no snippet block");
}
// The block declares `let hit: RegExpExecArray | null`, so it is stripped
// of its types; `continue` / the trailing push become the function's exits.
const block = src.slice(from, to).replace("if (!hit) continue;", "if (!hit) return null;");
/** The route's match walk + snippet for one text. */
const snippetOf = new Function(
  `return ${stripTypeScriptTypes(
    `(function (text, re, SNIPPET_RADIUS, API_REQUEST_LINE_MARKER) {\n${block}\nreturn { index: hit.index, snippet };\n})`,
  )}`,
)();
const pureCase = (text, q) => {
  const r = snippetOf(text, buildRe(q), RADIUS, MARKER);
  return { text, q, got: r && { index: r.index, snippet: JSON.stringify(r.snippet) } };
};

// ------------------------------- canonicalize -------------------------------

let all = "";
for (let i = 0; i < 0x10000; i++) all += String.fromCharCode(i);
let latin = "";
for (let i = 0; i < 0x100; i++) latin += String.fromCharCode(i);
const twoByte = [];
const oneByte = [];
for (let c = 0; c < 0x10000; c++) {
  const re = buildRe(String.fromCharCode(c));
  const hits = [...all.matchAll(re)].map((m) => m.index);
  if (!(hits.length === 1 && hits[0] === c)) twoByte.push([c, hits]);
  const low = [...latin.matchAll(re)].map((m) => m.index);
  if (low.join() !== (c < 0x100 ? String(c) : "")) oneByte.push([c, low]);
}

// ----------------------------------- pure -----------------------------------

const pure = [];
const R = (n, s = "y") => s.repeat(n);
const EMOJI = "\ud83d\ude00";
const hand = [
  // Matches at the edges of the text and of the window.
  ["needle", "needle"],
  ["needle tail", "NEEDLE"],
  ["head needle", "Needle"],
  [`${R(60)}x`, "x"],
  [`${R(61)}x`, "x"],
  [`x${R(60)}`, "x"],
  [`x${R(61)}`, "x"],
  [`${R(70)}MID${R(70)}`, "mid"],
  ["short", "shorter"],
  ["", "a"],
  ["aaa", "aaaa"],
  // Surrogate pairs cut by the window.
  [`${R(5, "x")}${EMOJI}${R(59)}NEEDLE tail`, "needle"],
  [`head NEEDLE${R(59, "z")}${EMOJI}${R(10, "w")}`, "needle"],
  [`${R(4, "x")}${EMOJI}${R(59)}N${R(59, "z")}${EMOJI}w`, "n"],
  [`${EMOJI}${R(60)}q`, "q"],
  [`${EMOJI}${R(58)}q`, "q"],
  [`a${EMOJI}b`, EMOJI],
  [`\ud801\udc00 \ud801\udc28`, "\ud801\udc28"],
  [`\ud801\udc00`, "\ud801\udc28"],
  // Raw JSONL escapes, in pass order.
  ["a\\nb\\rc\\td\\\\ne\\\"f\\\\\\\\g\\\\\\h\\u00e9\\/i x", "x"],
  ["\\\\\"q", "q"],
  ["\\n", "\\n"],
  ["\\", "\\"],
  ["\\\\", "\\"],
  ["say \\\"hi\\\" now", "\"hi"],
  ["say \\\"hi\\\" now", "\\\"hi"],
  // Whitespace: JS \s (with BOM and NBSP, not NEL / U+180E / ZWSP), trimmed.
  [" \t\n\v\f\r x \u00a0\u1680\u2000\u2005\u200a\u2028\u2029\u202f\u205f\u3000\ufeff y \u0085 z\u180e\u200b w ", "x"],
  ["\u0085x\u0085", "x"],
  ["\ufeffx\ufeff", "x"],
  ["   x   ", "x"],
  ["\u0001\u0008\u001f\u007f x \"\\", "x"],
  // Case: classes under the non-u `i` flag.
  ["HELLO world", "hello WORLD"],
  ["\u03a3\u039f\u03a3 \u03bf\u03b4\u03bf\u03c2", "\u03c3\u03bf\u03c3"],
  ["\u03bf\u03b4\u03bf\u03c2", "\u039f\u0394\u039f\u03a3"],
  ["\u03c2", "\u03c3"],
  ["stra\u00dfe", "STRASSE"],
  ["STRASSE", "stra\u00dfe"],
  ["\u00df", "\u1e9e"],
  ["\u1e9e", "\u00df"],
  ["\u0130stanbul", "istanbul"],
  ["istanbul", "\u0130STANBUL"],
  ["\u0131", "I"],
  ["I", "\u0131"],
  ["i", "I"],
  ["\u017f", "s"],
  ["S", "\u017f"],
  ["\u212a", "k"],
  ["K", "\u212a"],
  ["\u00b5", "\u039c"],
  ["\u03bc", "\u00b5"],
  ["\u00ff", "\u0178"],
  ["\u0178", "\u00ff"],
  ["\u01c4\u01c5\u01c6", "\u01c6\u01c6\u01c6"],
  ["\u0390", "\u1fd3"],
  ["\ufb01", "FI"],
  ["fi", "\ufb01"],
  ["\u13a0", "\uab70"],
  ["\uab70", "\u13a0"],
  ["\u13f8", "\u13f0"],
  ["\u10d0", "\u1c90"],
  ["\u1c90", "\u10d0"],
  ["\u0345", "\u03b9"],
  ["\u1fbe", "\u0399"],
  ["\u03f4", "\u03b8"],
  ["\u03d1", "\u03b8"],
  ["\u1e9b", "\u1e61"],
  ["\u0149", "\u02bcN"],
  ["\u0587", "\u0535\u0552"],
  ["e\u0301", "\u00e9"],
  ["\u00c9", "\u00e9"],
  ["\u00c0\u00e0", "\u00e0\u00c0"],
  // Metacharacters are literal.
  ["price $5.00 (approx) [tag] a+b*c? ^start end$ {1} pipe|bar back\\d", ".*"],
  ["price $5.00 (approx) [tag] a+b*c? ^start end$ {1} pipe|bar back\\d", "$5.00"],
  ["price $5.00 (approx) [tag] a+b*c? ^start end$ {1} pipe|bar back\\d", "(approx)"],
  ["price $5.00 (approx) [tag] a+b*c? ^start end$ {1} pipe|bar back\\d", "[tag]"],
  ["price $5.00 (approx) [tag] a+b*c? ^start end$ {1} pipe|bar back\\d", "a+b*c?"],
  ["price $5.00 (approx) [tag] a+b*c? ^start end$ {1} pipe|bar back\\d", "^start"],
  ["price $5.00 (approx) [tag] a+b*c? ^start end$ {1} pipe|bar back\\d", "end$"],
  ["price $5.00 (approx) [tag] a+b*c? ^start end$ {1} pipe|bar back\\d", "{1}"],
  ["price $5.00 (approx) [tag] a+b*c? ^start end$ {1} pipe|bar back\\d", "pipe|bar"],
  ["price $5.00 (approx) [tag] a+b*c? ^start end$ {1} pipe|bar back\\d", "\\d"],
  ["price $5.00 (approx) [tag] a+b*c? ^start end$ {1} pipe|bar back\\d", "a.b"],
  ["price $5.00 (approx) [tag] a+b*c? ^start end$ {1} pipe|bar back\\d", "[a]"],
  ["literal (a+)+$ here", "(a+)+$"],
  [`${R(5000, "a")}!`, "(a+)+b"],
  ["x/y-z,w=v!u:t<s>r#q&p~o'n`m@l%k", "/y-z,w=v!u:t<s>r#q&p~o'n`m@l%k"],
  // Partial-match restarts.
  ["aabaabaaab", "aabaaab"],
  ["aabaabaab", "aabaaab"],
  ["abababc", "ABABC"],
  ["aabaaabaaaa", "AABAAAA"],
  ["\u03c3\u03c2x\u03c3\u03c3\u03c3x\u03c3\u03c2\u03c3\u03c3", "\u03a3\u03c3X\u03a3\u03c2\u03a3\u03a3"],
  ["\u03c3\u03c3\u03c2\u03c3\u03a3\u03c3", "\u03a3\u03c2\u03c3\u03c3"],
];
for (const [text, q] of hand) pure.push(pureCase(text, q));

// CC 2.1.300: the `api-request*` skip and the snippet clamped to the line.
// Shapes as the 2.1.300 engine writes them: `type` first, the prompt and
// tools under `shape`, a blob carrying a copy of a request message.
const SHAPE = (w) =>
  `{"type":"api-request-shape","sessionId":"s","shapeHash":"h1","version":"2.1.300","shape":{"system":[{"type":"text","text":"${w}"}]}}`;
const BLOB = (w) => `{"type":"api-request-blob","sessionId":"s","hash":"b1","message":{"role":"user","content":[{"type":"text","text":"${w}"}]}}`;
const REQ = '{"type":"api-request","sessionId":"s","id":"r1","shapeHash":"h1","params":{"model":"claude-opus-4-7","max_tokens":32000}}';
const USER = (w) => `{"type":"user","message":{"role":"user","content":"${w}"}}`;
const api = [
  // A word only in the system prompt, the tools JSON or the params.
  [`${SHAPE("zephyrine")}\n${USER("plain")}\n`, "zephyrine"],
  [`${SHAPE("persistent shell")}\n${USER("ok")}\n`, "persistent shell"],
  [`${SHAPE("x")}\n${REQ}\n${USER("y")}\n`, "max_tokens"],
  // A real later hit isn't masked; a blob before the real line isn't either.
  [`${SHAPE("marmalade free")}\n${USER("marmaladeword here")}\n`, "marmalade"],
  [`${BLOB("wombatgrove setup")}\n${REQ}\n${USER("tell me about the wombatgrove setup")}\n`, "wombatgrove"],
  // The marker as escaped string content is not the key.
  [`${USER('\\"type\\":\\"api-request and wombat')}\n`, "wombat"],
  // The marker anywhere on the line counts, and only unescaped.
  ['{"a":1,"type":"api-request","b":"wombat"}\n', "wombat"],
  [`${SHAPE("only here")}\n${BLOB("only here")}\n`, "only here"],
  // A skipped last line with no trailing newline ends the walk.
  ['{"type":"api-request","b":"q"}', "q"],
  // The window would reach into the neighbouring entries.
  [`${SHAPE(R(80, "s"))}\n${USER("xyzzy")}\n${SHAPE(R(80, "t"))}\n`, "xyzzy"],
  [`${SHAPE("s")}\n${USER(`${R(80, "a")}MID${R(80, "b")}`)}\n`, "mid"],
  // A huge dump costs one skip.
  [`${SHAPE(`${R(3000, "p")}bigprompt`)}\n${USER("bigword after it")}\n`, "bigword"],
  [`${SHAPE(`${R(3000, "p")}bigprompt`)}\n${USER("bigword after it")}\n`, "bigprompt"],
  // Matches that cross a newline, and one on the newline itself.
  [`${USER("one")}\n${USER("two")}\n`, '"}}\n{"'],
  [`${SHAPE("tail")}\n${USER("head")}\n`, '}}\n{"type":"user"'],
  ["ab\ncd", "\nc"],
  // CRLF: the \r belongs to the line.
  [`${USER("crlf")}\r\n${SHAPE("x")}\r\n`, "crlf"],
  // Every line is a key the marker's prefix covers, in turn.
  [`${REQ}\n${SHAPE("dup")}\n${BLOB("dup")}\n${USER("dup")}\n`, "dup"],
  // The marker is matched case-sensitively, the query isn't.
  ['{"TYPE":"API-REQUEST","b":"wombat"}\n', "wombat"],
  [`${SHAPE("hit")}\n`, "API-REQUEST"],
];
for (const [text, q] of api) pure.push(pureCase(text, q));

function mulberry32(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261027);
const pick = (xs) => xs[Math.floor(rand() * xs.length)];
// Case-variant classes: text tokens come from a class, query tokens are a
// random member of the same class (or a random token).
const CLASSES = [
  ["a", "A"],
  ["b", "B"],
  ["s", "S", "\u017f"],
  ["k", "K", "\u212a"],
  ["i", "I", "\u0130", "\u0131"],
  ["\u00df", "\u1e9e", "ss", "SS"],
  ["\u03c3", "\u03c2", "\u03a3"],
  ["\u00b5", "\u03bc", "\u039c"],
  ["\u00ff", "\u0178"],
  ["\u01c4", "\u01c5", "\u01c6"],
  ["\u13a0", "\uab70"],
  ["\ud801\udc00", "\ud801\udc28"],
  [EMOJI],
  ["\ufb01", "fi", "FI"],
  ["\u0345", "\u03b9", "\u0399", "\u1fbe"],
  ["\u0390", "\u1fd3"],
  ["\u10d0", "\u1c90"],
  ["\u00e0", "\u00c0"],
  [" ", "\u00a0", "\t", "\u0085"],
  ["\\n", "\\\\", "\\\"", "\\"],
  ['"', "{", "}", ":", ","],
];
const LATIN = [
  ["a", "A"],
  ["s", "S", "\u017f"],
  ["k", "K", "\u212a"],
  ["\u00df", "\u1e9e"],
  ["\u00b5", "\u03bc", "\u039c"],
  ["\u00ff", "\u0178"],
  ["\u00e0", "\u00c0"],
  ["\u00e9", "\u00c9"],
  [" ", "\u00a0", "\\n"],
];
const isLatin1 = (s) => [...s].every((ch) => ch.charCodeAt(0) < 0x100);
function randomCase(classes, maxLen, latinText) {
  const textClasses = latinText ? classes.map((c) => c.filter(isLatin1)).filter((c) => c.length) : classes;
  const n = Math.floor(rand() * maxLen);
  const toks = [];
  for (let i = 0; i < n; i++) {
    const k = Math.floor(rand() * textClasses.length);
    toks.push([k, pick(textClasses[k])]);
  }
  let q = "";
  if (toks.length && rand() < 0.75) {
    const i = Math.floor(rand() * toks.length);
    const j = Math.min(toks.length, i + 1 + Math.floor(rand() * 4));
    for (let t = i; t < j; t++) {
      const cls = latinText ? classes.find((c) => c.includes(toks[t][1])) : classes[toks[t][0]];
      q += pick(cls);
    }
  } else {
    const m = 1 + Math.floor(rand() * 3);
    for (let t = 0; t < m; t++) q += pick(pick(classes));
  }
  return [toks.map((t) => t[1]).join(""), q];
}
for (let i = 0; i < 1200; i++) pure.push(pureCase(...randomCase(CLASSES, 30, false)));
for (let i = 0; i < 150; i++) pure.push(pureCase(...randomCase(CLASSES, 220, false)));
for (let i = 0; i < 500; i++) pure.push(pureCase(...randomCase(LATIN, 30, true)));

// ---------------------------------- worlds ----------------------------------

const enc = (parts) =>
  Buffer.concat(
    parts.map((p) =>
      typeof p === "string" ? Buffer.from(p, "utf8") : p.hex !== undefined ? Buffer.from(p.hex, "hex") : Buffer.from(p.rep.repeat(p.n), "utf8"),
    ),
  );
/** A CLI-like transcript line, as JSON.stringify writes it, then a newline. */
const line = (type, text, extra = {}) => `${JSON.stringify({ type, message: { role: type, content: text }, ...extra })}\n`;
const sid = (n) => `a0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
let tick = 1_700_000_000;
const file = (name, parts, opts = {}) => ({ name, kind: "file", parts, mtime: opts.mtime ?? tick++, mode: opts.mode });
const link = (name, target) => ({ name, kind: "link", target });
const dirent = (name, opts = {}) => ({ name, kind: "dir", mtime: opts.mtime ?? tick++ });

const META = "price $5.00 (approx) [tag] a+b*c? ^start end$ {1} pipe|bar back\\d";
const outside = [
  { path: "outside", kind: "dir" },
  { path: "outside/secret.txt", kind: "file", parts: [line("user", "hello from outside the base")], mtime: 1_700_000_500 },
  { path: "outside-dir", kind: "dir" },
  { path: `outside-dir/${sid(900)}.jsonl`, kind: "file", parts: [line("user", "linked base hello")], mtime: 1_700_000_600 },
  { path: "outside-dir/note.txt", kind: "file", parts: ["hello"], mtime: 1_700_000_601 },
];

const worlds = [];
const world = (label, dir, entries, opts = {}) => worlds.push({ label, dir, base: opts.base ?? "dir", target: opts.target, mode: opts.mode, entries });

world("basic", "/golden/basic", [
  file(`${sid(1)}.jsonl`, [line("user", "Hello World, hello again"), line("assistant", "The needle is here.")]),
  file(`${sid(2)}.jsonl`, [line("user", "Another HELLO, a new line\nand a\ttab")], { mtime: 1_700_000_200 }),
  file(`${sid(3)}.jsonl`, [line("user", 'He said "quote" and a\\backslash\\nnot a newline')], { mtime: 1_700_000_050 }),
  file("Tie-b.jsonl", [line("user", "tiepoint b")], { mtime: 1_700_000_300 }),
  file("tie-c.jsonl", [line("user", "tiepoint c")], { mtime: 1_700_000_300 }),
  file("tie-a.jsonl", [line("user", "tiepoint a")], { mtime: 1_700_000_300 }),
  // 21 and 22 ulps past 9e9 s: 40 054 and 41 961 ns, one `mtimeMs` double.
  file("far-a.jsonl", [line("user", "farpoint a")], { mtime: 9e9 + 21 * 2 ** -19 }),
  file("far-b.jsonl", [line("user", "farpoint b")], { mtime: 9e9 + 22 * 2 ** -19 }),
  file("bad.name.jsonl", [line("user", "hello bad name")]),
  file("-lead.jsonl", [line("user", "hello lead dash")]),
  file("_lead.jsonl", [line("user", "hello lead underscore")]),
  file(".jsonl", [line("user", "hello no id")]),
  file("sp ace.jsonl", [line("user", "hello space")]),
  file("\u00fcni.jsonl", [line("user", "hello unicode name")]),
  file("x.jsonl.bak", [line("user", "hello backup")]),
  file("UPPER.JSONL", [line("user", "hello upper ext")]),
  file("notes.txt", ["hello notes"]),
  dirent("dirent.jsonl"),
  file("locked.jsonl", [line("user", "hello locked")], { mode: 0o000 }),
  link("linked.jsonl", "../../../outside/secret.txt"),
  link("dangling.jsonl", "/nonexistent-claudius-golden/x.jsonl"),
  file("empty.jsonl", []),
  file("bom.jsonl", ["\ufeff", "hello bom first\r\n", line("user", "crlf line").replace("\n", "\r\n")]),
  file("old.jsonl", [line("user", "hello ancient 1960")], { mtime: -315_619_200 }),
  file("epoch.jsonl", [line("user", "hello epoch")], { mtime: 0 }),
  file("latin1.jsonl", [line("user", "caf\u00e9 \u00ff \u00b5 only latin-1 \u00df")]),
  file("invalid-utf8.jsonl", ['{"type":"user","message":{"content":"bad ', { hex: "ff20e282" }, ' bytes then hello"}}\n']),
  file("meta.jsonl", [line("assistant", META)]),
  file("ok_id-1.jsonl", [line("user", "plain id with underscore hello")]),
]);

// More than MAX_FILES: three invalid names take the newest slots, so the
// 600th scanned file is m0007 and m0006 is the first one cut.
const many = [];
for (let i = 0; i < 604; i++) {
  const words = ["common", `row${i}`];
  if (i === 7) words.push("rank599");
  if (i === 6) words.push("rank600");
  many.push(file(`m${String(i).padStart(4, "0")}.jsonl`, [line("user", words.join(" "))], { mtime: 1_600_000_000 + i }));
}
for (const name of ["x.y.jsonl", "-z.jsonl", "_w.jsonl"]) many.push(file(name, [line("user", "common invalid")], { mtime: 1_650_000_000 }));
// Newer still, but not `.jsonl` names: no slot. A dangling link is mtime 0.
for (const name of ["y.jsonl.bak", "z.JSONL", "jsonl"]) many.push(file(name, [line("user", "common other")], { mtime: 1_660_000_000 }));
many.push(link("dangling.jsonl", "/nonexistent-claudius-golden/many.jsonl"));
world("many", "/golden/many", many);

// Bigger than node's 512 KiB read chunk (`readFile` decodes chunk by chunk
// with a StringDecoder): bytes across the first and second chunk edges.
const CHUNK = 512 * 1024;
const bigHead = '{"type":"user","message":{"content":"';
const byteLen = (p) => (typeof p === "string" ? Buffer.byteLength(p) : p.hex.length / 2);
function big(marker, edge) {
  const at = CHUNK - Math.floor(byteLen(edge) / 2);
  const afterEdge = at + byteLen(edge) + marker.length;
  return [
    bigHead,
    { rep: "x", n: at - bigHead.length },
    edge,
    marker,
    { rep: "y", n: 2 * CHUNK - 1 - afterEdge },
    "\u20ac",
    `${marker}TWO`,
    { rep: "z", n: 1000 },
    '"}}\n',
  ];
}
world("big", "/golden/big", [
  file("big-emoji.jsonl", big("MATCHA", EMOJI)),
  file("big-truncated.jsonl", big("MATCHB", { hex: "e282" })),
  file("big-lone.jsonl", big("MATCHC", { hex: "80bf" })),
  file("big-split3.jsonl", big("MATCHD", { hex: "f09f98" })),
]);

world("edges", "/golden/edges", [
  file("start.jsonl", ["HEADWORD and more text after it"]),
  file("end.jsonl", [`${R(100, "e")} TAILWORD`]),
  file("exact.jsonl", [`${R(60, "p")}EXACTWORD${R(60, "q")}`]),
  file("surr.jsonl", [`${R(3, "x")}${EMOJI}${R(59, "y")}SURRWORD${R(59, "z")}${EMOJI}${R(5, "w")}`]),
  file("ws.jsonl", [" \t\r\n WSWORD \u00a0\u3000\ufeff end\u0085 \u2028 "]),
  file("fold.jsonl", [line("user", "\u03a3\u039f\u03a3 stra\u00dfe \u0130stanbul \u212a \u017f \ud801\udc00 \uab70 \u10d0 \u01c5")]),
  file("ctrl.jsonl", ["CTRLWORD \u0001\u0008\u001f\u007f raw controls"]),
]);

// CC 2.1.300 -- the engine's request-capture entries, in the shapes a real
// 2.1.300 transcript carries them in.
const shapeLine = (system, extra = {}) =>
  `${JSON.stringify({
    type: "api-request-shape",
    sessionId: "s",
    shapeHash: "h1",
    timestamp: "2026-10-14T00:00:00.000Z",
    version: "2.1.300",
    shape: {
      system: [{ type: "text", text: system }],
      tools: [{ name: "Bash", description: "Executes a bash command in a persistent shell.", input_schema: { type: "object" } }],
      ...extra,
    },
  })}\n`;
const blobLine = (text) =>
  `${JSON.stringify({ type: "api-request-blob", sessionId: "s", hash: "b1", message: { role: "user", content: [{ type: "text", text }] } })}\n`;
const reqLine = `${JSON.stringify({
  type: "api-request",
  sessionId: "s",
  id: "r1",
  version: "2.1.300",
  shapeHash: "h1",
  params: { model: "claude-opus-4-7", max_tokens: 32000, output_config: { effort: "high" } },
})}\n`;
world("api-request", "/golden/api", [
  file(`${sid(20)}.jsonl`, [
    shapeLine("You are Claude Code. Be zephyrine about conventions."),
    blobLine("an earlier request mentioned nothing interesting"),
    reqLine,
    line("user", "please refactor the quokkaville module"),
    line("assistant", "Sure, refactoring now."),
  ]),
  file(`${sid(21)}.jsonl`, [
    shapeLine("Always prefer marmalade-free solutions when possible."),
    reqLine,
    line("user", "hello"),
    line("assistant", "The marmaladeword appears here in a real reply."),
  ]),
  // A blob repeating the user's words sits before the real user line.
  file(`${sid(22)}.jsonl`, [blobLine("tell me about the wombatgrove setup"), reqLine, line("user", "tell me about the wombatgrove setup")]),
  // A 60 KiB dump: one skip, then the hit on the next line.
  file(`${sid(23)}.jsonl`, [shapeLine(`${R(60000, "p")} bigprompt`), line("user", "bigword after the dump")]),
  // Every match is inside a skipped line.
  file(`${sid(24)}.jsonl`, [shapeLine("onlyapi here"), blobLine("onlyapi again"), reqLine]),
  // A skipped line last, with no trailing newline.
  file(`${sid(25)}.jsonl`, [line("user", "before"), '{"type":"api-request-blob","hash":"b2","message":"lastapi"}']),
  // The marker as escaped string content, which is not the JSON key.
  file(`${sid(26)}.jsonl`, [line("user", 'escapedmarker "type":"api-request inside a value')]),
  // The hit's line is the longest: the snippet is clamped on both sides.
  file(`${sid(27)}.jsonl`, [shapeLine("s"), line("user", `${R(80, "a")}CLAMPWORD${R(80, "b")}`), shapeLine("t")]),
], );

world("unicode-dir", `/tmp/${EMOJI} x`, [file(`${sid(10)}.jsonl`, [line("user", "unicode dir hello")])]);
world("traversal", "../../etc", [file(`${sid(11)}.jsonl`, [line("user", "escapee hello")])]);
world("slash", "/", [file(`${sid(12)}.jsonl`, [line("user", "slash dir hello")])]);
world("perm-none", "/golden/perm-none", [file(`${sid(13)}.jsonl`, [line("user", "hello perm")])], { mode: 0o000 });
world("perm-r", "/golden/perm-r", [file(`${sid(14)}.jsonl`, [line("user", "hello perm")])], { mode: 0o444 });
world("perm-x", "/golden/perm-x", [file(`${sid(15)}.jsonl`, [line("user", "hello perm")])], { mode: 0o111 });
world("base-file", "/golden/base-file", [], { base: "file" });
world("base-link", "/golden/base-link", [], { base: "link", target: "../../outside-dir" });

// Materialize: outside files, then each world; times, then modes.
function nsOf(p) {
  return statSync(p, { bigint: true }).mtimeNs.toString();
}
/** utimes to `t` seconds (node reads a negative number as "now"; a Date isn't). */
function setTime(p, t) {
  const at = t < 0 ? new Date(t * 1000) : t;
  utimesSync(p, at, at);
}
mkdirSync(PROJECTS, { recursive: true });
for (const o of outside) {
  const p = join(HOME, o.path);
  if (o.kind === "dir") mkdirSync(p, { recursive: true });
  else {
    writeFileSync(p, enc(o.parts));
    setTime(p, o.mtime);
    o.mtimeNs = nsOf(p);
  }
}
for (const w of worlds) {
  w.encoded = encodeProjectDir(w.dir);
  const base = join(PROJECTS, w.encoded);
  if (projectRoot(w.dir) !== base) throw new Error(`projectRoot(${w.dir}) moved`);
  if (w.base === "file") writeFileSync(base, "not a folder");
  else if (w.base === "link") symlinkSync(w.target, base);
  else mkdirSync(base);
  for (const e of w.entries) {
    const p = join(base, e.name);
    if (e.kind === "link") symlinkSync(e.target, p);
    else {
      if (e.kind === "dir") mkdirSync(p);
      else writeFileSync(p, enc(e.parts));
      setTime(p, e.mtime);
      e.mtimeNs = nsOf(p);
    }
    delete e.mtime;
  }
}
for (const w of worlds) {
  const base = join(PROJECTS, w.encoded);
  for (const e of w.entries) if (e.mode !== undefined) chmodSync(join(base, e.name), e.mode);
  if (w.mode !== undefined) chmodSync(base, w.mode);
}
// far-a / far-b: distinct nanoseconds, one `mtimeMs`.
{
  const [a, b] = ["far-a", "far-b"].map((n) => statSync(join(PROJECTS, encodeProjectDir("/golden/basic"), `${n}.jsonl`), { bigint: true }));
  const ms = ["far-a", "far-b"].map((n) => statSync(join(PROJECTS, encodeProjectDir("/golden/basic"), `${n}.jsonl`)).mtimeMs);
  if (a.mtimeNs === b.mtimeNs || ms[0] !== ms[1]) throw new Error(`far-a/far-b: ${a.mtimeNs} ${b.mtimeNs} ${ms}`);
}

// ----------------------------------- steps ----------------------------------

const qs = (pairs) => pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
const steps = [];
async function get(query) {
  const url = `http://localhost/api/sessions/search${query === null ? "" : `?${query}`}`;
  const sp = new URL(url).searchParams;
  const step = { query, params: { q: sp.get("q"), dir: sp.get("dir"), limit: sp.get("limit") } };
  try {
    const res = await route.GET(new Request(url));
    step.got = { status: res.status, type: res.headers.get("content-type"), body: await res.text() };
  } catch (e) {
    step.got = { threw: e instanceof Error ? e.message : String(e) };
  }
  steps.push(step);
}
const search = (q, dir, more = []) => get(qs([["q", q], ["dir", dir], ...more]));

// Validation, before any folder is read.
for (const raw of [
  null,
  "",
  "q=",
  "q=%20%20",
  "q=%E3%80%80%EF%BB%BF%09",
  "q=%C2%85",
  "q=x",
  "q=x&dir=",
  "dir=%2Fgolden%2Fbasic",
  "q=%20&dir=%2Fgolden%2Fbasic",
  "q=hello&dir=&dir=%2Fgolden%2Fbasic",
  "Q=hello&dir=%2Fgolden%2Fbasic",
  "q=hello&DIR=%2Fgolden%2Fbasic",
  "q=hello&dir=/golden/basic",
  "q=hello+world&dir=/golden/basic",
  "q=hello%2Bworld&dir=/golden/basic",
  "q=hello&q=needle&dir=/golden/basic",
  "q=%ZZ&dir=/golden/basic",
  "q=%FF&dir=/golden/basic",
  "q=%EF%BF%BD&dir=/golden/basic",
  "q=%E2%82&dir=/golden/basic",
  "dir=/golden/basic&q=needle&limit=1&limit=5",
]) {
  await get(raw);
}

const BASIC = "/golden/basic";
for (const q of [
  "hello",
  "HELLO",
  "hElLo",
  "needle",
  "tiepoint",
  "farpoint",
  "point",
  '"',
  '"type"',
  '"type":"user"',
  "\\",
  "\\n",
  "\\\\",
  "quote",
  '"quote"',
  " hello",
  "hello ",
  "\thello",
  "outside",
  "ancient",
  "epoch",
  "bom",
  "\ufeffhello",
  "crlf",
  "\r\n",
  "\u0178",
  "\u039c",
  "\u03bc",
  "CAF\u00c9",
  "\u1e9e",
  "\u00df",
  "SS",
  "bad ",
  "\ufffd",
  "\ufffd bytes",
  ".",
  ".*",
  "$5.00",
  "(approx)",
  "[tag]",
  "a+b*c?",
  "^start",
  "end$",
  "{1}",
  "pipe|bar",
  "\\d",
  "a.b",
  "(a+)+$",
  "underscore",
  "unicode name",
  "no id",
  "locked",
  "backup",
  "zzz-not-there",
]) {
  await search(q, BASIC);
}
for (const limit of ["1", "2", "2.5", "0", "-1", "abc", "", "1e3", " 2 ", "0x2", "Infinity", "-Infinity", "1e-9", "3."]) {
  await search("hello", BASIC, [["limit", limit]]);
}

const MANY = "/golden/many";
for (const [q, limit] of [
  ["common", null],
  ["common", "200"],
  ["common", "201"],
  ["common", "7.5"],
  ["rank599", null],
  ["rank600", null],
  ["row603", null],
  ["row0", null],
  ["invalid", null],
  ["ROW1", "3"],
]) {
  await search(q, MANY, limit === null ? [] : [["limit", limit]]);
}

for (const q of ["matcha", "MATCHATWO", "matchb", "matchbtwo", "matchc", "matchctwo", "matchd", "matchdtwo", "\u20acMATCHA", `${EMOJI}matcha`, "\ufffdmatchb", "zzzz"]) {
  await search(q, "/golden/big");
}

for (const q of [
  "headword",
  "tailword",
  "exactword",
  "surrword",
  "wsword",
  "\u03c3\u03bf\u03c2",
  "STRASSE",
  "STRA\u00dfE",
  "istanbul",
  "\u0130STANBUL",
  "k \u017f",
  "\u212a \u017f",
  "\ud801\udc28",
  "\ud801\udc00",
  "\u13a0",
  "\u1c90",
  "\u01c4",
  "\u01c6",
  "ctrlword",
  "\u0001",
]) {
  await search(q, "/golden/edges");
}

for (const q of [
  "zephyrine",
  "persistent shell",
  "max_tokens",
  "quokkaville",
  "marmalade",
  "marmaladeword",
  "wombatgrove",
  "bigprompt",
  "bigword",
  "onlyapi",
  "lastapi",
  "escapedmarker",
  "clampword",
  "api-request",
  '"type":"api-request',
  '"type"',
  "shapeHash",
  "2.1.300",
  "hello",
  "Executes a bash command",
]) {
  await search(q, "/golden/api");
}

for (const [q, dir] of [
  ["hello", `/tmp/${EMOJI} x`],
  ["hello", "/tmp/\ud83d\ude01 x"],
  ["escapee", "../../etc"],
  ["escapee", "/../../etc"],
  ["escapee", ".:/.\\-etc"],
  ["hello", "/"],
  ["hello", "\u0000"],
  ["hello", "."],
  ["hello", "\u00e9"],
  ["hello", "/golden/perm-none"],
  ["hello", "/golden/perm-r"],
  ["hello", "/golden/perm-x"],
  ["hello", "/golden/base-file"],
  ["hello", "/golden/base-link"],
  ["hello", "/golden/missing"],
  ["hello", `/${R(300, "d")}`],
  ["hello", "/GOLDEN/BASIC-not"],
]) {
  await search(q, dir);
}

// ---------------------------------- output ----------------------------------

const fixture = {
  node: process.version,
  icu: process.versions.icu,
  unicode: process.versions.unicode,
  radius: RADIUS,
  canon: { twoByte, oneByte },
  pure,
  outside,
  worlds,
  steps,
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(fixture, null, 1)}\n`);
console.log(
  `wrote ${out}: ${twoByte.length} + ${oneByte.length} canon units, ${pure.length} pure, ${worlds.length} worlds, ${steps.length} steps`,
);
process.exit(0);
