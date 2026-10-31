#!/usr/bin/env node
// Golden fixture for the settings error text (D10a): what the real
// `readSettings` / `writeSettings` (lib/server/settings.ts) resolve or throw
// on malformed files and unwritable paths, `sanitizeJsonParseReason`
// (lib/shared/settings-load-error.ts), the settings readers and writers in
// session.ts and the advisor route, and Node's own fs error text.
//
//   node rust/scripts/settings-errors-golden.mjs     (node@22: session.ts
//                                                     needs better-sqlite3)
//
// Re-runs itself under `--experimental-transform-types` with HOME and
// CLAUDE_CONFIG_DIR in a temp root and a resolve hook for the `@/` and
// extensionless imports, twice (two temp roots); both recordings must agree
// byte for byte. Refuses to run as root (the EACCES cases would read).
//
// Every file case starts from an empty `home/`, `project/` and `ext/` under
// the root (HOME is `home/`, the default project cwd is `project/`) and
// applies its `setup` ops in order: `dir` (mkdir -p), `file` (`text` or
// `hex` bytes), `symlink` (to `target`), `rm`, then every `chmod`. Records:
//
// - `errorMap`: `util.getSystemErrorMap()` as [errno, code, description],
//   and `unknown`: `getSystemErrorName` / `getSystemErrorMessage` of errnos
//   libuv doesn't map.
// - `fsErrors`: raw `fs.promises` failures (`op` and its `args`), each error
//   as `err` (below); on macOS also in a `chflags uchg` directory (EPERM).
// - `sanitize`: `sanitizeJsonParseReason(message)` on hand-written messages
//   (`message` -> `reason`), and on what `JSON.parse(text)` threw for a
//   corpus of malformed texts, hand-written and seeded fuzz (`text` ->
//   `message` -> `reason`).
// - `read`: `readSettings(scope, cwd)`: `value` (`type`: typeof, "null" or
//   "array"; `json`: `JSON.stringify(value)`, or `{stringifyThrows}`;
//   `spread`: `JSON.stringify({ ...value })`), or `throws`.
// - `write`: `writeSettings(scope, cwd, JSON.parse(next))`: `ok`, or
//   `throws`.
// - `callers`: the real `Session.prototype.setOutputStyle`,
//   `persistModelToUserSettings`, `enforceAdvisorModelCompatibility`,
//   `setPermissionMode` and `requestRecap` on a bare session object (no
//   query), and the real `POST /api/sessions/:id/advisor` handler with
//   `sessionManager` holding a stand-in session: what each returned or
//   threw, what it logged (`console.error` / `console.warn`), broadcast, or
//   left as the permission mode.
//
// Every file case also records `after`: the tree under the root once the
// call is done (each entry's type, mode, link target and content).
//
// Errors (`err`) carry `name`, `message`, `code`, `errno`, `syscall`,
// `path`, `dest` and a SettingsParseError's `reason`. Strings name the
// temp root "$ROOT" and a temp file's pid and counter "$PID" / "$SEQ"; a
// string that isn't well-formed UTF-16 is written as `{"units": [...]}`.
//
// Written to rust/crates/claudius-core/tests/fixtures/settings_errors_golden.json
// and replayed by crates/claudius-core/tests/settings_errors_golden.rs and
// crates/claudius-server/tests/settings_errors.rs.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { promises as fsp } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getSystemErrorMap, getSystemErrorMessage, getSystemErrorName } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "crates/claudius-core/tests/fixtures/settings_errors_golden.json");

// ------------------------------- recording -------------------------------

if (!process.env.SETTINGS_ERRORS_GOLDEN_CHILD) {
  if (process.getuid?.() === 0) throw new Error("run as a normal user: as root the EACCES cases would read");
  const runs = [0, 1].map(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "settings-errors-golden-")));
    try {
      mkdirSync(join(root, "config"));
      const r = spawnSync(
        process.execPath,
        ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url)],
        {
          cwd: repo,
          encoding: "utf8",
          maxBuffer: 1 << 28,
          env: {
            PATH: process.env.PATH,
            HOME: join(root, "home"),
            CLAUDE_CONFIG_DIR: join(root, "config"),
            SETTINGS_ERRORS_GOLDEN_CHILD: root,
          },
        },
      );
      if (r.status !== 0) {
        process.stderr.write(r.stderr);
        process.exit(r.status ?? 1);
      }
      return readFileSync(join(root, "out.json"), "utf8");
    } finally {
      unfreeze(root);
      chmodTree(root);
      rmSync(root, { recursive: true, force: true });
    }
  });
  if (runs[0] !== runs[1]) {
    if (process.env.SETTINGS_ERRORS_GOLDEN_DUMP) {
      runs.forEach((r, i) => writeFileSync(`${process.env.SETTINGS_ERRORS_GOLDEN_DUMP}.${i}.json`, r));
    }
    throw new Error("the two recordings differ");
  }
  const fixture = JSON.parse(runs[0]);
  writeFileSync(out, `${JSON.stringify(fixture, null, 1)}\n`);
  console.log(
    `wrote ${out.slice(repo.length + 1)}: ${fixture.errorMap.length} errno, ${fixture.fsErrors.length} fs errors, ` +
      `${fixture.sanitize.messages.length} + ${fixture.sanitize.parsed.length} sanitize, ${fixture.read.length} read, ` +
      `${fixture.write.length} write, ${fixture.callers.length} callers (stable)`,
  );
  process.exit(0);
}

/** `chflags uchg` (macOS): a user-immutable directory. */
function freeze(p, on = true) {
  const r = spawnSync("chflags", [...(on ? [] : ["-R"]), on ? "uchg" : "nouchg", p]);
  if (r.status !== 0) throw new Error(`chflags ${p}: ${r.stderr}`);
}

/** Clears `freeze` under `p`, so it can go. */
function unfreeze(p) {
  if (process.platform === "darwin") freeze(p, false);
}

/** Makes every dir under `p` searchable and writable again, so it can go. */
function chmodTree(p) {
  let st;
  try {
    st = lstatSync(p);
  } catch {
    return;
  }
  if (!st.isDirectory()) return;
  chmodSync(p, 0o755);
  for (const name of readdirSync(p)) chmodTree(join(p, name));
}

const ROOT = process.env.SETTINGS_ERRORS_GOLDEN_CHILD;
process.umask(0o022);

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

const { readSettings, writeSettings, SettingsParseError } = await import(join(repo, "lib/server/settings.ts"));
const { sanitizeJsonParseReason } = await import(join(repo, "lib/shared/settings-load-error.ts"));
const { Session } = await import(join(repo, "lib/server/session.ts"));
const { sessionManager } = await import(join(repo, "lib/server/session-manager.ts"));
const advisorRoute = await import(join(repo, "app/api/sessions/[id]/advisor/route.ts"));

// ------------------------------- helpers -------------------------------

const scrub = (s) =>
  s.split(ROOT).join("$ROOT").replace(/\.tmp-\d+-\d+/g, ".tmp-$PID-$SEQ");
/** A string as the fixture holds it: as is, or its UTF-16 units. */
const str = (s) => (s.isWellFormed() ? s : { units: [...Array(s.length).keys()].map((i) => s.charCodeAt(i)) });
const sstr = (s) => (typeof s === "string" ? str(scrub(s)) : s);

/** `sstr` on every string in a recorded value. */
const deep = (v) =>
  typeof v === "string"
    ? sstr(v)
    : Array.isArray(v)
      ? v.map(deep)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)]))
        : v;

function err(e) {
  const o = { name: e?.name, message: sstr(e?.message) };
  for (const k of ["code", "errno", "syscall", "path", "dest", "reason"]) {
    if (e?.[k] !== undefined) o[k] = sstr(e[k]);
  }
  if (e instanceof SettingsParseError) o.settingsParseError = true;
  return o;
}

function describe(v) {
  const type = v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
  let json;
  try {
    json = str(JSON.stringify(v));
  } catch (e) {
    json = { stringifyThrows: `${e.name}: ${e.message}` };
  }
  return { type, json, spread: str(JSON.stringify({ ...v })) };
}

const hex = (buf) => Buffer.from(buf).toString("hex");
/** File content: text when it's valid UTF-8, else hex. */
function content(buf) {
  const text = buf.toString("utf8");
  return Buffer.from(text, "utf8").equals(buf) ? { text: scrub(text) } : { hex: hex(buf) };
}

/** The tree under the root (minus config/ and out.json), sorted by path. */
function snapshot() {
  const entries = [];
  const walk = (rel) => {
    const abs = join(ROOT, rel);
    const e = { path: scrub(rel) };
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      // Listed, but its dir isn't searchable.
      entries.push({ ...e, unreadable: true });
      return;
    }
    if (st.isSymbolicLink()) {
      e.type = "symlink";
      e.target = scrub(readlinkSync(abs));
      entries.push(e);
      return;
    }
    e.mode = st.mode & 0o777;
    if (st.isDirectory()) {
      e.type = "dir";
      let names;
      try {
        names = readdirSync(abs).sort();
      } catch {
        e.unreadable = true;
      }
      entries.push(e);
      for (const n of names ?? []) walk(join(rel, n));
      return;
    }
    e.type = st.isFile() ? "file" : "other";
    if (st.isFile()) {
      try {
        Object.assign(e, content(readFileSync(abs)));
      } catch {
        e.unreadable = true;
      }
    }
    entries.push(e);
  };
  for (const top of ["home", "project", "ext"]) {
    try {
      lstatSync(join(ROOT, top));
    } catch {
      continue;
    }
    walk(top);
  }
  return entries;
}

const fill = (s) => s.split("$ROOT").join(ROOT);

function reset() {
  for (const top of ["home", "project", "ext"]) {
    chmodTree(join(ROOT, top));
    rmSync(join(ROOT, top), { recursive: true, force: true });
    mkdirSync(join(ROOT, top));
  }
}

function apply(setup) {
  const chmods = [];
  for (const op of setup) {
    const p = join(ROOT, op.path);
    if (op.op === "dir") mkdirSync(p, { recursive: true });
    else if (op.op === "file") {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, op.hex !== undefined ? Buffer.from(op.hex, "hex") : op.text);
    } else if (op.op === "symlink") {
      mkdirSync(dirname(p), { recursive: true });
      symlinkSync(fill(op.target), p);
    } else if (op.op === "rm") rmSync(p, { recursive: true, force: true });
    else if (op.op === "chmod") chmods.push(op);
    else throw new Error(`unknown op ${op.op}`);
  }
  for (const op of chmods) chmodSync(join(ROOT, op.path), op.mode);
}

const settingsRel = (scope, cwdRel = "project") =>
  scope === "user"
    ? "home/.claude/settings.json"
    : `${cwdRel}/.claude/${scope === "project" ? "settings.json" : "settings.local.json"}`;
const body = (scope, b, cwdRel) => ({
  op: "file",
  path: settingsRel(scope, cwdRel),
  ...(typeof b === "string" ? { text: b } : { hex: b.hex }),
});

// mulberry32, for the seeded fuzz.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------- errno names -------------------------------

const errorMap = [...getSystemErrorMap()].map(([n, [code, desc]]) => [n, code, desc]).sort((a, b) => b[0] - a[0]);
const unknown = [-9999, -4242, -200].map((n) => [n, getSystemErrorName(n), getSystemErrorMessage(n)]);

// ------------------------------- raw fs errors -------------------------------

const fsErrors = [];
{
  reset();
  apply([
    { op: "file", path: "ext/file", text: "x" },
    { op: "dir", path: "ext/dir/sub" },
    { op: "dir", path: "ext/empty" },
    { op: "symlink", path: "ext/loop", target: "$ROOT/ext/loop" },
    { op: "symlink", path: "ext/dangling", target: "$ROOT/ext/nowhere/x" },
    { op: "file", path: "ext/ro/inside", text: "y" },
    { op: "file", path: "ext/it's \"q\" d\u00efr/f", text: "z" },
    { op: "file", path: "ext/locked", text: "w" },
    { op: "chmod", path: "ext/locked", mode: 0o000 },
    { op: "chmod", path: "ext/ro", mode: 0o555 },
  ]);
  // macOS: in a user-immutable directory `mkdir` and `open` fail with EPERM
  // (`frozen` cases; the replay skips them elsewhere).
  const frozen = process.platform === "darwin";
  if (frozen) {
    mkdirSync(join(ROOT, "ext/frozen"));
    freeze(join(ROOT, "ext/frozen"));
  }
  const long = `$ROOT/ext/${"a".repeat(300)}/x`;
  const q = "$ROOT/ext/it's \"q\" d\u00efr";
  const ops = [
    ["readFile", "$ROOT/ext/missing"],
    ["readFile", "$ROOT/ext/locked"],
    ["readFile", "$ROOT/ext/dir"],
    ["readFile", "$ROOT/ext/file/x"],
    ["readFile", "$ROOT/ext/loop"],
    ["readFile", "$ROOT/ext/dangling"],
    ["readFile", long],
    ["readFile", `${q}/missing`],
    ["writeFile", "$ROOT/ext/ro/new"],
    ["writeFile", "$ROOT/ext/dir"],
    ["writeFile", "$ROOT/ext/missing/new"],
    ["writeFile", "$ROOT/ext/locked"],
    ["mkdir", "$ROOT/ext/file"],
    ["mkdir", "$ROOT/ext/dir"],
    ["mkdir", "$ROOT/ext/missing/a"],
    ["mkdir", "$ROOT/ext/ro/a"],
    ["mkdir", "$ROOT/ext/file/a"],
    ["mkdirp", "$ROOT/ext/file"],
    ["mkdirp", "$ROOT/ext/file/a/b"],
    ["mkdirp", "$ROOT/ext/ro/a/b"],
    ["mkdirp", "$ROOT/ext/ro/a"],
    ["mkdirp", "$ROOT/ext/dangling"],
    ["mkdirp", "$ROOT/ext/dangling/a"],
    ["mkdirp", "$ROOT/ext/loop/a"],
    ["mkdirp", long],
    ["rename", "$ROOT/ext/missing", "$ROOT/ext/other"],
    ["rename", "$ROOT/ext/file", "$ROOT/ext/dir"],
    ["rename", "$ROOT/ext/file", "$ROOT/ext/empty"],
    ["rename", "$ROOT/ext/dir", "$ROOT/ext/file"],
    ["rename", "$ROOT/ext/empty", "$ROOT/ext/dir"],
    ["rename", "$ROOT/ext/ro/inside", "$ROOT/ext/moved"],
    ["rename", `${q}/f`, `${q}/f/g`],
    ["rmdir", "$ROOT/ext/dir"],
    ["rmdir", "$ROOT/ext/file"],
    ["rmdir", "$ROOT/ext/missing"],
    ["unlink", "$ROOT/ext/missing"],
    ["unlink", "$ROOT/ext/ro/inside"],
    ["lstat", "$ROOT/ext/missing"],
    ["lstat", "$ROOT/ext/file/x"],
    ["stat", "$ROOT/ext/loop"],
    ["stat", "$ROOT/ext/dangling"],
    ["readdir", "$ROOT/ext/file"],
    ["readdir", "$ROOT/ext/missing"],
    ["chmod", "$ROOT/ext/missing", 0o644],
    ["symlink", "target", "$ROOT/ext/file"],
    ["copyFile", "$ROOT/ext/missing", "$ROOT/ext/copy"],
    ["realpath", "$ROOT/ext/missing"],
    ["readlink", "$ROOT/ext/file"],
    ["access", "$ROOT/ext/missing"],
    ["rm", "$ROOT/ext/missing"],
    ["open", "$ROOT/ext/locked"],
    ...(frozen
      ? [
          ["mkdirp", "$ROOT/ext/frozen/a/b"],
          ["mkdirp", "$ROOT/ext/frozen/a"],
          ["mkdir", "$ROOT/ext/frozen/a"],
          ["writeFile", "$ROOT/ext/frozen/new"],
        ]
      : []),
  ];
  const run = {
    readFile: (p) => fsp.readFile(p, "utf8"),
    writeFile: (p) => fsp.writeFile(p, "x", "utf8"),
    mkdir: (p) => fsp.mkdir(p),
    mkdirp: (p) => fsp.mkdir(p, { recursive: true }),
    rename: (a, b) => fsp.rename(a, b),
    rmdir: (p) => fsp.rmdir(p),
    unlink: (p) => fsp.unlink(p),
    lstat: (p) => fsp.lstat(p),
    stat: (p) => fsp.stat(p),
    readdir: (p) => fsp.readdir(p),
    chmod: (p, m) => fsp.chmod(p, m),
    symlink: (t, p) => fsp.symlink(t, p),
    copyFile: (a, b) => fsp.copyFile(a, b),
    realpath: (p) => fsp.realpath(p),
    readlink: (p) => fsp.readlink(p),
    access: (p) => fsp.access(p),
    rm: (p) => fsp.rm(p),
    open: async (p) => (await fsp.open(p, "r")).close(),
  };
  for (const [op, ...args] of ops) {
    let e = null;
    try {
      await run[op](...args.map((a) => (typeof a === "string" && a.startsWith("$ROOT") ? fill(a) : a)));
    } catch (x) {
      e = err(x);
    }
    if (!e) throw new Error(`${op} ${args} didn't fail`);
    fsErrors.push({ op, args, err: e });
  }
  unfreeze(join(ROOT, "ext"));
}

// ------------------------------- sanitize -------------------------------

const messages = [
  "",
  "   ",
  "\t\n",
  "Unexpected end of JSON input",
  `Unexpected token 'x', "abc" is not valid JSON`,
  `Unexpected token 'x', ..."abc"... is not valid JSON`,
  `Unexpected token 'x', "abc"... is not valid JSON`,
  `Unexpected token 'x', ..."abc" is not valid JSON`,
  `a, "b" is not valid JSON`,
  `x " is not valid JSON`,
  `, " is not valid JSON`,
  `" is not valid JSON`,
  `a, "b, "c" is not valid JSON`,
  `a, "b" is not valid JSON.`,
  `a, "b" is not valid JSONx`,
  `Unterminated string in JSON at position 5`,
  `"a" "b" "c"`,
  `""`,
  `"`,
  `"""`,
  `a"b"c"d`,
  `a "b\nc" d`,
  `pre "x" mid "y`,
  "a\t\tb\n\nc\u00a0\u00a0d\u2028e\u2029f\ufeffg\u3000h\u1680i\u202fj\u205fk\u000bl\u000cm\r\nn",
  "\ufeffa\ufeff",
  "a\u0085b",
  "a\u180eb",
  "a\u200bb",
  "  lead and trail  ",
  "x".repeat(159),
  "x".repeat(160),
  "x".repeat(161),
  "x".repeat(400),
  `${"x".repeat(158)}\ud83d\ude00yy`,
  `${"x".repeat(157)}\ud83d\ude00yy`,
  `${"x".repeat(159)}\ud83d\ude00`,
  `"${"q".repeat(300)}" tail`,
  `${"w ".repeat(120)}end`,
  `${"x".repeat(150)}${" ".repeat(30)}y`,
  "already \u2026 here",
  `Unexpected token '\ud83d', "\ud83d\ude00" is not valid JSON`,
  `lone \ud800 high and \udfff low`,
  `"\ud800"`,
  `Unexpected token '"', "..." is not valid JSON`,
];
const sanitizeMessages = messages.map((m) => ({ message: str(m), reason: str(sanitizeJsonParseReason(m)) }));

const corpus = [
  "",
  " ",
  "{",
  "}",
  "[",
  "{\"a\":",
  "{\"a\": }",
  "{a:1}",
  "{\"a\" 1}",
  "{\"a\":1,}",
  "[1,]",
  "[1 2]",
  "{\"a\":1}}",
  "{\"a\":1} x",
  "{\"a\":1}\n\n  // trailing comment",
  "{\n  // comment\n  \"a\": 1\n}",
  "{\"a\":\"\\x\"}",
  "{\"a\":\"\\u12\"}",
  "{\"a\":\"\\u12G4\"}",
  "{\"a\":\"tab\there\"}",
  "{\"a\":\"line\nbreak\"}",
  "{\"a\":\"abc",
  "{\"a\":-}",
  "{\"a\":1.}",
  "{\"a\":1e}",
  "{\"a\":01}",
  "{'a':1}",
  "{\"a\":tru}",
  "{\"a\":NaN}",
  "{\"a\":Infinity}",
  "{\"a\":undefined}",
  "undefined",
  "NaN",
  "Infinity",
  "[object Object]",
  "{\"a\":1,\"b\":2,\"c\":3,\"d\":\"hello secret\" x}",
  "{\"env\":{\"API_KEY\":\"sk-secret-123\"},}",
  "{\n  \"model\": \"opus\",\n  \"env\": {\n    \"A\": \"1\"\n  }\n  \"theme\": \"dark\"\n}",
  "{\r\n  \"model\": \"opus\",\r\n  \"env\": {\r\n    \"A\": \"1\"\r\n  }\r\n  \"theme\": \"dark\"\r\n}",
  "\"unterminated",
  "{\"a\":1}\u2028",
  "{\"k\":\"v\"} \"tail with \\\" quote\"",
  "{\"aaaaaaaaaaaaaaaaaaaaa\": x}",
  "{\"a\": \"b\", \"c\": \"d\", x \"e\": \"f\"}",
  "{\"a\": \"b\" \"c\": \"d\"}",
  "{\"a\": \u00e9}",
  "{\"a\": \u4e2d}",
  "{\"a\": \ud83d\ude00}",
  "\ud83d\ude00",
  "{\"emoji\": \"\ud83d\ude00\ud83d\ude00\" x \"\ud83d\ude00\"}",
  "{\"a\":1}\u0000",
  "\ufeff{}",
  "\ufeff\ufeff{}",
  "\ufeffnull",
  "\ufeff",
  "\u00a0{}",
  "\u000b{}",
  "{\"a\":1}\n\n\n\n\n\n\n\n\n\n\n\nx",
  `{"a":"${"s".repeat(40)}" ${"t".repeat(40)}}`,
];
const parsed = [];
const parseMessage = (text) => {
  try {
    JSON.parse(text);
    return null;
  } catch (e) {
    return e.message;
  }
};
const pushParsed = (text) => {
  const message = parseMessage(text);
  if (message === null) return;
  parsed.push({ text: str(text), message: str(message), reason: str(sanitizeJsonParseReason(message)) });
};
for (const t of corpus) pushParsed(t);
{
  const rand = rng(0xd10a);
  const alphabet = [..."{}[]:,\"'\\ -.0123456789eEtfnulasx\t\n\r", "\u00e9", "\u4e2d", "\ud83d\ude00", "\u2028", "\u00a0", "\ufeff", "\"secret value\"", "\"k\":"];
  const valid = ['{"a":1}', '{"model":"opus","env":{"K":"v w"}}', "[1,2,3]", '"str"', "true", "null", '{"a":[{"b":"c d"}]}'];
  let made = 0;
  while (made < 400) {
    let text;
    if (rand() < 0.5) {
      const n = 1 + Math.floor(rand() * 40);
      text = Array.from({ length: n }, () => alphabet[Math.floor(rand() * alphabet.length)]).join("");
    } else {
      const base = valid[Math.floor(rand() * valid.length)].repeat(1 + Math.floor(rand() * 3));
      const at = Math.floor(rand() * (base.length + 1));
      const cut = rand() < 0.5 ? 1 : 0;
      text = base.slice(0, at) + alphabet[Math.floor(rand() * alphabet.length)] + base.slice(at + cut);
    }
    if (parseMessage(text) === null) continue;
    pushParsed(text);
    made++;
  }
}

// ------------------------------- readSettings -------------------------------

const read = [];
const writes = [];
const callers = [];

async function runCase(list, c, call) {
  reset();
  apply(c.setup);
  const rec = { ...c, cwd: c.cwd ?? "$ROOT/project" };
  rec.scope ??= "user";
  try {
    Object.assign(rec, await call(rec));
  } catch (e) {
    rec.throws = err(e);
  }
  rec.after = snapshot();
  list.push(deep(rec));
}

const texts = [
  ["empty", ""],
  ["whitespace", " \n\t "],
  ["object", "{\"model\":\"opus\",\"env\":{\"A\":\"1\"}}"],
  ["empty object", "{}"],
  ["null", "null"],
  ["null padded", " \n null \t"],
  ["empty array", "[]"],
  ["array", "[1,2,{\"a\":3}]"],
  ["string", "\"str\""],
  ["empty string", "\"\""],
  ["string astral", "\"caf\u00e9 \ud83d\ude00\""],
  ["number", "5"],
  ["negative zero", "-0"],
  ["fraction", "0.5"],
  ["1e400", "1e400"],
  ["-1e400", "-1e400"],
  ["1e400 padded", " 1e400 "],
  ["true", "true"],
  ["false", "false"],
  ["number text", "{\"model\":\"opus\",\"n\":1.0,\"big\":12345678901234567890,\"e\":1e2,\"neg\":-0,\"tiny\":1e-7,\"k\":1e21}"],
  ["index keys", "{\"b\":1,\"2\":2,\"a\":3,\"1\":4,\"01\":5,\"4294967295\":6,\"4294967294\":7}"],
  ["duplicate keys", "{\"a\":1,\"b\":2,\"a\":3}"],
  ["proto keys", "{\"__proto__\":{\"model\":\"x\"},\"constructor\":1,\"toString\":2}"],
  ["inner 1e400", "{\"n\":1e400,\"m\":[-1e400],\"o\":{\"p\":1e400}}"],
  ["lone surrogate escapes", "{\"a\":\"\\ud800\",\"\\udc00\":1}"],
  ["pair escapes", "{\"a\":\"\\ud83d\\ude00\",\"b\":\"\\u00e9\\u0000\\u001f\"}"],
  ["raw unicode", "{\"a\":\"\u00e9\u4e2d\ud83d\ude00\u2028\u2029\"}"],
  ["nested 100", `${"[".repeat(100)}${"]".repeat(100)}`],
  ["nested 126", `${"[".repeat(126)}${"]".repeat(126)}`],
  ["nested 127", `${"[".repeat(127)}${"]".repeat(127)}`],
  ["nested 128", `${"[".repeat(128)}${"]".repeat(128)}`],
  ["nested 129", `${"[".repeat(129)}${"]".repeat(129)}`],
  ["nested 200 objects", `${"{\"a\":".repeat(200)}1${"}".repeat(200)}`],
  ["nested 3000", `${"[".repeat(3000)}${"]".repeat(3000)}`],
  ["large", JSON.stringify({ big: Array.from({ length: 400 }, (_, i) => ({ i, s: `v${i}` })) })],
];
for (const t of corpus) texts.push([`malformed ${JSON.stringify(t).slice(1, -1).slice(0, 60)}`, t]);
const bytes = [
  ["invalid UTF-8 ff in string", "7b2261223a22ff227d"],
  ["invalid UTF-8 truncated 3-byte", "7b2261223a22e282227d"],
  ["invalid UTF-8 overlong", "7b2261223a22c0af227d"],
  ["invalid UTF-8 surrogate", "7b2261223a22eda080227d"],
  ["invalid UTF-8 past U+10FFFF", "7b2261223a22f4908080227d"],
  ["invalid UTF-8 lone continuation", "7b2261223a2280227d"],
  ["invalid UTF-8 truncated 4-byte", "7b2261223a22f09f98227d"],
  ["invalid UTF-8 key", "7bff3a317d"],
  ["invalid UTF-8 garbage before", "ff7b7d"],
  ["invalid UTF-8 garbage after", "7b7dff"],
  ["invalid UTF-8 keeps settings", "7b226d6f64656c223a226f707573222c2274223a2263616620ff206c616974227d"],
  ["UTF-16LE with BOM", "fffe7b002200610022003a0031007d00"],
  ["NUL bytes", "7b7d00"],
];
const userBody = (b) => [body("user", b)];

for (const [name, text] of texts) {
  await runCase(read, { name, setup: userBody(text) }, async (c) => ({ value: describe(await readSettings(c.scope, fill(c.cwd))) }));
}
for (const [name, h] of bytes) {
  await runCase(read, { name, setup: userBody({ hex: h }) }, async (c) => ({ value: describe(await readSettings(c.scope, fill(c.cwd))) }));
}
const P = "$ROOT/project";
const io = [
  { name: "missing, no .claude", setup: [] },
  { name: "missing, .claude exists", setup: [{ op: "dir", path: "home/.claude" }] },
  { name: "missing HOME", setup: [{ op: "rm", path: "home" }] },
  { name: "settings.json is a dir", setup: [{ op: "dir", path: "home/.claude/settings.json" }] },
  { name: ".claude is a file", setup: [{ op: "file", path: "home/.claude", text: "{}" }] },
  { name: "unreadable file", needsNonRoot: true, setup: [...userBody("{}"), { op: "chmod", path: "home/.claude/settings.json", mode: 0o000 }] },
  { name: "write-only file", needsNonRoot: true, setup: [...userBody("{}"), { op: "chmod", path: "home/.claude/settings.json", mode: 0o200 }] },
  { name: "unsearchable .claude", needsNonRoot: true, setup: [...userBody("{}"), { op: "chmod", path: "home/.claude", mode: 0o000 }] },
  { name: ".claude without x", needsNonRoot: true, setup: [...userBody("{}"), { op: "chmod", path: "home/.claude", mode: 0o600 }] },
  { name: "symlink loop", setup: [{ op: "symlink", path: "home/.claude/settings.json", target: "$ROOT/home/.claude/settings.json" }] },
  { name: "dangling symlink", setup: [{ op: "symlink", path: "home/.claude/settings.json", target: "$ROOT/ext/nowhere.json" }] },
  { name: "symlink to a file", setup: [{ op: "file", path: "ext/real.json", text: "{\"model\":\"linked\"}" }, { op: "symlink", path: "home/.claude/settings.json", target: "$ROOT/ext/real.json" }] },
  { name: "symlink to a malformed file", setup: [{ op: "file", path: "ext/real.json", text: "{\"model\":" }, { op: "symlink", path: "home/.claude/settings.json", target: "$ROOT/ext/real.json" }] },
  { name: "symlink to a dir", setup: [{ op: "dir", path: "ext/d" }, { op: "symlink", path: "home/.claude/settings.json", target: "$ROOT/ext/d" }] },
  { name: ".claude symlink to a file", setup: [{ op: "file", path: "ext/f", text: "x" }, { op: "symlink", path: "home/.claude", target: "$ROOT/ext/f" }] },
  { name: "relative symlink", setup: [{ op: "file", path: "home/.claude/real.json", text: "[7]" }, { op: "symlink", path: "home/.claude/settings.json", target: "real.json" }] },
  { name: "project scope malformed", scope: "project", setup: [body("project", "{\"a\":")] },
  { name: "project scope array", scope: "project", setup: [body("project", "[\"x\",\"y\"]")] },
  { name: "project scope missing cwd", scope: "project", cwd: "$ROOT/project/nope", setup: [] },
  { name: "project scope cwd is a file", scope: "project", cwd: "$ROOT/ext/f", setup: [{ op: "file", path: "ext/f", text: "x" }] },
  { name: "local scope malformed", scope: "local", setup: [body("local", "{,}")] },
  { name: "local scope null", scope: "local", setup: [body("local", "null")] },
  { name: "local scope string", scope: "local", setup: [body("local", "\"ab\"")] },
  { name: "local scope unreadable", scope: "local", needsNonRoot: true, setup: [body("local", "{}"), { op: "chmod", path: "project/.claude/settings.local.json", mode: 0o000 }] },
  { name: "local scope dir", scope: "local", setup: [{ op: "dir", path: "project/.claude/settings.local.json" }] },
  { name: "cwd with a long name", scope: "project", cwd: `$ROOT/project/${"a".repeat(300)}`, setup: [] },
  { name: "cwd with quotes", scope: "project", cwd: "$ROOT/project/it's \"q\" d\u00efr", setup: [{ op: "file", path: "project/it's \"q\" d\u00efr/.claude/settings.json", text: "{x}" }] },
  { name: "cwd with quotes unreadable", scope: "project", cwd: "$ROOT/project/it's \"q\" d\u00efr", needsNonRoot: true, setup: [{ op: "file", path: "project/it's \"q\" d\u00efr/.claude/settings.json", text: "{}" }, { op: "chmod", path: "project/it's \"q\" d\u00efr/.claude/settings.json", mode: 0o000 }] },
  { name: "cwd with a trailing slash", scope: "project", cwd: `${P}/`, setup: [body("project", "{")] },
  { name: "cwd with double slashes", scope: "project", cwd: "$ROOT//project", setup: [body("project", "{")] },
  { name: "cwd with dot segments", scope: "project", cwd: `${P}/./sub/../`, setup: [body("project", "{")] },
  { name: "empty cwd", scope: "project", cwd: "", setup: [] },
  { name: "empty cwd local", scope: "local", cwd: "", setup: [] },
  { name: "NUL in cwd", scope: "project", cwd: `${P}/a\u0000b`, setup: [] },
  { name: "NUL in cwd user scope", scope: "user", cwd: `${P}/a\u0000b`, setup: userBody("{\"ok\":1}") },
  { name: "empty cwd user scope", scope: "user", cwd: "", setup: userBody("{\"ok\":1}") },
];
for (const c of io) {
  await runCase(read, c, async (r) => ({ value: describe(await readSettings(r.scope, fill(r.cwd))) }));
}

// ------------------------------- writeSettings -------------------------------

const nexts = {
  plain: "{\"model\":\"opus\"}",
  numbers: "{\"n\":1.0,\"big\":12345678901234567890,\"e\":1e2,\"neg\":-0,\"tiny\":1e-7,\"k\":1e21,\"f\":0.1,\"m\":-5e-324}",
  order: "{\"b\":1,\"2\":2,\"a\":3,\"1\":4,\"01\":5}",
  nested: "{\"a\":{},\"b\":[],\"c\":{\"d\":[1,{\"e\":[]}]},\"f\":null,\"g\":true}",
  strings: "{\"s\":\"\u00e9\ud83d\ude00\u2028\\u0000\\u001f\\b\\f\\n\\r\\t\\\"\\\\/\\u007f\"}",
  lone: "{\"s\":\"\\ud800\"}",
  empty: "{}",
  infinity: "{\"n\":1e400}",
};
const writeCase = (name, next, setup, extra = {}) => ({ name, next: nexts[next] ?? next, setup, ...extra });
const ws = [
  ...Object.keys(nexts).map((k) => writeCase(`fresh ${k}`, k, [])),
  writeCase("over an existing file", "plain", userBody("{\"old\":true}")),
  writeCase("keeps mode 600", "plain", [...userBody("{}"), { op: "chmod", path: "home/.claude/settings.json", mode: 0o600 }]),
  writeCase("keeps mode 444", "plain", [...userBody("{}"), { op: "chmod", path: "home/.claude/settings.json", mode: 0o444 }]),
  writeCase("keeps mode 777", "plain", [...userBody("{}"), { op: "chmod", path: "home/.claude/settings.json", mode: 0o777 }]),
  writeCase("over a malformed file", "plain", userBody("{\"a\":")),
  writeCase("missing HOME", "plain", [{ op: "rm", path: "home" }]),
  writeCase(".claude is a file", "plain", [{ op: "file", path: "home/.claude", text: "x" }]),
  writeCase(".claude dangling symlink", "plain", [{ op: "symlink", path: "home/.claude", target: "$ROOT/ext/nowhere" }]),
  writeCase(".claude symlink to a dir", "plain", [{ op: "dir", path: "ext/real" }, { op: "symlink", path: "home/.claude", target: "$ROOT/ext/real" }]),
  writeCase(".claude symlink to a file", "plain", [{ op: "file", path: "ext/f", text: "x" }, { op: "symlink", path: "home/.claude", target: "$ROOT/ext/f" }]),
  writeCase("read-only .claude", "plain", [{ op: "dir", path: "home/.claude" }, { op: "chmod", path: "home/.claude", mode: 0o555 }], { needsNonRoot: true }),
  writeCase("read-only .claude with a file", "plain", [...userBody("{}"), { op: "chmod", path: "home/.claude", mode: 0o555 }], { needsNonRoot: true }),
  writeCase("unsearchable .claude", "plain", [...userBody("{}"), { op: "chmod", path: "home/.claude", mode: 0o000 }], { needsNonRoot: true }),
  writeCase("read-only HOME", "plain", [{ op: "chmod", path: "home", mode: 0o555 }], { needsNonRoot: true }),
  writeCase("settings.json is a dir", "plain", [{ op: "dir", path: "home/.claude/settings.json" }]),
  writeCase("settings.json is a non-empty dir", "plain", [{ op: "file", path: "home/.claude/settings.json/x", text: "x" }]),
  writeCase("symlink to a file", "plain", [{ op: "file", path: "ext/real.json", text: "{}" }, { op: "symlink", path: "home/.claude/settings.json", target: "$ROOT/ext/real.json" }]),
  writeCase("symlink to a dangling target", "plain", [{ op: "symlink", path: "home/.claude/settings.json", target: "$ROOT/ext/new.json" }]),
  writeCase("symlink into a missing dir", "plain", [{ op: "symlink", path: "home/.claude/settings.json", target: "$ROOT/ext/missing/new.json" }]),
  writeCase("symlink to a dir", "plain", [{ op: "dir", path: "ext/d" }, { op: "symlink", path: "home/.claude/settings.json", target: "$ROOT/ext/d" }]),
  writeCase("symlink to a read-only file", "plain", [{ op: "file", path: "ext/ro.json", text: "{}" }, { op: "chmod", path: "ext/ro.json", mode: 0o444 }, { op: "symlink", path: "home/.claude/settings.json", target: "$ROOT/ext/ro.json" }], { needsNonRoot: true }),
  writeCase("symlink loop", "plain", [{ op: "symlink", path: "home/.claude/settings.json", target: "$ROOT/home/.claude/settings.json" }]),
  writeCase("symlink in a read-only .claude", "plain", [{ op: "file", path: "ext/real.json", text: "{}" }, { op: "symlink", path: "home/.claude/settings.json", target: "$ROOT/ext/real.json" }, { op: "chmod", path: "home/.claude", mode: 0o555 }], { needsNonRoot: true }),
  writeCase("project scope", "plain", [], { scope: "project" }),
  writeCase("local scope", "order", [], { scope: "local" }),
  writeCase("project scope in a read-only parent", "plain", [{ op: "dir", path: "ext/ro" }, { op: "chmod", path: "ext/ro", mode: 0o555 }], { scope: "project", cwd: "$ROOT/ext/ro/proj", needsNonRoot: true }),
  writeCase("project scope cwd is a file", "plain", [{ op: "file", path: "ext/f", text: "x" }], { scope: "project", cwd: "$ROOT/ext/f" }),
  writeCase("project scope under a file", "plain", [{ op: "file", path: "ext/f", text: "x" }], { scope: "project", cwd: "$ROOT/ext/f/a/b" }),
  writeCase("project scope dangling cwd", "plain", [{ op: "symlink", path: "ext/dl", target: "$ROOT/ext/nowhere" }], { scope: "project", cwd: "$ROOT/ext/dl/p" }),
  writeCase("cwd with a long name", "plain", [], { scope: "project", cwd: `$ROOT/project/${"a".repeat(300)}` }),
  writeCase("cwd with dot segments", "plain", [], { scope: "local", cwd: `${P}/./sub/../` }),
  writeCase("empty cwd", "plain", [], { scope: "project", cwd: "" }),
  writeCase("NUL in cwd", "plain", [], { scope: "local", cwd: `${P}/a\u0000b` }),
];
for (const c of ws) {
  await runCase(writes, c, async (r) => {
    await writeSettings(r.scope, fill(r.cwd), JSON.parse(r.next));
    return { ok: true };
  });
}
// Back to back in one process: two writes, the counter moves on.
await runCase(writes, { name: "two writes", next: nexts.plain, setup: [] }, async (r) => {
  await writeSettings(r.scope, fill(r.cwd), { first: 1 });
  await writeSettings(r.scope, fill(r.cwd), JSON.parse(r.next));
  return { ok: true };
});

// ------------------------------- callers -------------------------------

async function captured(f) {
  const logged = [];
  const { error, warn } = console;
  console.error = (...a) => logged.push(a.map((x) => (x instanceof Error ? err(x) : sstr(String(x)))));
  console.warn = console.error;
  try {
    return { result: await f(), logged };
  } catch (e) {
    return { thrown: e, logged };
  } finally {
    console.error = error;
    console.warn = warn;
  }
}

function bare(cwd) {
  const s = Object.create(Session.prototype);
  s.cwd = cwd;
  s.query = null;
  s.broadcasts = [];
  s.broadcast = (ev) => s.broadcasts.push(ev);
  return s;
}

const states = (scope) => [
  ["missing", []],
  ["object", [body(scope, "{\"a\":1,\"outputStyle\":\"x\",\"model\":\"sonnet\",\"advisorModel\":\"claude-opus-4-8\",\"z\":[2],\"n\":1.0}")]],
  ["same model", [body(scope, "{\"model\":\"opus\"}")]],
  ["null", [body(scope, "null")]],
  ["array", [body(scope, "[1,{\"b\":2}]")]],
  ["string", [body(scope, "\"ab\"")]],
  ["string astral", [body(scope, "\"\ud83d\ude00\"")]],
  ["number", [body(scope, "5")]],
  ["1e400", [body(scope, "1e400")]],
  ["true", [body(scope, "true")]],
  ["malformed", [body(scope, "{\"a\":")]],
  ["BOM", [body(scope, "\ufeff{\"a\":1}")]],
  ["invalid UTF-8", [body(scope, { hex: "7b2261223a2263616620ff206c616974227d" })]],
  ["null model", [body(scope, "{\"a\":1,\"model\":null,\"z\":2}")]],
  ["falsy advisor", [body(scope, "{\"advisorModel\":\"\",\"k\":1}")]],
  ["zero advisor", [body(scope, "{\"advisorModel\":0}")]],
  ["array advisor", [body(scope, "{\"advisorModel\":[]}")]],
  ["disabled auto", [body(scope, "{\"disableAutoMode\":\"disable\"}")]],
  ["recap off", [body(scope, "{\"sessionRecapEnabled\":false}")]],
  ["a dir", [{ op: "dir", path: settingsRel(scope) }]],
  ["unreadable", [body(scope, "{}"), { op: "chmod", path: settingsRel(scope), mode: 0o000 }], true],
  ["read-only dir", [body(scope, "{\"a\":1}"), { op: "chmod", path: dirname(settingsRel(scope)), mode: 0o555 }], true],
];
const callerCase = async (caller, scope, args, f) => {
  for (const [state, setup, needsNonRoot] of states(scope)) {
    await runCase(callers, { name: `${caller} ${state}`, caller, scope, args, setup, ...(needsNonRoot ? { needsNonRoot } : {}) }, async (r) => {
      const { result, thrown, logged } = await captured(() => f(r));
      const o = { logged };
      if (thrown) o.throws = err(thrown);
      else if (result !== undefined) Object.assign(o, result);
      return o;
    });
  }
};

await callerCase("setOutputStyle", "local", ["concise"], async (r) => {
  const s = bare(fill(r.cwd));
  return { returned: await s.setOutputStyle("concise") };
});
for (const model of ["opus", null, ""]) {
  await callerCase(`persistModelToUserSettings ${JSON.stringify(model)}`, "user", [model], async (r) => {
    const s = bare(fill(r.cwd));
    await s.persistModelToUserSettings(model ?? undefined);
    return {};
  });
}
await callerCase("enforceAdvisorModelCompatibility", "user", ["claude-fable-5"], async (r) => {
  const s = bare(fill(r.cwd));
  s.advisorModel = "claude-opus-4-8";
  s.setAdvisorModel = async () => {};
  await s.enforceAdvisorModelCompatibility("claude-fable-5");
  return { broadcasts: s.broadcasts.map((b) => b.type) };
});
for (const model of ["claude-opus-4-8", null]) {
  await callerCase(`advisor route ${JSON.stringify(model)}`, "user", [model], async (r) => {
    const fake = { cwd: fill(r.cwd), setAdvisorModel: async () => {} };
    sessionManager.sessions.set("s-advisor", fake);
    try {
      const res = await advisorRoute.POST(
        new Request("http://localhost/api/sessions/s-advisor/advisor", { method: "POST", body: JSON.stringify({ model }) }),
        { params: Promise.resolve({ id: "s-advisor" }) },
      );
      return { status: res.status, body: await res.text() };
    } finally {
      sessionManager.sessions.delete("s-advisor");
    }
  });
}
await callerCase("setPermissionMode auto", "user", ["auto"], async (r) => {
  const s = bare(fill(r.cwd));
  s.permissionMode = "default";
  try {
    await s.setPermissionMode("auto");
  } finally {
    r.mode = s.permissionMode;
  }
  return { broadcasts: s.broadcasts };
});
await callerCase("requestRecap", "user", [], async (r) => {
  const s = bare(fill(r.cwd));
  s.getStatus = () => "idle";
  s.lastRecapAt = null;
  s.buffer = [];
  await s.requestRecap("manual");
  return { broadcasts: s.broadcasts };
});

for (const [what, list] of [["read", read], ["write", writes], ["callers", callers]]) {
  const seen = new Set();
  for (const c of list) {
    if (seen.has(c.name)) throw new Error(`${what}: duplicate case name ${JSON.stringify(c.name)}`);
    seen.add(c.name);
  }
}

reset();
writeFileSync(
  join(ROOT, "out.json"),
  JSON.stringify({
    node: process.version,
    platform: process.platform,
    errorMap,
    unknown,
    fsErrors,
    sanitize: { messages: sanitizeMessages, parsed },
    read,
    write: writes,
    callers,
  }),
);
process.exit(0);
