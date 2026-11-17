#!/usr/bin/env node
// Golden fixture for session titles (S23): the legacy title JSON fallback of
// `getSessionTitle` (lib/server/sessions-db.ts: `readLegacyTitle` and the
// row migration), `resolveSessionTitle` and the two places session.ts reads
// the title through it (lib/server/session.ts).
//
//   node rust/scripts/session-titles-golden.mjs     (node@22: session.ts needs
//                                                    better-sqlite3)
//
// Re-runs itself under `--experimental-transform-types` with HOME and
// CLAUDE_CONFIG_DIR in a temp root and a resolve hook for the `@/` and
// extensionless imports, twice (two temp roots); both recordings must agree
// byte for byte. Every case builds its own world first: a project cwd, the
// legacy `~/.claude/.claudius/session-titles.json` (text, raw bytes, a
// directory, an unreadable file, symlinks, or none), a seeded `sessions` row
// (fixed times), a transcript for the SDK's `getSessionInfo`, or a database
// file that isn't one. Then it records:
//
// - `resolve`: `resolveSessionTitle({ local, info })`.
// - `get`: `getSessionTitle(cwd, id)` twice (`result`, `second`), and the row
//   afterwards (`row`; `seed` is the row the case started with).
// - `start`: `start()`'s title statements (the `if (this.resumeFrom)` branch
//   and its `else`), read out of session.ts as text and run with `this` set
//   to a stand-in: the `title` they leave, the `pendingTitleMirror` the fresh
//   branch seeds (CC 2.1.309), and the row.
// - `fresh`: the real `Session.prototype.sendFreshTitle` on a bare session:
//   what it broadcast, what it sent the one subscriber, the `title` it left,
//   and the row once its fire-and-forget `upsertSession` has landed.
// - `set`: `setSessionTitle(cwd, id, title)` over a seeded row or none, and
//   the row afterwards.
// - `sdkRename`: the SDK's `renameSession(id, title, { dir })` on a
//   transcript: what it appended, or the error's message.
// - `rename`: the real `Session.prototype.rename(title)` on a bare session
//   with no transcript: its result, the `title` it left, its broadcasts.
//
// Values are `JSON.stringify` text (`null` for `undefined`); a call that
// throws is `{"throws":true}`. Rows read `quote()`d `model`, the title's
// `typeof` and `hex`, times stamped during the case as "$NOW", and the
// temp root as "$ROOT". The legacy file must come out byte for byte as it
// went in: nothing writes it.
//
// Written to rust/crates/claudius-core/tests/fixtures/session_titles_golden.json
// and replayed by crates/claudius-core/tests/session_titles_golden.rs.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "crates/claudius-core/tests/fixtures/session_titles_golden.json");

if (!process.env.SESSION_TITLES_GOLDEN_CHILD) {
  const runs = [0, 1].map(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "session-titles-golden-")));
    try {
      mkdirSync(join(root, "home"));
      mkdirSync(join(root, "config"));
      const r = spawnSync(
        process.execPath,
        ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url)],
        {
          // `openDb` reads its migrations from `process.cwd()`.
          cwd: repo,
          encoding: "utf8",
          maxBuffer: 1 << 26,
          env: {
            PATH: process.env.PATH,
            HOME: join(root, "home"),
            CLAUDE_CONFIG_DIR: join(root, "config"),
            SESSION_TITLES_GOLDEN_CHILD: root,
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
  console.log(
    `wrote ${out.slice(repo.length + 1)}: ${fixture.resolve.length} resolve, ${fixture.get.length} get, ` +
      `${fixture.start.length} start, ${fixture.fresh.length} fresh, ${fixture.set.length} set, ` +
      `${fixture.sdkRename.length} sdkRename, ${fixture.rename.length} rename (stable)`,
  );
  process.exit(0);
}

const ROOT_DIR = process.env.SESSION_TITLES_GOLDEN_CHILD;
const HOME = process.env.HOME;
const CONFIG = process.env.CLAUDE_CONFIG_DIR;

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

const { Session, resolveSessionTitle } = await import(join(repo, "lib/server/session.ts"));
const { getSessionTitle, setSessionTitle } = await import(join(repo, "lib/server/sessions-db.ts"));
const { openDb, projectRoot } = await import(join(repo, "lib/server/db.ts"));

// ------------------------- the real source, as text -------------------------

const src = readFileSync(join(repo, "lib/server/session.ts"), "utf8");
const once = (needle, what) => {
  const at = src.indexOf(needle);
  if (at < 0 || src.indexOf(needle, at + 1) >= 0) {
    throw new Error(`${what}: ${JSON.stringify(needle)} isn't in session.ts exactly once: update the recorder`);
  }
  return at;
};
// A `try { ... } catch { ... }` statement at six spaces, from its first line.
const tryBlock = (first, what) => {
  const a = once(first, what) - "      try {\n".length;
  if (src.slice(a, a + 12) !== "      try {\n") throw new Error(`${what}: not the first line of a try: update the recorder`);
  const c = src.indexOf("\n      } catch {", a);
  const b = src.indexOf("\n      }\n", c + 1);
  if (c < 0 || b < 0) throw new Error(`${what}: no catch after it: update the recorder`);
  return { at: a, text: src.slice(a, b + "\n      }\n".length) };
};
const resumeTry = tryBlock("        const local = await getSessionTitle(this.cwd, this.resumeFrom);\n", "start()'s resume title");
const freshTry = tryBlock("        const local = await getSessionTitle(this.cwd, this.id);\n", "start()'s fresh title");
// The resume statement ends the `if (this.resumeFrom)` branch whose `else`
// holds only the fresh one (and comments).
const between = src.slice(resumeTry.at + resumeTry.text.length, freshTry.at);
if (!/^ {4}\} else \{\n( *\/\/[^\n]*\n)*$/.test(between)) {
  throw new Error(`start()'s title branches changed shape:\n${between}`);
}
if (!src.slice(freshTry.at + freshTry.text.length).startsWith("    }\n")) {
  throw new Error("start()'s fresh title is no longer the last statement of its else: update the recorder");
}
const ifAt = src.lastIndexOf("\n    if (this.resumeFrom) {\n", resumeTry.at);
if (ifAt < 0 || src.slice(ifAt, resumeTry.at).includes("\n    }")) {
  throw new Error("start()'s resume title is no longer inside `if (this.resumeFrom)`: update the recorder");
}
for (const line of [
  /^import \{[^}]*\bgetSessionInfo,[^}]*\} from "@anthropic-ai\/claude-agent-sdk";$/m,
  /^import \{[^}]*\bgetSessionTitle,[^}]*\} from "\.\/sessions-db";$/m,
]) {
  if (!line.test(src)) throw new Error(`session.ts no longer has ${line}: update the recorder`);
}
const sdkUrl = pathToFileURL(join(repo, "node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs")).href;
const modPath = join(ROOT_DIR, "session-titles-extract.ts");
writeFileSync(
  modPath,
  [
    `import { getSessionInfo } from ${JSON.stringify(sdkUrl)};`,
    `import { getSessionTitle } from ${JSON.stringify(pathToFileURL(join(repo, "lib/server/sessions-db.ts")).href)};`,
    `import { resolveSessionTitle } from ${JSON.stringify(pathToFileURL(join(repo, "lib/server/session.ts")).href)};`,
    "export async function startTitle(self: any) {",
    "  await (async function (this: any) {",
    "    if (this.resumeFrom) {",
    resumeTry.text,
    "    } else {",
    freshTry.text,
    "    }",
    "  }).call(self);",
    "}",
    "",
  ].join("\n"),
);
const { startTitle } = await import(pathToFileURL(modPath).href);
const { renameSession } = await import(sdkUrl);

// --------------------------------- helpers ---------------------------------

const J = (v) => (v === undefined ? "null" : JSON.stringify(v));
const ch = (...codes) => String.fromCharCode(...codes);
const cp = (...codes) => String.fromCodePoint(...codes);
const BOM = ch(0xfeff);
const NEL = ch(0x85);
const NBSP = ch(0xa0);
const LS = ch(0x2028);
const IDEO = ch(0x3000);
const ZWSP = ch(0x200b);
const MVS = ch(0x180e);
const CRAB = cp(0x1f980);
const EACUTE = ch(0xe9);
const hex = (s) => Buffer.from(s, "utf8").toString("hex");

const LEGACY = join(HOME, ".claude", ".claudius", "session-titles.json");
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
let caseNo = 0;

// The legacy store as the dead `session-titles.ts` writer left it.
const store = (titles, extra = {}) => ({ text: JSON.stringify({ version: 1, titles, ...extra }, null, 2) });

function setLegacy(spec) {
  rmSync(dirname(LEGACY), { recursive: true, force: true });
  if (spec === undefined) return null;
  mkdirSync(dirname(LEGACY), { recursive: true });
  if (spec.dir) {
    mkdirSync(LEGACY);
    return null;
  }
  if (spec.symlink) {
    const target = join(dirname(LEGACY), "target.json");
    if (spec.symlink === "file") writeFileSync(target, Buffer.from(spec.text, "utf8"));
    symlinkSync(target, LEGACY);
    return null;
  }
  const bytes = spec.hex !== undefined ? Buffer.from(spec.hex, "hex") : Buffer.from(spec.text, "utf8");
  writeFileSync(LEGACY, bytes);
  if (spec.unreadable) chmodSync(LEGACY, 0);
  return bytes;
}

function checkLegacy(spec, bytes) {
  if (bytes) {
    if (spec.unreadable) chmodSync(LEGACY, 0o600);
    if (!readFileSync(LEGACY).equals(bytes)) throw new Error("the legacy file changed");
  }
  if (existsSync(dirname(LEGACY))) {
    const extra = readdirSync(dirname(LEGACY)).filter((n) => n !== "session-titles.json" && n !== "target.json");
    if (extra.length) throw new Error(`files appeared next to the legacy store: ${extra}`);
  }
}

async function seedRow(cwd, id, row, brokenDb) {
  if (brokenDb) {
    mkdirSync(projectRoot(cwd), { recursive: true });
    writeFileSync(join(projectRoot(cwd), ".claudius.db"), "this is not a database, just text\n".repeat(64));
    return;
  }
  if (row === undefined) return;
  const db = await openDb(cwd);
  // `titleHex`: a BLOB; `textHex`: TEXT holding those bytes, UTF-8 or not.
  const bytes = row.titleHex ?? row.textHex;
  const title = bytes !== undefined ? Buffer.from(bytes, "hex") : row.title;
  const value = row.textHex !== undefined ? "CAST(? AS TEXT)" : "?";
  db.prepare(
    `INSERT INTO sessions(id, cwd, title, model, created_at, updated_at, last_seen_at) VALUES (?, ?, ${value}, ?, 1000, 2000, 3000)`,
  ).run(id, "/seeded", title, row.model ?? null);
}

function writeTranscript(cwd, id, lines) {
  if (!lines) return;
  const enc = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  if (enc.length > 200) throw new Error("cwd too long for the plain SDK project-dir name");
  const dir = join(CONFIG, "projects", enc);
  mkdirSync(dir, { recursive: true });
  const body = lines.map((l) => l.replaceAll("$ID", id).replaceAll("$CWD", cwd)).join("\n") + "\n";
  writeFileSync(join(dir, `${id}.jsonl`), body);
}

async function readRow(cwd, id, t0, t1) {
  let r;
  try {
    const db = await openDb(cwd);
    r = db
      .prepare(
        "SELECT id, cwd, typeof(title) AS titleType, hex(title) AS titleHex, quote(model) AS model, created_at, updated_at, last_seen_at FROM sessions WHERE id = ?",
      )
      .get(id);
  } catch {
    return '"unreadable"';
  }
  if (!r) return "null";
  const time = (n) => (n >= t0 && n <= t1 ? "$NOW" : n);
  return J({
    id: r.id,
    cwd: r.cwd.startsWith(ROOT_DIR) ? rel(r.cwd) : r.cwd,
    titleType: r.titleType,
    titleHex: r.titleHex,
    model: r.model,
    created_at: time(r.created_at),
    updated_at: time(r.updated_at),
    last_seen_at: time(r.last_seen_at),
  });
}

const settle = () => new Promise((r) => setTimeout(r, 25));

// One case's world: a fresh cwd, the legacy file, the row, the transcript.
async function world(c) {
  const n = caseNo++;
  const cwd = join(ROOT_DIR, "p", String(n).padStart(3, "0"));
  mkdirSync(cwd, { recursive: true });
  const id = c.id ?? uuid(n);
  const bytes = setLegacy(c.legacy);
  await seedRow(cwd, id, c.row, c.brokenDb);
  writeTranscript(cwd, id, c.jsonl);
  return { cwd, id, bytes };
}
const rel = (p) => `$ROOT${p.slice(ROOT_DIR.length)}`;
const spec = (c) => ({
  legacy: c.legacy ?? null,
  seed: c.row ?? null,
  brokenDb: !!c.brokenDb,
  jsonl: c.jsonl ?? null,
});
const attempt = async (f) => {
  try {
    return J(await f());
  } catch {
    return '{"throws":true}';
  }
};

// --------------------------------- resolve ---------------------------------

const LOCALS = [
  undefined, null, "", " ", "Local", "  Local  ", BOM, `${BOM}x${BOM}`, NEL, `${NEL}x${NEL}`,
  `${NBSP}x${NBSP}`, LS, `${IDEO}x`, "\t\n\v\f\r", ZWSP, `${MVS}x`, "a  b", `${CRAB} crab `,
];
const INFOS = [
  undefined, null, {}, { customTitle: null }, { customTitle: "" }, { customTitle: "  Custom  " },
  { customTitle: BOM }, { customTitle: `${NEL}c` }, { customTitle: "\n" }, { summary: "Summary only" },
  { customTitle: " ", summary: "Summary" }, { customTitle: `${IDEO}${CRAB}${IDEO}` },
];
const resolveCases = [];
for (const local of LOCALS) {
  for (const info of INFOS) {
    resolveCases.push({ local: local ?? null, info: info ?? null, result: J(resolveSessionTitle({ local, info })) });
  }
}

// ----------------------------------- get -----------------------------------

const GET = [
  ["no row, no legacy file", {}],
  ["the row wins over the legacy file", { row: { title: "DB title" }, legacy: store({ $: "Legacy" }) }],
  ["the row is returned untrimmed", { row: { title: "  DB  " } }],
  ["a whitespace row is truthy", { row: { title: "   " }, legacy: store({ $: "Legacy" }) }],
  ["a BOM row is truthy", { row: { title: BOM }, legacy: store({ $: "Legacy" }) }],
  ["a NULL row title takes the legacy one", { row: { title: null, model: "m" }, legacy: store({ $: "Legacy" }) }],
  ["an empty row title takes the legacy one", { row: { title: "" }, legacy: store({ $: "Legacy" }) }],
  ["no row: the legacy title is inserted", { legacy: store({ $: "Legacy", other: "Other" }) }],
  ["the legacy title is kept untrimmed", { legacy: store({ $: "  padded  " }) }],
  ["a NULL row and no legacy file", { row: { title: null } }],
  ["a NULL row and the id not in the file", { row: { title: null }, legacy: store({ other: "Other" }) }],
  ["no version", { legacy: { text: '{"titles":{"$":"No version"}}' } }],
  ["version 2", { legacy: store({ $: "Version 2" }, { version: 2 }) }],
  ["version as a string", { legacy: { text: '{"version":"1","titles":{"$":"String version"}}' } }],
  ["titles before version", { legacy: { text: '{"titles":{"$":"Order"},"version":1}' } }],
  ["titles null", { legacy: { text: '{"version":1,"titles":null}' } }],
  ["titles a number", { id: "0", legacy: { text: '{"version":1,"titles":5}' } }],
  ["titles true", { id: "0", legacy: { text: '{"version":1,"titles":true}' } }],
  ["titles an array, index 1", { id: "1", legacy: { text: '{"titles":["zero","one"]}' } }],
  ["titles an array, index 0", { id: "0", legacy: { text: '{"titles":["zero","one"]}' } }],
  ["titles an array, index 01", { id: "01", legacy: { text: '{"titles":["zero","one"]}' } }],
  ["titles an array, index 2", { id: "2", legacy: { text: '{"titles":["zero","one"]}' } }],
  ["titles an array, length", { id: "length", legacy: { text: '{"titles":["zero","one"]}' } }],
  ["titles an array, a number element", { id: "1", legacy: { text: '{"titles":["zero",1]}' } }],
  ["titles an array, a uuid id", { legacy: { text: '{"titles":["zero","one"]}' } }],
  ["titles a string, index 0", { id: "0", legacy: { text: '{"titles":"abc"}' } }],
  ["titles a string, index 2", { id: "2", legacy: { text: '{"titles":"abc"}' } }],
  ["titles a string, index 3", { id: "3", legacy: { text: '{"titles":"abc"}' } }],
  ["titles a string, length", { id: "length", legacy: { text: '{"titles":"abc"}' } }],
  ["titles a string, -0", { id: "-0", legacy: { text: '{"titles":"abc"}' } }],
  ["titles a string, 1.0", { id: "1.0", legacy: { text: '{"titles":"abc"}' } }],
  ["titles a string, +1", { id: "+1", legacy: { text: '{"titles":"abc"}' } }],
  ["titles a string, a space unit", { id: "0", legacy: { text: '{"titles":" a"}' } }],
  ["titles a string, after an astral character", { id: "2", legacy: { text: `{"titles":"${CRAB}x"}` } }],
  ["titles a string, a high surrogate", { id: "0", legacy: { text: `{"titles":"${CRAB}x"}` } }],
  ["titles a string, a low surrogate", { id: "1", legacy: { text: `{"titles":"${CRAB}x"}` } }],
  ["titles an object, __proto__ own key", { id: "__proto__", legacy: { text: '{"titles":{"__proto__":"Proto title"}}' } }],
  ["titles an object, __proto__ absent", { id: "__proto__", legacy: { text: '{"titles":{"a":"A"}}' } }],
  ["titles an object, constructor", { id: "constructor", legacy: { text: '{"titles":{"a":"A"}}' } }],
  ["titles an object, toString", { id: "toString", legacy: { text: '{"titles":{"a":"A"}}' } }],
  ["titles an object, hasOwnProperty", { id: "hasOwnProperty", legacy: { text: '{"titles":{}}' } }],
  ["titles a string, __proto__", { id: "__proto__", legacy: { text: '{"titles":"abc"}' } }],
  ["titles an object, index-like key", { id: "7", legacy: { text: '{"titles":{"7":"Seven","a":"A"}}' } }],
  ["value a number", { legacy: { text: '{"titles":{"$":5}}' } }],
  ["value true", { legacy: { text: '{"titles":{"$":true}}' } }],
  ["value null", { legacy: { text: '{"titles":{"$":null}}' } }],
  ["value an object", { legacy: { text: '{"titles":{"$":{"title":"x"}}}' } }],
  ["value an array", { legacy: { text: '{"titles":{"$":["x"]}}' } }],
  ["value empty", { legacy: store({ $: "" }) }],
  ["value whitespace", { legacy: store({ $: " \t\n " }) }],
  ["value a BOM", { legacy: store({ $: BOM }) }],
  ["value a NEL", { legacy: store({ $: NEL }) }],
  ["value an NBSP and text", { legacy: store({ $: `${NBSP}x` }) }],
  ["value a line separator", { legacy: store({ $: LS }) }],
  ["value an ideographic space", { legacy: store({ $: IDEO }) }],
  ["value a zero-width space", { legacy: store({ $: ZWSP }) }],
  ["value astral", { legacy: store({ $: `${CRAB} crab` }) }],
  ["value with a NUL", { legacy: store({ $: "a\u0000b" }) }],
  ["value with controls", { legacy: store({ $: "tab\there\nnext\u001f" }) }],
  ["value long", { legacy: store({ $: "long ".repeat(4000) }) }],
  ["value escaped", { legacy: { text: '{"titles":{"$":"Caf\\u00e9 \\"q\\" \\ud83e\\udd80 \\/"}}' } }],
  ["value a lone surrogate escape", { legacy: { text: '{"titles":{"$":"x\\ud800y"}}' } }],
  ["duplicate id: the last wins", { legacy: { text: '{"titles":{"$":"First","$":"Second"}}' } }],
  ["duplicate titles: the last wins", { legacy: { text: '{"titles":{"$":"First"},"titles":null}' } }],
  ["duplicate titles: the last object", { legacy: { text: '{"titles":null,"titles":{"$":"Second object"}}' } }],
  ["empty file", { legacy: { text: "" } }],
  ["whitespace file", { legacy: { text: " \r\n\t" } }],
  ["file null", { legacy: { text: "null" } }],
  ["file an array", { legacy: { text: '[{"titles":{"$":"x"}}]' } }],
  ["file a string", { legacy: { text: '"titles"' } }],
  ["file a number", { legacy: { text: "5" } }],
  ["file not JSON", { legacy: { text: '{"titles":{"$":"x"}' } }],
  ["file with a trailing comma", { legacy: { text: '{"titles":{"$":"x"},}' } }],
  ["file with a comment", { legacy: { text: '// c\n{"titles":{"$":"x"}}' } }],
  ["file with a BOM", { legacy: { text: `${BOM}{"titles":{"$":"BOM file"}}` } }],
  ["file CRLF", { legacy: { text: '{\r\n  "titles": {\r\n    "$": "CRLF"\r\n  }\r\n}\r\n' } }],
  ["file UTF-16LE", { id: "$", legacy: { hex: "fffe" + Buffer.from('{"titles":{"$":"utf16"}}', "utf16le").toString("hex") } }],
  ["file with invalid UTF-8 in the title", { id: "$", legacy: { hex: hex('{"titles":{"$":"a') + "ff" + hex("b") + "c3" + hex("c") + "eda080" + hex("d") + "f09f" + hex('e"}}') } }],
  ["file with invalid UTF-8 outside strings", { id: "$", legacy: { hex: hex('{"titles":{"$":"ok"}') + "ff" + hex("}") } }],
  ["file with a huge number", { legacy: { text: '{"version":1e400,"titles":{"$":"Huge version"}}' } }],
  ["file with a -0 version", { legacy: { text: '{"version":-0,"titles":{"$":"Minus zero"}}' } }],
  ["file nested 200 deep elsewhere", { legacy: { text: `{"deep":${"[".repeat(200)}${"]".repeat(200)},"titles":{"$":"Deep"}}` } }],
  ["file nested 100 deep elsewhere", { legacy: { text: `{"deep":${"[".repeat(100)}${"]".repeat(100)},"titles":{"$":"Not so deep"}}` } }],
  ["file a directory", { legacy: { dir: true } }],
  ["file unreadable", { legacy: { ...store({ $: "Unreadable" }), unreadable: true } }],
  ["file a symlink", { legacy: { symlink: "file", text: '{"titles":{"$":"Through a symlink"}}' } }],
  ["file a dangling symlink", { legacy: { symlink: "dangling" } }],
  ["a database that isn't one", { brokenDb: true, legacy: store({ $: "Legacy" }) }],
  ["a BLOB row title", { row: { titleHex: "6869" }, legacy: store({ $: "Legacy" }) }],
  ["an empty BLOB row title", { row: { titleHex: "" }, legacy: store({ $: "Legacy" }) }],
  ["a row title that isn't UTF-8", { row: { textHex: "61ff62" }, legacy: store({ $: "Legacy" }) }],
  ["a row title in WTF-8 (a lone surrogate a TS rename stored)", { row: { textHex: "78eda08079" } }],
  ["the id at the top level isn't a title", { legacy: { text: '{"titles":{"other":"Other"},"$":"Top level"}' } }],
];

// `$` in a legacy store's text stands for the case's id (raw-byte files use
// the id `$` itself).
const withId = (c, id) => {
  if (!c.legacy || c.legacy.text === undefined) return c.legacy;
  return { ...c.legacy, text: c.legacy.text.replaceAll('"$"', JSON.stringify(id)) };
};

const getCases = [];
for (const [name, c0] of GET) {
  const id = c0.id ?? uuid(caseNo);
  const c = { ...c0, id, legacy: withId(c0, id) };
  const t0 = Date.now();
  const { cwd, bytes } = await world(c);
  const result = await attempt(() => getSessionTitle(cwd, id));
  const second = await attempt(() => getSessionTitle(cwd, id));
  const t1 = Date.now();
  const row = await readRow(cwd, id, t0, t1);
  checkLegacy(c.legacy ?? {}, bytes);
  getCases.push({ name, id, cwd: rel(cwd), ...spec(c), result, second, row });
}

// ---------------------------------- start ----------------------------------

const userLine =
  '{"type":"user","uuid":"u1","parentUuid":null,"sessionId":"$ID","cwd":"$CWD","timestamp":"2026-01-02T03:04:05.000Z","message":{"role":"user","content":"the first prompt"}}';
const custom = (t) => JSON.stringify({ type: "custom-title", customTitle: t, sessionId: "$ID" });
const ai = (t) => JSON.stringify({ type: "ai-title", aiTitle: t, sessionId: "$ID" });

const START = [
  ["resume: nothing", { resume: true }],
  ["resume: the row wins over the SDK", { resume: true, row: { title: "DB" }, jsonl: [userLine, custom("Custom")] }],
  ["resume: the row is trimmed", { resume: true, row: { title: "  DB  " } }],
  ["resume: a whitespace row hides the SDK title", { resume: true, row: { title: "   " }, jsonl: [userLine, custom("Custom")] }],
  ["resume: a BOM row hides the SDK title", { resume: true, row: { title: BOM }, jsonl: [userLine, custom("Custom")] }],
  ["resume: the legacy title wins over the SDK", { resume: true, legacy: store({ $: "Legacy" }), jsonl: [userLine, custom("Custom")] }],
  ["resume: the legacy title is trimmed", { resume: true, legacy: store({ $: "  Legacy  " }) }],
  ["resume: a NEL legacy title", { resume: true, legacy: store({ $: NEL }) }],
  ["resume: a BOM legacy title falls through", { resume: true, legacy: store({ $: BOM }), jsonl: [userLine, custom("Custom")] }],
  ["resume: a NULL row takes the legacy title", { resume: true, row: { title: null }, legacy: store({ $: "Legacy" }), jsonl: [userLine, custom("Custom")] }],
  ["resume: the SDK custom title", { resume: true, jsonl: [userLine, custom("Custom")] }],
  ["resume: the SDK custom title is trimmed", { resume: true, jsonl: [userLine, custom("  Custom  ")] }],
  ["resume: the SDK AI title", { resume: true, jsonl: [userLine, ai("AI named")] }],
  ["resume: the custom title beats the AI title", { resume: true, jsonl: [userLine, custom("Custom"), ai("AI named")] }],
  ["resume: the last custom title", { resume: true, jsonl: [userLine, custom("First"), custom("Second")] }],
  ["resume: a BOM SDK title", { resume: true, jsonl: [userLine, custom(BOM)] }],
  ["resume: a NEL SDK title", { resume: true, jsonl: [userLine, custom(`${NEL}c${NEL}`)] }],
  ["resume: an escaped SDK title", { resume: true, jsonl: [userLine, custom(`Caf${EACUTE} "q" ${CRAB}`)] }],
  ["resume: never the summary", { resume: true, jsonl: [userLine] }],
  ["resume: a database that isn't one hides the SDK title", { resume: true, brokenDb: true, legacy: store({ $: "Legacy" }), jsonl: [userLine, custom("Custom")] }],
  ["resume: the resumed id, not this.id", { resume: true, otherId: true, legacy: store({ $: "Resumed" }) }],
  ["resume: the SDK title of the resumed id, not this.id", { resume: true, otherId: true, jsonl: [userLine, custom("Resumed custom")] }],
  ["resume: a row title that isn't UTF-8", { resume: true, row: { textHex: "eda0be" }, jsonl: [userLine, custom("Custom")] }],
  ["fresh: nothing", {}],
  ["fresh: the row", { row: { title: "DB" }, jsonl: [userLine, custom("Custom")] }],
  ["fresh: the row untrimmed", { row: { title: "  DB  " } }],
  ["fresh: a whitespace row", { row: { title: "   " } }],
  ["fresh: the legacy title, untrimmed", { legacy: store({ $: "  Legacy  " }) }],
  ["fresh: a NULL row takes the legacy title", { row: { title: null }, legacy: store({ $: "Legacy" }) }],
  ["fresh: never the SDK", { jsonl: [userLine, custom("Custom")] }],
  ["fresh: a database that isn't one", { brokenDb: true, legacy: store({ $: "Legacy" }) }],
];

const startCases = [];
for (const [name, c0] of START) {
  const id = uuid(caseNo);
  const c = { ...c0, id, legacy: withId(c0, id) };
  const t0 = Date.now();
  const { cwd, bytes } = await world(c);
  // `otherId`: this.id differs from the resumed id, which alone has the
  // legacy entry, the row and the transcript.
  const self = { cwd, id: c.otherId ? uuid(9000 + caseNo) : id, resumeFrom: c.resume ? id : undefined, title: undefined };
  await startTitle(self);
  const t1 = Date.now();
  const row = await readRow(cwd, id, t0, t1);
  checkLegacy(c.legacy ?? {}, bytes);
  // CC 2.1.309: the fresh branch also seeds the pending JSONL mirror.
  startCases.push({ name, id, thisId: self.id, cwd: rel(cwd), resume: !!c.resume, ...spec(c), title: J(self.title), mirror: J(self.pendingTitleMirror), row });
}

// ---------------------------------- fresh ----------------------------------

const FRESH = [
  ["nothing at all", {}],
  ["a current title is echoed", { current: "Kept" }],
  ["an empty current title is not echoed", { current: "" }],
  ["a row title is adopted", { row: { title: "DB", model: "m-old" }, model: "claude-new" }],
  ["the same title is echoed", { current: "DB", row: { title: "DB" } }],
  ["an untrimmed current title moves to the trimmed row", { current: "  DB  ", row: { title: "  DB  " } }],
  ["the SDK title moves an old one, and the row is inserted", { current: "Old", model: "claude-x", jsonl: [userLine, custom("Custom")] }],
  ["the legacy title is migrated and adopted", { legacy: store({ $: "Legacy" }) }],
  ["a database that isn't one reads as no row", { current: "Old", brokenDb: true, jsonl: [userLine, custom("Custom")] }],
  ["a whitespace row hides the SDK title", { current: "Old", row: { title: "   " }, jsonl: [userLine, custom("Custom")] }],
  ["a trimmed SDK title equal to the current one", { current: "Custom", jsonl: [userLine, custom("  Custom  ")] }],
  ["no model keeps the row's", { row: { title: "DB", model: "m-old" } }],
  ["the SDK AI title", { jsonl: [userLine, ai("AI named")] }],
  ["a BOM SDK title and no current one", { jsonl: [userLine, custom(BOM)] }],
  ["a NEL current title against a NEL row", { current: `${NEL}x`, row: { title: `${NEL}x` } }],
  ["a row title that isn't UTF-8", { current: "Old", row: { textHex: "61ff62" } }],
];

const freshCases = [];
for (const [name, c0] of FRESH) {
  const id = uuid(caseNo);
  const c = { ...c0, id, legacy: withId(c0, id) };
  const t0 = Date.now();
  const { cwd, bytes } = await world(c);
  const bare = Object.create(Session.prototype);
  const broadcasts = [];
  const sent = [];
  Object.assign(bare, { cwd, id, title: c.current, model: c.model });
  bare.broadcast = (ev) => broadcasts.push(ev);
  await bare.sendFreshTitle((ev) => sent.push(ev));
  await settle();
  const t1 = Date.now();
  const row = await readRow(cwd, id, t0, t1);
  checkLegacy(c.legacy ?? {}, bytes);
  freshCases.push({
    name,
    id,
    cwd: rel(cwd),
    current: c.current ?? null,
    model: c.model ?? null,
    ...spec(c),
    broadcasts: J(broadcasts),
    sent: J(sent),
    title: J(bare.title),
    row,
  });
}

// ------------------------------ set and rename ------------------------------

const TITLES = [
  "Plain", "  Set  ", BOM, `${BOM}x`, NEL, `${NEL}x${NEL}`, "", "   ", LS, `${IDEO}y${IDEO}`, ZWSP,
  "\t\n z \r", `${NBSP}${CRAB}${NBSP}`, "a\u0000b",
];

const setCases = [];
for (const title of TITLES) {
  for (const seeded of [true, false]) {
    const c = { id: uuid(caseNo), row: seeded ? { title: "Before" } : undefined };
    const t0 = Date.now();
    const { cwd } = await world(c);
    const result = await attempt(() => setSessionTitle(cwd, c.id, title));
    const t1 = Date.now();
    setCases.push({ name: `${J(title)}${seeded ? " over a row" : ""}`, id: c.id, cwd: rel(cwd), title, seed: c.row ?? null, result, row: await readRow(cwd, c.id, t0, t1) });
  }
}

const sdkRenameCases = [];
for (const [title, opts] of [
  ...TITLES.map((t) => [t, {}]),
  ["Not a uuid", { id: "not-a-uuid" }],
  ["No transcript", { noTranscript: true }],
]) {
  const c = { id: opts.id ?? uuid(caseNo), jsonl: opts.noTranscript ? undefined : [userLine] };
  const { cwd } = await world(c);
  const file = join(CONFIG, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${c.id}.jsonl`);
  const before = c.jsonl ? readFileSync(file, "utf8") : "";
  let result;
  try {
    await renameSession(c.id, title, { dir: cwd });
    result = J({ appended: readFileSync(file, "utf8").slice(before.length) });
  } catch (e) {
    result = J({ throws: String(e?.message).split(ROOT_DIR).join("$ROOT") });
  }
  sdkRenameCases.push({ name: J(title), id: c.id, cwd: rel(cwd), title, jsonl: c.jsonl ?? null, result });
}

const renameCases = [];
for (const title of TITLES) {
  const c = { id: uuid(caseNo) };
  const { cwd } = await world(c);
  const bare = Object.create(Session.prototype);
  const broadcasts = [];
  Object.assign(bare, { cwd, id: c.id, title: undefined });
  bare.broadcast = (ev) => broadcasts.push(ev);
  const result = await attempt(() => bare.rename(title));
  // CC 2.1.309: with no transcript and no engine, the name waits in the
  // pending mirror.
  renameCases.push({ name: J(title), id: c.id, cwd: rel(cwd), title, result, after: J(bare.title), mirror: J(bare.pendingTitleMirror), broadcasts: J(broadcasts) });
}

writeFileSync(
  join(ROOT_DIR, "out.json"),
  J({
    resolve: resolveCases,
    get: getCases,
    start: startCases,
    fresh: freshCases,
    set: setCases,
    sdkRename: sdkRenameCases,
    rename: renameCases,
  }),
);
process.exit(0);
