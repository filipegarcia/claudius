#!/usr/bin/env node
// Golden fixtures for the doctor (D22): `app/api/doctor/route.ts`,
// `app/api/doctor/fix/route.ts`, `lib/server/prompt-audit.ts`,
// `lib/shared/prompt-audit.ts`, `lib/server/claudemd.ts` (read side),
// `lib/server/skills.ts` (`listSkills`, `isValidSkillDirName`),
// `lib/shared/skill-names.ts`, `lib/shared/telemetry-env.ts` and
// `findSlashCommand`, recorded from the real TS sources:
//
//   node rust/scripts/doctor-golden.mjs     (node@22: db.ts needs
//                                            better-sqlite3, which bun can't
//                                            load)
//
// Re-runs itself under `--experimental-transform-types` with a resolve hook
// for the extensionless / `@/` imports, twice (two temp roots, both through
// realpath); both recordings must agree byte for byte. The child runs with
// its cwd at `<root>/project`, HOME at `<root>/home`, CLAUDE_CONFIG_DIR at
// `<root>/config` (a decoy: the doctor reads `homedir()/.claude`), PATH at
// `<root>/bin` only (where each case puts its fake `git`; every fake names
// its tools by absolute path) and umask 022. Nothing outside the root is
// read or written, apart from the TS sources.
//
// The fake `git` is `/bin/sh` that writes its argv (NUL-terminated) to
// `$0.argv` and then runs the case's snippet. TS reads its own runtime for
// the Node.js check: `process.versions.node` is redefined to the case's
// `node` before each request (the Rust port runs `node --version` and its
// replay puts a fake `node` printing `v<node>` on PATH).
//
// Placeholders: `$ROOT` is the root and `$EROOT` its `encodeProjectDir` form;
// they are swapped textually in paths, bodies, file texts and results. In
// a GET body the runtime's `"platform":"...","arch":"..."` are `$PLATFORM` and
// `$ARCH`.
//
// Writes:
// - crates/claudius-core/tests/fixtures/prompt_audit_golden.json, replayed
//   by crates/claudius-core/tests/prompt_audit_golden.rs:
//   - `sweep`: for 5 predicates over every code point (a lone surrogate for
//     U+D800..U+DFFF), the code points where the answer flips (it starts
//     false): `isValidSkillDirName(c)`, `isEngineShownName(c)`,
//     `isEngineShownName("a" + c)`, `isEngineShownName(c + U+0307)` and
//     `isEngineShownName(c + U+093F)`; and over every UTF-16 unit, the
//     cot pattern's `\s`, the path token's and the command token's classes.
//   - `names`: `[name, isValidSkillDirName, isEngineShownName,
//     isEngineOfferableName]`, hand-picked then seeded fuzz.
//   - `patterns`, `paths`, `commands`: `[text, result]` of
//     `findStalePromptPatterns`, `extractReferencedPaths` and
//     `extractReferencedCommands`; `contradictions`: `[sources, result]` of
//     `findInstructionContradictions`. Hand-picked, then seeded fuzz.
//   - `telemetry`: `[env | "absent", ignoredTelemetryEnvKeys,
//     ignoredAttachmentsEnvKeys]`.
//   - `slash`: the registry as `[id, name, aliases]`, and `lookups`
//     (`[query, id | null]`).
//   - `modules`: one world (`setup` ops), then calls of `readScope`,
//     `resolveHierarchy`, `listSkills` and `auditWorkspacePrompts`, each with
//     its `result` or `threw` (`{name, code, message}`). `needs: "perm"`
//     marks the calls that need a disk that enforces permissions.
// - crates/claudius-server/tests/fixtures/doctor_golden.json, replayed on the
//   real binary by crates/claudius-server/tests/doctor.rs: `cases`, each with
//   the `env` it runs under (the doctor's env vars; the replay runs one
//   server per distinct env) and `steps`: `setup` ops, `node` (the version
//   from here on), `git` (the fake's snippet; null: no `git`, "dir": a
//   directory in its place, "noexec": a 0644 copy) or a request (`method`,
//   `path`, `body`) with `got` (status, content type, body text, or
//   `threw`: Next's empty 500), `gitArgv` (null when git didn't run) and
//   `changes`: every path under the root (bin aside) whose entry differs from
//   before the request (kind, mode, UTF-8 text or bytes, symlink target;
//   `.claudius.db` files by kind and mode only, their `-wal` / `-shm`
//   left out; `null` when gone). A request with `as` is a listed difference:
//   `got` / `changes` are what TS answers for the `as` body, which the port
//   must answer for this one; `ts` is what TS did. Each case starts from an
//   emptied root (project dir kept) with the default world (`base` ops:
//   `home/.claude/projects`, `home/.claude/.credentials.json`, the SDK's
//   package.json under `project/node_modules`), the default fake `git`
//   (`fakeHead` + `git`) and `node`; each case's workspaces live under its
//   own `cNN` dir.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
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
const outCore = join(rustDir, "crates/claudius-core/tests/fixtures/prompt_audit_golden.json");
const outServer = join(rustDir, "crates/claudius-server/tests/fixtures/doctor_golden.json");

/** chmod every directory under `p` back to 0755, so it can be removed. */
function openUp(p) {
  let st;
  try {
    st = lstatSync(p);
  } catch {
    return;
  }
  if (!st.isDirectory()) return;
  try {
    chmodSync(p, 0o755);
  } catch {
    return;
  }
  for (const e of readdirSync(p)) openUp(join(p, e));
}

// ------------------------------- recording -------------------------------

if (!process.env.DOCTOR_GOLDEN_ROOT) {
  const runs = [0, 1].map(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "doctor-golden-")));
    try {
      if (!/^[A-Za-z0-9_./-]+$/.test(root)) throw new Error(`root needs escaping: ${root}`);
      for (const d of ["project", "bin"]) mkdirSync(join(root, d));
      const r = spawnSync(
        process.execPath,
        ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url)],
        {
          cwd: join(root, "project"),
          encoding: "utf8",
          maxBuffer: 1 << 28,
          env: {
            PATH: join(root, "bin"),
            HOME: join(root, "home"),
            CLAUDE_CONFIG_DIR: join(root, "config"),
            DOCTOR_GOLDEN_ROOT: root,
          },
        },
      );
      if (r.status !== 0) {
        process.stdout.write(r.stdout);
        process.stderr.write(r.stderr);
        process.exit(r.status ?? 1);
      }
      return [readFileSync(join(root, "core.json"), "utf8"), readFileSync(join(root, "server.json"), "utf8")];
    } finally {
      openUp(root);
      rmSync(root, { recursive: true, force: true });
    }
  });
  for (const i of [0, 1]) {
    if (runs[0][i] !== runs[1][i]) {
      if (process.env.DOCTOR_GOLDEN_DUMP) {
        runs.forEach((r, k) => writeFileSync(`${process.env.DOCTOR_GOLDEN_DUMP}.${i}.${k}.json`, `${JSON.stringify(JSON.parse(r[i]), null, 1)}\n`));
      }
      throw new Error(`the two recordings of fixture ${i} differ`);
    }
  }
  // ASCII-only fixtures: every non-ASCII character as a JSON escape.
  const ascii = (v) => JSON.stringify(v, null, 1).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  const core = JSON.parse(runs[0][0]);
  const server = JSON.parse(runs[0][1]);
  writeFileSync(outCore, `${ascii(core)}\n`);
  writeFileSync(outServer, `${ascii(server)}\n`);
  const requests = server.cases.reduce((n, c) => n + c.steps.filter((s) => s.request).length, 0);
  console.log(
    `wrote ${outCore.slice(repo.length + 1)}: ${core.names.length} names, ${core.patterns.length} pattern texts, ${core.paths.length + core.commands.length} reference texts, ${core.contradictions.length} contradiction sets, ${core.modules.calls.length} module calls`,
  );
  console.log(`wrote ${outServer.slice(repo.length + 1)}: ${server.cases.length} cases, ${requests} requests`);
  process.exit(0);
}

// --------------------------------- child ---------------------------------

const ROOT = process.env.DOCTOR_GOLDEN_ROOT;
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

const Database = (await import("better-sqlite3")).default;
const skillNames = await import(join(repo, "lib/shared/skill-names.ts"));
const skills = await import(join(repo, "lib/server/skills.ts"));
const pa = await import(join(repo, "lib/shared/prompt-audit.ts"));
const telemetry = await import(join(repo, "lib/shared/telemetry-env.ts"));
const slash = await import(join(repo, "lib/shared/slash-commands.ts"));
const claudemd = await import(join(repo, "lib/server/claudemd.ts"));
const audit = await import(join(repo, "lib/server/prompt-audit.ts"));
const doctorRoute = await import(join(repo, "app/api/doctor/route.ts"));
const fixRoute = await import(join(repo, "app/api/doctor/fix/route.ts"));

/** Characters by code point, so this file stays ASCII. */
const U = (...cps) => String.fromCodePoint(...cps);
/** A lone UTF-16 unit. */
const L = (u) => String.fromCharCode(u);
const J = (v) => JSON.stringify(v);

const encodeDir = (s) => s.replace(/[^A-Za-z0-9]/g, "-");
const EROOT = encodeDir(ROOT);
const toAbs = (s) => s.replaceAll("$EROOT", EROOT).replaceAll("$ROOT", ROOT);
const toRel = (s) => s.replaceAll(EROOT, "$EROOT").replaceAll(ROOT, "$ROOT");
/** `f` over every string (keys too) of a JSON value. */
function deep(v, f) {
  if (typeof v === "string") return f(v);
  if (Array.isArray(v)) return v.map((x) => deep(x, f));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [f(k), deep(x, f)]));
  return v;
}
function threwOf(e) {
  return { name: e?.name ?? null, code: e?.code ?? null, message: toRel(e instanceof Error ? e.message : String(e)) };
}

/** mulberry32: the seeded fuzz. */
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
function fuzz(seed, n, alphabet, minLen, maxLen) {
  const r = rng(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    const len = minLen + Math.floor(r() * (maxLen - minLen + 1));
    let s = "";
    for (let k = 0; k < len; k++) s += alphabet[Math.floor(r() * alphabet.length)];
    out.push(s);
  }
  return out;
}

// ---------------------------------- world ----------------------------------

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Every path under the root but `bin` (keys with placeholders), sorted. */
function snapshot() {
  const snap = {};
  const visit = (rel) => {
    const abs = join(ROOT, toAbs(rel));
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      return;
    }
    const name = rel.slice(rel.lastIndexOf("/") + 1);
    if (st.isSymbolicLink()) {
      snap[rel] = { kind: "symlink", target: toRel(readlinkSync(abs)) };
    } else if (st.isDirectory()) {
      snap[rel] = { kind: "dir", mode: st.mode & 0o777 };
      let names = [];
      try {
        names = readdirSync(abs).sort();
      } catch {
        snap[rel].unreadable = true;
      }
      for (const e of names) {
        if (e.endsWith(".claudius.db-wal") || e.endsWith(".claudius.db-shm")) continue;
        visit(`${rel}/${toRel(e)}`);
      }
    } else if (name === ".claudius.db") {
      snap[rel] = { kind: "file", mode: st.mode & 0o777, db: true };
    } else {
      let buf;
      try {
        buf = readFileSync(abs);
      } catch {
        snap[rel] = { kind: "file", mode: st.mode & 0o777, unreadable: true };
        return;
      }
      let text = null;
      try {
        text = utf8.decode(buf);
      } catch {
        // not UTF-8: recorded as bytes
      }
      snap[rel] = text === null ? { kind: "file", mode: st.mode & 0o777, bytes: [...buf] } : { kind: "file", mode: st.mode & 0o777, text: toRel(text) };
    }
  };
  for (const e of readdirSync(ROOT).sort()) {
    if (e === "bin" || e === "core.json" || e === "server.json") continue;
    visit(e);
  }
  return Object.fromEntries(Object.keys(snap).sort().map((k) => [k, snap[k]]));
}

function changes(before, after) {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return keys.filter((k) => J(before[k]) !== J(after[k])).map((k) => [k, after[k] ?? null]);
}

/** The DB file `openDb(cwd)` opens. */
function dbFile(cwd) {
  return join(ROOT, "home/.claude/projects", encodeDir(cwd), ".claudius.db");
}

/** Apply a setup op. */
function apply(op) {
  const p = op.path === undefined ? null : join(ROOT, toAbs(op.path));
  switch (op.op) {
    case "write":
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, op.bytes ? Buffer.from(op.bytes) : toAbs(op.text));
      return;
    case "mkdir":
      mkdirSync(p, { recursive: true });
      return;
    case "rm":
      openUp(p);
      rmSync(p, { recursive: true, force: true });
      return;
    case "symlink":
      mkdirSync(dirname(p), { recursive: true });
      symlinkSync(toAbs(op.target), p);
      return;
    case "chmod":
      chmodSync(p, op.mode);
      return;
    case "sql": {
      const f = dbFile(toAbs(op.cwd));
      mkdirSync(dirname(f), { recursive: true });
      const db = new Database(f);
      db.exec(op.sql);
      db.close();
      return;
    }
    default:
      throw new Error(`unknown op ${op.op}`);
  }
}

const W = (path, text) => ({ op: "write", path, text });
const WB = (path, bytes) => ({ op: "write", path, bytes });
const RM = (path) => ({ op: "rm", path });
const MK = (path) => ({ op: "mkdir", path });
const LN = (path, target) => ({ op: "symlink", path, target });
const CH = (path, mode) => ({ op: "chmod", path, mode });
/** Agent rows for the workspace at `cwd`, in a WAL database as `openDb` leaves it (`wal: false`: a rollback-journal one). */
const SQL = (cwd, rows, wal = true) => ({
  op: "sql",
  cwd,
  sql:
    (wal ? "PRAGMA journal_mode = WAL;\n" : "") +
    "CREATE TABLE db_agents (name TEXT PRIMARY KEY, definition_json TEXT NOT NULL, updated_at INTEGER NOT NULL);\n" +
    rows.map(([n, d, u]) => `INSERT INTO db_agents VALUES ('${n.replaceAll("'", "''")}', '${d.replaceAll("'", "''")}', ${u});\n`).join(""),
});

/** Whether this disk enforces permissions (not root). */
function probePerm() {
  const d = join(ROOT, "perm-probe");
  mkdirSync(d);
  chmodSync(d, 0);
  let enforced = false;
  try {
    readdirSync(d);
  } catch {
    enforced = true;
  }
  chmodSync(d, 0o755);
  rmSync(d, { recursive: true });
  return enforced;
}
const PERM = probePerm();
if (!PERM) throw new Error("record on a disk that enforces permissions (not as root)");

/** Lines `prefix0`..: `n` lines, each newline-terminated. */
const lines = (n, prefix = "line") => Array.from({ length: n }, (_, i) => `${prefix}${i}\n`).join("");

// ---------------------------------- pure ----------------------------------

function flips(f, last) {
  const out = [];
  let prev = false;
  for (let cp = 0; cp <= last; cp++) {
    const c = cp >= 0xd800 && cp <= 0xdfff ? L(cp) : U(cp);
    const v = !!f(c);
    if (v !== prev) {
      out.push(cp);
      prev = v;
    }
  }
  return out;
}

const sweep = {
  valid: flips((c) => skills.isValidSkillDirName(c), 0x10ffff),
  shown: flips((c) => skillNames.isEngineShownName(c), 0x10ffff),
  afterA: flips((c) => skillNames.isEngineShownName(`a${c}`), 0x10ffff),
  beforeDotAbove: flips((c) => skillNames.isEngineShownName(`${c}${U(0x307)}`), 0x10ffff),
  beforeVowelSign: flips((c) => skillNames.isEngineShownName(`${c}${U(0x93f)}`), 0x10ffff),
  cotSpace: flips((c) => pa.findStalePromptPatterns(`think${c}step by step`).length > 0, 0xffff),
  pathChar: flips((c) => pa.extractReferencedPaths(`\`a${c}/b.ts\``).length > 0, 0xffff),
  commandChar: flips((c) => pa.extractReferencedCommands(`\`/a${c}\``).length > 0, 0xffff),
};

const NAME_PICKS = [
  "", "a", "abc", "my-skill", "my_skill.v2", ".hidden", "a.b", "-x", "_x", "x y", " x", "x ", "x  y", "x   y",
  "a:b", "a: b", "a :b", ":a", "a:", "a::b", "a : b", ":", " ", "a b c",
  "x".repeat(256), "x".repeat(257), U(0x1f600).repeat(128), `a${U(0x1f600).repeat(128)}`,
  `caf${U(0xe9)}`, `cafe${U(0x301)}`, `i${U(0x307)}`, `i${U(0x301, 0x307)}`, `i${U(0x323, 0x307)}`, `j${U(0x307)}`,
  `${U(0x456)}${U(0x307)}`, `${U(0x131)}${U(0x301)}`, U(0x237, 0x301), U(0x301), `a${U(0x301).repeat(8)}`, `a${U(0x301).repeat(9)}`,
  `a${U(0x93f)}`, U(0x915, 0x93f), `1${U(0x93f)}`, `1${U(0x301)}`, U(0x915, 0x301), U(0x915, 0x301, 0x93f), `a${U(0x301, 0x93f)}`,
  `a${U(0x1160)}`, U(0x1100, 0x1161), U(0x1100, 0x11a8), U(0xd7b0), `a${U(0xd7b0)}`, U(0x3164), `a${U(0x200b)}b`, `a${U(0xa0)}b`,
  `a${U(0x3000)}b`, "a<b", "a>b", "&lt;", `a${U(0x2028)}`, U(0x2800), U(0xfffc), U(0x1d159), U(0x13441), U(0x16fe4), U(0xe000),
  U(0xf0000), L(0xd800), `a${L(0xdc00)}`, U(0x10ffff), U(0x378), U(0x600), U(0x34f), U(0x17b4), U(0xfe0f), `a${U(0xfe0f)}`,
  U(0x2764, 0xfe0f), U(0x1f44d, 0x1f3fd), `x${U(0x20dd)}`, `x${U(0x345)}`, U(0x5d0, 0x5b4), `a${U(0x5b4)}`, U(0xe01, 0xe31),
  `a${U(0xe31)}`, U(0x661), U(0x212a), `${U(0x212a)}elvin`, U(0x130), `a${U(0x9)}b`, `a${U(0x7f)}`, `a${U(0x85)}`, U(0x1680),
  `a${U(0x180e)}b`, `a${U(0xfeff)}`, `a${U(0x202e)}b`, `a${U(0xad)}b`, `Ab${U(0x3099)}`, `a${U(0x1ab0)}`, U(0x2160), U(0xbc),
  `x${U(0x0300).repeat(3)}${U(0x93f)}`, `${U(0x3a3)}a:b`, "a:b:c", "a: ", " :a", `a${U(0x2009)}:b`,
];
const NAME_ALPHABET = [
  "a", "b", "i", "j", "1", ".", "_", "-", ":", " ", U(0x131), U(0x237), U(0x301), U(0x307), U(0x323), U(0x93f),
  U(0x915), U(0x1160), U(0xd7b0), U(0x3164), U(0xa0), U(0x200b), U(0xfffc), "<", U(0x1f600), L(0xd800), L(0xdc00),
  U(0x20dd), U(0x345), U(0xe9), U(0x5b4), U(0x661), U(0x456), U(0x3099), U(0x212a),
];
const names = [...NAME_PICKS, ...fuzz(22001, 4000, NAME_ALPHABET, 1, 10)].map((n) => [
  n,
  skills.isValidSkillDirName(n),
  skillNames.isEngineShownName(n),
  skillNames.isEngineOfferableName(n),
]);

const PATTERN_PICKS = [
  "", "Think step by step.", "think  step-by-step", "THINK\tABOUT THIS STEP BY STEP", "think about it step by step",
  "think about that step by step", `think${U(0xa0)}step by step`, `think${U(0xfeff)}step by step`, `think${U(0x180e)}step by step`,
  "thinkstep by step", "think step by-step", "think step  by step", "think about this  step by step", "think\n\nstep by step",
  "Let's think this through carefully", "lets think it through carefully", "let's think through carefully",
  `let${U(0x2019)}s think through carefully`, "let's  think through carefully", "LET'S THINK IT THROUGH CAREFULLY",
  "work through this step by step", "working through it step-by-step", "Working Through This Step By Step",
  "workng through this step by step", "work through that step by step",
  "You are a helpful AI assistant", "you are an friendly AI language model", "You are knowledgeable AI",
  "you are a helpful AIassistant", "you are a helpful aid", "you are helpful   AI   assistant", "you are a helpful AI  language model",
  "As an AI language model, I can't", "as an aid", "as an AI", "as an AI_x", "as an AI-model", `a${U(0x17f)} an AI`,
  "claude-2", "Claude 1", "claude-instant-1", "claude-3-opus", "claude 3-sonnet", "claude-3-haiku-20240307", "claude-3",
  "claude-35", "claude-3-5-sonnet", "xclaude-2", "claude-2x", "claude-2.1", "claude_2", "Claude-Instant", "CLAUDE-3-OPUS",
  `claud${U(0xe9)}-2`, `claude-${U(0x2160)}`, "claude--2", "claude-3-opus-", `${U(0xe9)}claude-2`, `claude-2${U(0xe9)}`,
  `${"x".repeat(30)} think step by step ${"y".repeat(30)}`, `a${U(0x1f600).repeat(15)}claude-2${U(0x1f600).repeat(15)}`,
  `${U(0x1f600).repeat(15)}claude-2${U(0x1f600).repeat(9)}b`, `a\n\n\t think \n step by step ${U(0x2028, 0x2029)} z`,
  "claude-2 claude-2 claude-2 think step by step as an AI", "think step by step by step", "  claude-2  ",
  `${" ".repeat(25)}claude-2${"\n".repeat(25)}`,
];
const PATTERN_TOKENS = [
  "think", "Think", " ", "  ", "\n", "\t", U(0xa0), U(0x2028), "about ", "this ", "it ", "step", "-", "by", "step-by-step",
  "let's", "lets", `let${U(0x2019)}s`, " through", "carefully", "work", "working", "you are", "a ", "an ", "helpful",
  "friendly", "AI", "ai", "aid", "assistant", "language model", "as an", "claude", "claude-1", "claude 2", "claude-instant",
  "claude-3-opus", "claude-3-sonnet", "Claude-3-Haiku", "claude-3", "x", "_", U(0xe9), U(0x17f), U(0x1f600), L(0xd800), ".",
];
const patterns = [...PATTERN_PICKS, ...fuzz(22002, 1500, PATTERN_TOKENS, 1, 25)].map((t) => [t, pa.findStalePromptPatterns(t)]);

const PATH_PICKS = [
  "", "`lib/server/session.ts`", "`a/b.c`", "`a.b`", "`./a/b.ts`", "`../x/y.md`", "`a/b`", "`a/b.toolongext`",
  "`a/b.abcdefgh`", "`a/b.c.d`", "`a/b-c_d.e1`", "`/abs/path.ts`", "`a//b.ts`", `\`a/${U(0xe9)}.ts\``, "``a/b.ts``",
  "`a/b.ts` and `a/b.ts` again", "`a/b.ts`x", "x`a/b.ts`", "`a /b.ts`", "`a/b.ts `", "`.claude/rules/x.md`", "`a/b.TS`",
  "`a/b.ts`\n`c/d.json`", "`a/b.`", "`a/.ts`", "`-/-.-`", "`a/b.ts", "a/b.ts`", "`a/b/c/d/e.f`", "`a/b.t_s`",
];
const COMMAND_PICKS = [
  "", "`/help`", "`/help me`", "`/Help`", "`/a-b_c`", "`/api/x`", "`/dir:x`", "`/mcp__srv__p`", "`/x `", "`/x\tq`",
  "`/x y`z`", "`/1x`", "`/`", `\`/x${U(0xe9)}\``, "`/x`/y`", "`/x` `/x`", "``/x``", "`/mcp__`", "`/mcp_x`", "`/x-`",
  "`/x  y`", "`/x\ny`", "/x", "`/ x`", "`//x`",
];
const REF_TOKENS = ["`", "/", "a", "Z", "1", "-", "_", ".", " ", "mcp__", "help", U(0xe9), ":", "\n", "x", "ts", "/b.ts", "``"];
const paths = [...PATH_PICKS, ...fuzz(22003, 1500, REF_TOKENS, 1, 16)].map((t) => [t, pa.extractReferencedPaths(t)]);
const commands = [...COMMAND_PICKS, ...fuzz(22004, 1500, REF_TOKENS, 1, 16)].map((t) => [t, pa.extractReferencedCommands(t)]);

const S = (id, text) => ({ id, text });
const CONTRA_PICKS = [
  [],
  [S("a", "Always use `pnpm`."), S("b", "Never use `pnpm`.")],
  [S("a", "Always use `pnpm`."), S("a", "Never use `pnpm`.")],
  [S("a", "Always `x`. Never `x`.")],
  [S("a", "Always `x` but never `x`"), S("b", "never `x`")],
  [S("a", "You must use `x`"), S("b", "You must not use `x`")],
  [S("a", "You must  not use `x`"), S("b", "never `x`")],
  [S("a", "MUST NOT `x`"), S("b", "ALWAYS `x`")],
  [S("a", "mustn't `x`"), S("b", "never `x`")],
  [S("a", "don't `x`; dont `y`; do not `z`; avoid `w`"), S("b", "always `x` `y` `z` `w`")],
  [S("a", "only use `x`"), S("b", "only  use `x`"), S("c", "avoid `x`")],
  [S("a", "alwaysx `x`"), S("b", "never `x`")],
  [S("a", "_always `x`"), S("b", "never `x`")],
  [S("a", "always_ `x`"), S("b", "never `x`")],
  [S("a", "always ` x `"), S("b", "never `x`")],
  [S("a", "always `  `"), S("b", "never `  `")],
  [S("a", "e.g. always `x`"), S("b", "e\nnever `x`")],
  [S("b", "always `x`"), S("a", "never `x`"), S("B", "never `x`"), S(U(0xe9), "always `x`")],
  [S("a", "always `x` `y`\nnever `z`"), S("b", "never `y`;always `z`. never `x`")],
  [S("a", ""), S("b", "never `x`")],
  [S("a", "always `x`"), S("b", "never `x`"), S("c", "never `x`"), S("d", "always `x`")],
  [S("a", `always \`${U(0x1f600)}\``), S("b", `never \`${U(0x1f600)}\``)],
  [S("a", "always `a.b`"), S("b", "never `a.b`")],
  [S("a", "Always `x"), S("b", "never x`")],
  [S("a", `always \`x${U(0xa0)}\``), S("b", `never \`${U(0x2028)}x\``)],
];
const CONTRA_TOKENS = [
  "always ", "never ", "must ", "must not ", "don't ", "dont ", "do not ", "avoid ", "only use ", "`x`", "`y`", "` x `",
  ". ", "; ", "\n", "use ", "MUST NOT ", "Always", "`", "x", "Never", "must  not ",
];
const contraFuzz = (() => {
  const r = rng(22005);
  const texts = fuzz(22006, 1600, CONTRA_TOKENS, 0, 12);
  const out = [];
  let t = 0;
  for (let i = 0; i < 400; i++) {
    const n = 1 + Math.floor(r() * 4);
    const set = [];
    for (let k = 0; k < n; k++) set.push(S(["a", "b", "c", "A"][Math.floor(r() * 4)], texts[t++ % texts.length]));
    out.push(set);
  }
  return out;
})();
const contradictions = [...CONTRA_PICKS, ...contraFuzz].map((s) => [s, pa.findInstructionContradictions(s)]);

const TELEMETRY_PICKS = [
  "absent", null, "OTEL_X", 5, true, [], ["OTEL_X"], {}, { OTEL_A: "1" },
  { otel_b: "1", OTELC: "1", OTEL: "1", otel_: "1", x_OTEL_: "1", OTEL_: "1" },
  { CLAUDE_CODE_ENABLE_TELEMETRY: "1", claude_code_enable_telemetry: "1", "Claude_Code_Enable_Telemetry ": "1" },
  {
    CLAUDE_CODE_DISABLE_ATTACHMENTS: "1",
    [`claude_code_d${U(0x131)}sable_attachments`]: "1",
    [`claude_code_disable_attachment${U(0x17f)}`]: "1",
    CLAUDE_CODE_DISABLE_ATTACHMENT: "1",
  },
  { 2: "x", 1: "y", OTEL_Z: "1", 0: "z" },
  { [`${U(0x1f600)}OTEL_`]: "1", [`OTEL_${L(0xd800)}`]: "1", [`o${U(0x1e6e)}el_x`]: "1" },
  { [`CLAUDE_CODE_ENABLE_TELEMETR${U(0x1ef3)}`]: "1", [`claude_code_enable_telemetr${U(0xff59)}`]: "1" },
  { OTEL_A: null, CLAUDE_CODE_DISABLE_ATTACHMENTS: { x: 1 } },
];
const telemetryCases = TELEMETRY_PICKS.map((env) => {
  const v = env === "absent" ? undefined : env;
  return [env, telemetry.ignoredTelemetryEnvKeys(v), telemetry.ignoredAttachmentsEnvKeys(v)];
});

const registry = slash.SLASH_COMMANDS.map((c) => [c.id, c.name, c.aliases ?? []]);
const queries = [
  ...new Set([
    ...registry.flatMap(([, name, aliases]) => [name, ...aliases]),
    "", "HELP", "Help", "help ", " help", "__proto__", "constructor", "toString", "hasOwnProperty", "nope", "mcp",
  ]),
];
const lookups = queries.map((q) => [q, slash.findSlashCommand(q)?.id ?? null]);

// --------------------------------- modules ---------------------------------

const MOD_WORLD = [
  W("home/.claude/CLAUDE.md", "Never use `pnpm`.\nAlways use `yarn`.\n@shared.md\n"),
  W("home/.claude/shared.md", "shared user text\n"),
  W("home/.claude/skills/userskill/SKILL.md", "---\nname: userskill\ndescription: user\n---\nbody\n"),
  W("home/.claude/skills/Zeta/SKILL.md", "no frontmatter\n"),
  W("home/.claude/commands/usercmd.md", "user command\n"),
  // The rich project.
  W("m/proj/CLAUDE.md", [
    "# Project",
    "Think step by step before answering.",
    "@notes.md",
    "  @sub/deep.md  ",
    "@missing.md",
    "@CLAUDE.md",
    "@$ROOT/m/abs.md",
    "@../outside.md",
    "@dir",
    "See `src/main.ts`, `src/missing.ts`, `../escape/x.ts`, `docs/gone.md`.",
    "Run `/help`, `/nope`, `/mycmd arg`, `/myskill`, `/userskill`, `/usercmd`, `/mcp__x__y`, `/other`, `/kelvin`, `/dir`.",
    "Always use `pnpm`.",
    "",
  ].join("\n")),
  W("m/proj/notes.md", "notes line\n@sub/deep.md\n"),
  W("m/proj/sub/deep.md", "deep 1\n@d2.md\n"),
  W("m/proj/sub/d2.md", "@d3.md\n"),
  W("m/proj/sub/d3.md", "@d4.md\n"),
  W("m/proj/sub/d4.md", "@d5.md\n"),
  W("m/proj/sub/d5.md", "@d6.md\n"),
  W("m/proj/sub/d6.md", "too deep\n"),
  MK("m/proj/dir"),
  W("m/abs.md", "absolute import\n"),
  W("m/outside.md", "outside import\n"),
  W("m/proj/src/main.ts", "export {};\n"),
  W("m/proj/.claude/CLAUDE.md", "Always run `npm`. Never use `yarn`.\n"),
  W("m/proj/CLAUDE.local.md", "As an AI language model\n`/another-missing`\n`lib/x.ts`\n"),
  W("m/proj/.claude/skills/myskill/SKILL.md", "---\nname: myskill\ndescription: d\n---\nLet's think this through carefully.\n`/ghost`\n"),
  W(`m/proj/.claude/skills/${U(0x212a)}elvin/SKILL.md`, "---\nname: kelvin\n---\nk\n"),
  W(`m/proj/.claude/skills/ghost${U(0x3164)}/SKILL.md`, "hidden\n"),
  W("m/proj/.claude/skills/b-skill/SKILL.md", "---\ndescription: [unclosed\n---\nbody\n"),
  W(`m/proj/.claude/skills/${U(0xe9)}clair/SKILL.md`, "---\nname: e\n---\n"),
  W("m/proj/.claude/skills/.dot/SKILL.md", "dot\n"),
  W("m/proj/.claude/skills/bad name/SKILL.md", "bad\n"),
  MK("m/proj/.claude/skills/empty"),
  W("m/proj/.claude/skills/file.md", "a file, not a skill\n"),
  WB("m/proj/.claude/skills/bytes/SKILL.md", [0x2d, 0x2d, 0x2d, 0x0a, 0x6e, 0x3a, 0x20, 0xff, 0x0a, 0x2d, 0x2d, 0x2d, 0x0a, 0x62, 0x0a]),
  MK("m/proj/.claude/skills/dirskill/SKILL.md"),
  W("m/outside-skill/SKILL.md", "linked\n"),
  LN("m/proj/.claude/skills/linked", "$ROOT/m/outside-skill"),
  W("m/proj/.claude/commands/mycmd.md", "Work through this step by step\n"),
  W("m/proj/.claude/commands/Other.MD", "`/mycmd`\n`/other`\n"),
  MK("m/proj/.claude/commands/dir.md"),
  W("m/proj/.claude/commands/notes.txt", "`/x`\n"),
  W("m/cmd-target.md", "linked command claude-2\n"),
  LN("m/proj/.claude/commands/linked.md", "$ROOT/m/cmd-target.md"),
  SQL("$ROOT/m/proj", [
    ["reviewer", '{"description":"You are a helpful AI assistant","prompt":"Think step by step. Run `/nope2`."}', 1],
    ["writer", '{"description":"d","prompt":"   "}', 2],
    ["bad name", '{"description":"d","prompt":"p"}', 3],
    ["zeta", '{"description":"Always use `npm`.","prompt":"p"}', 4],
    ["broken", '{"description":', 5],
  ]),
  // AGENTS.md fallbacks, a scope that is a directory, an unreadable one.
  W("m/agents-only/AGENTS.md", "Never use `npm`.\nclaude-2\n"),
  W("m/both/AGENTS.md", "agents\n"),
  W("m/both/CLAUDE.md", "claude\n"),
  MK("m/claude-dir/CLAUDE.md"),
  W("m/unreadable/CLAUDE.md", "secret\n"),
  CH("m/unreadable/CLAUDE.md", 0),
  W("m/blank/CLAUDE.md", "  \n\t\n"),
  W("m/bom/CLAUDE.md", `${U(0xfeff)}claude-2\n`),
  MK("m/empty"),
  W("m/skills-file/.claude/skills", "not a dir\n"),
  W("m/skills-file/CLAUDE.md", "x\n"),
  W("m/rel/CLAUDE.md", "relative claude-2\n"),
  W("m/link-md/real.md", "linked CLAUDE.md, as an AI\n"),
  LN("m/link-md/CLAUDE.md", "$ROOT/m/link-md/real.md"),
  W("m/cycle/CLAUDE.md", "@a.md\n"),
  W("m/cycle/a.md", "@b.md\n"),
  W("m/cycle/b.md", "@a.md\nback\n"),
];

const MOD_CWDS = [
  "$ROOT/m/proj", "$ROOT/m/proj/", "$ROOT/m/../m/proj", "$ROOT/m/agents-only", "$ROOT/m/both", "$ROOT/m/claude-dir",
  "$ROOT/m/unreadable", "$ROOT/m/blank", "$ROOT/m/bom", "$ROOT/m/empty", "$ROOT/m/nowhere", "$ROOT/m/skills-file",
  "../m/rel", "$ROOT/m/link-md", "$ROOT/m/cycle", "", `$ROOT/m/nul${U(0)}x`,
];

async function call(name, args) {
  const fns = {
    readScope: claudemd.readScope,
    resolveHierarchy: claudemd.resolveHierarchy,
    listSkills: skills.listSkills,
    auditWorkspacePrompts: audit.auditWorkspacePrompts,
  };
  const rec = { call: [name, ...args] };
  if (args.some((a) => a.includes("unreadable"))) rec.needs = "perm";
  try {
    rec.result = deep(await fns[name](...args.map(toAbs)), toRel);
  } catch (e) {
    rec.threw = threwOf(e);
  }
  return rec;
}

// The modules world sits beside the route cases: it is built, called and
// removed before them.
for (const op of MOD_WORLD) apply(op);
const moduleCalls = [];
for (const cwd of MOD_CWDS) {
  for (const scope of ["user", "project", "project-claude", "local"]) moduleCalls.push(await call("readScope", [scope, cwd]));
  moduleCalls.push(await call("resolveHierarchy", [cwd]));
  for (const scope of ["project", "user"]) moduleCalls.push(await call("listSkills", [scope, cwd]));
  moduleCalls.push(await call("auditWorkspacePrompts", [cwd]));
}

writeFileSync(
  join(ROOT, "core.json"),
  J({
    sweep,
    names,
    patterns,
    paths,
    commands,
    contradictions,
    telemetry: telemetryCases,
    slash: { registry, lookups },
    modules: { setup: MOD_WORLD, calls: moduleCalls },
  }),
);

// --------------------------------- routes ---------------------------------

const ENV_KEYS = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "DISABLE_PROMPT_CACHING"];
const PKG = "project/node_modules/@anthropic-ai/claude-agent-sdk/package.json";
const GIT_OK = "printf 'git version 2.50.1\\n'";
const WSF = "home/.claude/.claudius/workspaces.json";
const wsFile = (list) => W(WSF, `${J({ version: 1, workspaces: list }, null, 2)}\n`);
const ws = (id, name, rootPath, extra = {}) => ({ id, name, rootPath, ...extra });

const BASE = [
  MK("home/.claude/projects"),
  W("home/.claude/.credentials.json", "{}\n"),
  W(PKG, `${J({ name: "@anthropic-ai/claude-agent-sdk", version: "0.3.299", claudeCodeVersion: "2.1.299" })}\n`),
];

const GET = { request: { method: "GET", path: "/api/doctor" } };
const FIX = (body, as) => ({ request: { method: "POST", path: "/api/doctor/fix", body }, ...(as === undefined ? {} : { as }) });
const FIXID = (id) => FIX(J({ id }));
const setup = (...ops) => ({ setup: ops });

/** The cases, each a function of its own dir (`cNN`). */
const CASES = [
  () => ({ name: "healthy", steps: [GET] }),
  () => ({ name: "no-claude-dir", steps: [setup(RM("home/.claude")), GET, FIXID("claude-dir"), GET, FIXID("projects-dir"), GET] }),
  () => ({ name: "no-home", steps: [setup(RM("home")), GET, FIXID("projects-dir"), GET] }),
  () => ({
    name: "projects-missing",
    steps: [setup(RM("home/.claude/projects")), GET, FIXID("projects-dir"), FIXID("projects-dir"), GET],
  }),
  () => ({
    name: "claude-dir-read-only",
    needs: "perm",
    steps: [setup(CH("home/.claude", 0o555)), GET, FIXID("claude-dir"), FIXID("projects-dir"), setup(CH("home/.claude", 0o755))],
  }),
  () => ({
    name: "read-only-no-projects",
    needs: "perm",
    steps: [setup(RM("home/.claude/projects"), CH("home/.claude", 0o555)), GET, FIXID("projects-dir"), FIXID("claude-dir"), setup(CH("home/.claude", 0o755))],
  }),
  () => ({ name: "projects-read-only", needs: "perm", steps: [setup(CH("home/.claude/projects", 0o555)), GET, FIXID("projects-dir"), setup(CH("home/.claude/projects", 0o755))] }),
  () => ({ name: "projects-write-only", needs: "perm", steps: [setup(CH("home/.claude/projects", 0o333)), GET, setup(CH("home/.claude/projects", 0o755))] }),
  () => ({
    name: "home-read-only",
    needs: "perm",
    steps: [setup(RM("home/.claude"), CH("home", 0o555)), GET, FIXID("claude-dir"), FIXID("projects-dir"), setup(CH("home", 0o755))],
  }),
  () => ({ name: "claude-dir-file", steps: [setup(RM("home/.claude"), W("home/.claude", "x\n")), GET, FIXID("claude-dir"), FIXID("projects-dir")] }),
  () => ({ name: "projects-file", steps: [setup(RM("home/.claude/projects"), W("home/.claude/projects", "x\n")), GET, FIXID("projects-dir")] }),
  (C) => ({
    name: "claude-dir-symlink",
    steps: [setup(RM("home/.claude"), MK(`${C}/real`), LN("home/.claude", `$ROOT/${C}/real`)), GET, FIXID("projects-dir"), GET],
  }),
  (C) => ({
    name: "claude-dir-dangling",
    steps: [setup(RM("home/.claude"), LN("home/.claude", `$ROOT/${C}/none`)), GET, FIXID("claude-dir"), FIXID("projects-dir")],
  }),
  (C) => ({
    name: "projects-symlink",
    steps: [setup(RM("home/.claude/projects"), LN("home/.claude/projects", `$ROOT/${C}/gone`)), GET, FIXID("projects-dir"), setup(MK(`${C}/gone`)), GET],
  }),
  (C) => ({
    name: "creds-variants",
    steps: [
      setup(RM("home/.claude/.credentials.json")), GET,
      setup(MK("home/.claude/.credentials.json")), GET,
      setup(RM("home/.claude/.credentials.json"), LN("home/.claude/.credentials.json", `$ROOT/${C}/none`)), GET,
      setup(W(`${C}/creds`, "{}"), RM("home/.claude/.credentials.json"), LN("home/.claude/.credentials.json", `$ROOT/${C}/creds`)), GET,
    ],
  }),
  () => ({
    name: "sdk-variants",
    steps: [
      ...[
        null, "{", "null", "[]", '"str"', "5", '{"version":"1.2.3"}', '{"version":"1.2.3","claudeCodeVersion":""}',
        '{"version":"1.2.3","claudeCodeVersion":0}', '{"version":"1.2.3","claudeCodeVersion":1}', '{"claudeCodeVersion":"2"}',
        '{"version":null}', '{"version":5}', '{"version":{"a":1,"2":"b","1":"c"}}', '{"version":["1","2"],"claudeCodeVersion":["x"]}',
        '{"version":{"toString":1},"claudeCodeVersion":"2"}', '{"version":"1","claudeCodeVersion":{"toString":1}}',
        '{"version":"1","claudeCodeVersion":{}}', '{"version":"\\ud800x"}', `${U(0xfeff)}{"version":"1"}`, '{"version":"1","version":"2"}',
        '{"version":"1","claudeCodeVersion":true}', '{"version":1e21,"claudeCodeVersion":"x"}', '{"version":1e21}', '{"version":-0}',
        '{"version":-0,"claudeCodeVersion":"c"}', '{"version":0.1,"claudeCodeVersion":1e-7}', ' {"version":"ws"} \n',
        '{"version":"caf\\u00e9","claudeCodeVersion":"\\u2028"}', '{"__proto__":{"version":"p"}}', '{"version":"1"} x',
      ].flatMap((text) => [setup(text === null ? RM(PKG) : W(PKG, text)), GET]),
      setup(WB(PKG, [0x7b, 0x22, 0x76, 0x65, 0x72, 0x73, 0x69, 0x6f, 0x6e, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d])), GET,
      setup(RM(PKG), MK(PKG)), GET,
      setup(RM(PKG), LN(PKG, "$ROOT/project/real-package.json"), W("project/real-package.json", '{"version":"linked"}')), GET,
      setup(RM(PKG), RM("project/real-package.json")),
    ],
  }),
  () => ({
    name: "node-versions",
    steps: ["20.0.0", "19.9.9", "18.0.0", "17.9.1", "abc", "", "v20.1.0", " 20.1.0", "0x14.0", "1e2.0", "20", "Infinity.0", "-1.0", "22.23.3"].flatMap(
      (v) => [{ node: v }, GET],
    ),
  }),
  () => ({
    name: "git-variants",
    steps: [
      null, "exit 1", "printf '  \\n'", "printf 'oops\\n' >&2", "printf 'git version 2.50.1 (Apple Git-155)\\r\\n'",
      "printf '\\302\\240git\\342\\200\\250\\n'", "printf 'caf\\303\\251\\n'", "printf 'bad\\377\\n'", "printf 'x\\n'; exit 3",
      "/usr/bin/yes x | /usr/bin/head -c 1100000", "exec /bin/sleep 5", "kill -9 $$", "dir", "noexec", "printf 'a\\nb\\n\\n'",
      "printf '\\357\\273\\277git\\n'", "printf '\\302\\205git\\302\\205\\n'", GIT_OK,
    ].flatMap((g) => [{ git: g }, GET]),
  }),
  () => ({ name: "env-api-key", env: { ANTHROPIC_API_KEY: "sk-test" }, steps: [GET, setup(RM("home/.claude/.credentials.json")), GET] }),
  () => ({
    name: "env-empty",
    env: { ANTHROPIC_API_KEY: "", CLAUDE_CODE_USE_BEDROCK: "true", CLAUDE_CODE_USE_VERTEX: " 1", DISABLE_PROMPT_CACHING: "" },
    steps: [setup(RM("home/.claude/.credentials.json")), GET],
  }),
  () => ({ name: "env-bedrock-vertex", env: { CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_USE_VERTEX: "1" }, steps: [setup(RM("home/.claude/.credentials.json")), GET] }),
  () => ({ name: "env-vertex-cache", env: { CLAUDE_CODE_USE_VERTEX: "1", DISABLE_PROMPT_CACHING: "0" }, steps: [GET] }),
  () => ({ name: "env-foundry-key", env: { CLAUDE_CODE_USE_FOUNDRY: "1", ANTHROPIC_API_KEY: "k", DISABLE_PROMPT_CACHING: "1" }, steps: [GET] }),
  (C) => ({
    name: "ws-clean",
    steps: [setup(wsFile([ws("wks_a", "Alpha", `$ROOT/${C}/a`)]), W(`${C}/a/CLAUDE.md`, "hello\n")), GET, GET],
  }),
  (C) => ({
    name: "ws-kinds",
    steps: [
      setup(
        wsFile([
          ws("wks_custom", "Custom", `$ROOT/${C}/custom`, { kind: "customization" }),
          ws("wks_null", "Null kind", `$ROOT/${C}/null`, { kind: null }),
          ws("wks_none", "No kind", `$ROOT/${C}/none`),
          ws("wks_cap", "Capital", `$ROOT/${C}/cap`, { kind: "Project" }),
          ws("wks_num", "Number", `$ROOT/${C}/num`, { kind: 5 }),
          ws("wks_proj", "Project", `$ROOT/${C}/proj`, { kind: "project" }),
        ]),
        ...["custom", "null", "none", "cap", "num", "proj"].map((d) => W(`${C}/${d}/CLAUDE.md`, d === "custom" ? lines(400) : "x\n")),
      ),
      GET,
    ],
  }),
  (C) => ({
    name: "ws-odd-entries",
    steps: [
      setup(wsFile([5, ws("wks_a", "A", `$ROOT/${C}/a`)]), W(`${C}/a/CLAUDE.md`, "x\n")), GET,
      setup(wsFile(["str", ws("wks_a", "A", `$ROOT/${C}/a`)])), GET,
      setup(wsFile([[1], ws("wks_a", "A", `$ROOT/${C}/a`)])), GET,
      setup(wsFile([{ kind: "customization" }, ws("wks_a", "A", `$ROOT/${C}/a`)])), GET,
      setup(wsFile([ws("wks_a", "A", `$ROOT/${C}/a`), null])), GET,
      setup(W(WSF, "{")), GET,
      setup(W(WSF, '{"version":2,"workspaces":[]}')), GET,
      setup(W(WSF, '{"version":1,"workspaces":{}}')), GET,
      setup(RM(WSF), MK(WSF)), GET,
      setup(RM(WSF)),
    ],
  }),
  (C) => ({
    name: "ws-none-sources",
    steps: [setup(wsFile([ws("wks_e", "Empty", `$ROOT/${C}/empty`), ws("wks_m", "Missing", `$ROOT/${C}/missing`)]), MK(`${C}/empty`)), GET],
  }),
  (C) => ({
    name: "ws-size",
    steps: [
      setup(wsFile([ws("wks_s", "Sized", `$ROOT/${C}/s`)]), W(`${C}/s/CLAUDE.md`, lines(300, "l"))), GET,
      setup(W(`${C}/s/CLAUDE.md`, lines(301, "l"))), GET,
      setup(W(`${C}/s/CLAUDE.md`, `${lines(300, "l")}last`)), GET,
      setup(W(`${C}/s/CLAUDE.md`, `${lines(300, "l")}\n`)), GET,
      setup(W(`${C}/s/CLAUDE.md`, `${"x".repeat(1535)}\n${lines(300)}`)), GET,
      setup(W(`${C}/s/CLAUDE.md`, `${U(0x1f600).repeat(200)}\n${lines(300)}`)), GET,
      setup(W(`${C}/s/CLAUDE.md`, "\n".repeat(301))), GET,
      setup(W(`${C}/s/CLAUDE.md`, "\r\n".repeat(301))), GET,
    ],
  }),
  (C) => ({
    name: "ws-size-sources",
    steps: [
      setup(
        wsFile([ws("wks_s", "Sources", `$ROOT/${C}/s`)]),
        W(`${C}/s/CLAUDE.md`, "@notes.md\n"),
        W(`${C}/s/notes.md`, lines(200)),
        W(`${C}/s/.claude/rules/a.md`, lines(100)),
        W(`${C}/s/.claude/rules/b.txt`, lines(100)),
        W(`${C}/s/.claude/rules/c.MD`, lines(100)),
        W("home/.claude/rules/u.md", lines(10)),
        W(`${C}/s/CLAUDE.local.md`, "local\n"),
      ),
      GET,
      setup(RM(`${C}/s/CLAUDE.md`), RM(`${C}/s/CLAUDE.local.md`), W(`${C}/s/.claude/rules/a.md`, lines(300))), GET,
      setup(W(`${C}/s/.claude/rules/bad name.md`, lines(400))), GET,
      setup(MK(`${C}/s/.claude/rules/dir.md`)), GET,
    ],
  }),
  (C) => ({
    name: "ws-user-big",
    steps: [
      setup(
        wsFile([ws("wks_1", "One", `$ROOT/${C}/one`), ws("wks_2", "Two", `$ROOT/${C}/two`), ws("wks_3", "Three", `$ROOT/${C}/missing`)]),
        W("home/.claude/CLAUDE.md", lines(400)),
        W(`${C}/two/CLAUDE.md`, "two\n"),
        MK(`${C}/one`),
      ),
      GET,
    ],
  }),
  (C) => ({
    name: "ws-root-types",
    steps: [
      [5, true, null, "", `$ROOT/${C}/nul${U(0)}x`, { a: 1 }, ["x"]].flatMap((root) => [setup(wsFile([ws("wks_r", "Root", root)])), GET]),
      setup(wsFile([{ id: "wks_r", name: "No root" }])), GET,
      setup(wsFile([ws("wks_r", "Relative", "rel")]), W("project/rel/CLAUDE.md", "relative claude-2\n")), GET,
      setup(wsFile([ws("wks_r", "Slash", `$ROOT/${C}/a/`)]), W(`${C}/a/CLAUDE.md`, "slash\n")), GET,
      setup(wsFile([ws("wks_r", "Dots", `$ROOT/${C}/x/../a`)])), GET,
      setup(wsFile([ws("wks_r", "Uni", `$ROOT/${C}/caf${U(0xe9)}`)]), W(`${C}/caf${U(0xe9)}/CLAUDE.md`, "as an AI\n")), GET,
      setup(RM("project/rel")),
    ].flat(),
  }),
  (C) => ({
    name: "ws-id-name",
    steps: [
      setup(wsFile([ws({ a: 1 }, [1, 2], `$ROOT/${C}/a`)]), W(`${C}/a/CLAUDE.md`, lines(301))), GET,
      setup(wsFile([ws(7, null, `$ROOT/${C}/a`), { name: "no id", rootPath: `$ROOT/${C}/a` }, { id: "no-name", rootPath: `$ROOT/${C}/a` }])), GET,
      setup(wsFile([ws({ toString: 1 }, "Obj", `$ROOT/${C}/a`)])), GET,
      setup(wsFile([ws("wks_n", { toString: 1, valueOf: 1 }, `$ROOT/${C}/a`)])), GET,
      setup(W(`${C}/a/CLAUDE.md`, "small\n")), GET,
      setup(wsFile([ws({ toString: 1 }, "Obj", `$ROOT/${C}/b`)]), MK(`${C}/b`)), GET,
      setup(wsFile([ws("wks_u", `half ${L(0xd83d)} pair`, `$ROOT/${C}/a`)])), GET,
      setup(wsFile([ws(`id/${U(0xe9)}`, `<b>&${U(0x1f600)}`, `$ROOT/${C}/a`)])), GET,
    ],
  }),
  (C) => ({
    name: "ws-unreadable",
    needs: "perm",
    steps: [
      setup(wsFile([ws("wks_u", "Unreadable", `$ROOT/${C}/u`)]), W(`${C}/u/CLAUDE.md`, "x\n"), CH(`${C}/u/CLAUDE.md`, 0)), GET,
      setup(CH(`${C}/u/CLAUDE.md`, 0o644), W(`${C}/u/.claude/rules/r.md`, "r\n"), CH(`${C}/u/.claude/rules/r.md`, 0)), GET,
      setup(CH(`${C}/u/.claude/rules/r.md`, 0o644), CH(`${C}/u/.claude/rules`, 0)), GET,
      setup(CH(`${C}/u/.claude/rules`, 0o755), W(`${C}/u/.claude/skills/s/SKILL.md`, "claude-2\n"), CH(`${C}/u/.claude/skills`, 0)), GET,
      setup(CH(`${C}/u/.claude/skills`, 0o755), W(`${C}/u/.claude/commands/c.md`, "claude-2\n"), CH(`${C}/u/.claude/commands/c.md`, 0)), GET,
      setup(CH(`${C}/u/.claude/commands/c.md`, 0o644), W(`${C}/u/.claude/settings.json`, '{"env":{"OTEL_A":"1"}}'), CH(`${C}/u/.claude/settings.json`, 0)), GET,
      setup(CH(`${C}/u/.claude/settings.json`, 0o644), CH(`${C}/u`, 0o311)), GET,
      setup(CH(`${C}/u`, 0o755)),
    ],
  }),
  (C) => ({
    name: "ws-claude-md-dir",
    steps: [
      setup(wsFile([ws("wks_d", "Dir", `$ROOT/${C}/d`)]), MK(`${C}/d/CLAUDE.md`)), GET,
      setup(RM(`${C}/d/CLAUDE.md`), MK(`${C}/d/.claude/CLAUDE.md`)), GET,
      setup(RM(`${C}/d/.claude/CLAUDE.md`), MK(`${C}/d/AGENTS.md`)), GET,
      setup(RM(`${C}/d/AGENTS.md`), MK("home/.claude/CLAUDE.md")), GET,
      setup(RM("home/.claude/CLAUDE.md"), MK(`${C}/d/.claude/rules/x.md`)), GET,
    ],
  }),
  (C) => {
    const R = `$ROOT/${C}/r`;
    return {
      name: "ws-audit-rich",
      steps: [
        setup(
          wsFile([ws("wks_rich", "Rich", R)]),
          W(`${C}/r/CLAUDE.md`, [
            "# Project",
            "Think step by step before answering.",
            "You are a helpful AI assistant.",
            "Use claude-2 for drafts and claude-3-opus for reviews; claude-instant is gone.",
            "See `src/main.ts`, `src/missing.ts`, `docs/gone.md`, `../escape/x.ts`, `linked/x.md` and `src/main.ts` again.",
            "Run `/help`, `/nope`, `/mycmd arg`, `/myskill`, `/hidden-skill`, `/mcp__x__y`, `/Review`, `/checkup`, `/other`, `/kelvin`, `/usercmd`, `/userskill`.",
            "Always use `pnpm`.",
            "Never use `npm`.",
            "",
          ].join("\n")),
          W(`${C}/r/src/main.ts`, "export {};\n"),
          W(`${C}/outside/x.md`, "x\n"),
          LN(`${C}/r/linked`, `$ROOT/${C}/outside`),
          W(`${C}/r/.claude/CLAUDE.md`, "Always run `npm`. Never use `yarn`.\n"),
          W(`${C}/r/CLAUDE.local.md`, "As an AI language model\n`/another-missing`\n`lib/x.ts`\n"),
          W("home/.claude/CLAUDE.md", "Never use `pnpm`.\nAlways use `yarn`.\n"),
          W(`${C}/r/.claude/skills/myskill/SKILL.md`, "---\nname: myskill\ndescription: d\n---\nLet's think this through carefully.\n`/ghost`\n"),
          W(`${C}/r/.claude/skills/${U(0x212a)}elvin/SKILL.md`, "k\n"),
          W(`${C}/r/.claude/skills/ghost${U(0x3164)}/SKILL.md`, "hidden claude-1\n"),
          W(`${C}/r/.claude/commands/mycmd.md`, "Work through this step by step\n"),
          W(`${C}/r/.claude/commands/Other.MD`, "`/mycmd`\n`/other`\n"),
          MK(`${C}/r/.claude/commands/dir.md`),
          W("home/.claude/commands/usercmd.md", "u\n"),
          W("home/.claude/skills/userskill/SKILL.md", "u\n"),
          SQL(R, [
            ["reviewer", '{"description":"You are a helpful AI assistant","prompt":"Think step by step. Run `/nope2`."}', 1],
            ["writer", '{"description":"d","prompt":"   "}', 2],
            ["zeta", '{"description":"Always use `npm`.","prompt":"p"}', 3],
          ]),
        ),
        GET,
      ],
    };
  },
  (C) => ({
    name: "ws-audit-links",
    steps: [
      setup(
        wsFile([
          ws("wks_skill", "Skill", `$ROOT/${C}/s`),
          ws("wks_agent", "Agent", `$ROOT/${C}/a`),
          ws("wks_cmd", "Command", `$ROOT/${C}/c`),
          ws("wks_mix", "Mix", `$ROOT/${C}/m`),
          ws("wks_wal", "Journal", `$ROOT/${C}/j`),
        ]),
        W(`${C}/s/.claude/skills/s/SKILL.md`, "Think step by step\n"),
        MK(`${C}/a`),
        SQL(`$ROOT/${C}/a`, [["helper", '{"description":"as an AI","prompt":"p"}', 1]]),
        W(`${C}/c/.claude/commands/c.md`, "claude-2 `/nope` `/c`\n"),
        W(`${C}/m/.claude/commands/c.md`, "always `x`\n"),
        W(`${C}/m/.claude/skills/k/SKILL.md`, "never `x`\n"),
        MK(`${C}/j`),
        SQL(`$ROOT/${C}/j`, [["helper", '{"description":"as an AI","prompt":"p"}', 1]], false),
      ),
      GET,
    ],
  }),
  (C) => ({
    name: "ws-audit-many",
    steps: [
      setup(
        wsFile([ws("wks_many", "Many", `$ROOT/${C}/m`)]),
        W(`${C}/m/CLAUDE.md`, "`a/1.ts` `a/2.ts` `a/3.ts`\n`/x1` `/x2` `/x3`\n"),
      ),
      GET,
      setup(W(`${C}/m/CLAUDE.md`, "`a/1.ts`\n`/x1`\nclaude-2\n")), GET,
      setup(W(`${C}/m/CLAUDE.md`, "claude-2 claude-1 claude-3-opus\n")), GET,
      setup(W(`${C}/m/CLAUDE.md`, "Never `a`. Never `b`. Never `c`.\n"), W(`${C}/m/.claude/CLAUDE.md`, "Always `a`. Always `b`. Always `c`.\n")), GET,
      setup(W(`${C}/m/CLAUDE.md`, "`/help`\n"), RM(`${C}/m/.claude/CLAUDE.md`)), GET,
      setup(W(`${C}/m/CLAUDE.md`, "   \n")), GET,
    ],
  }),
  (C) => ({
    name: "ws-env",
    steps: [
      setup(
        wsFile([
          ws("wks_e1", "Env", `$ROOT/${C}/e1`),
          ws("wks_e2", "Broken", `$ROOT/${C}/e2`),
          ws("wks_e3", "Shapes", `$ROOT/${C}/e3`),
          ws("wks_e4", "One", `$ROOT/${C}/e4`),
          ws("wks_e5", "Dir", `$ROOT/${C}/e5`),
          ws("wks_e6", "Custom", `$ROOT/${C}/e6`, { kind: "customization" }),
          ws("wks_e7", "Order", `$ROOT/${C}/e7`),
        ]),
        W(`${C}/e1/.claude/settings.json`, J({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: "x", otel_y: "1", CLAUDE_CODE_ENABLE_TELEMETRY: "1", PATH: "x" } })),
        W(`${C}/e1/.claude/settings.local.json`, J({ env: { CLAUDE_CODE_DISABLE_ATTACHMENTS: "1", OTEL_EXPORTER_OTLP_ENDPOINT: "y", claude_code_disable_attachments: "1" } })),
        W(`${C}/e2/.claude/settings.json`, "null"),
        W(`${C}/e2/.claude/settings.local.json`, "{"),
        W(`${C}/e3/.claude/settings.json`, J({ env: ["OTEL_X"] })),
        W(`${C}/e3/.claude/settings.local.json`, J({ env: "OTEL" })),
        W(`${C}/e4/.claude/settings.local.json`, J({ env: { OTEL_A: "1" }, other: 1 })),
        MK(`${C}/e5/.claude/settings.json`),
        W(`${C}/e5/.claude/settings.local.json`, J({ env: { CLAUDE_CODE_DISABLE_ATTACHMENTS: "0" } })),
        W(`${C}/e6/.claude/settings.json`, J({ env: { OTEL_A: "1" } })),
        W(`${C}/e7/.claude/settings.json`, J({ env: { otel_b: "1", claude_code_disable_attachments: "1" } })),
        W(`${C}/e7/.claude/settings.local.json`, J({ env: { OTEL_A: "1", otel_b: "2", CLAUDE_CODE_DISABLE_ATTACHMENTS: "1" } })),
      ),
      GET,
      setup(W(`${C}/e2/.claude/settings.json`, "[1]"), W(`${C}/e2/.claude/settings.local.json`, '"str"')), GET,
      setup(W(`${C}/e2/.claude/settings.json`, '{"env":{"OTEL_A":1e400}}'), W(`${C}/e2/.claude/settings.local.json`, `${U(0xfeff)}{"env":{"OTEL_B":"1"}}`)), GET,
    ],
  }),
  (C) => ({
    name: "ws-agents-md",
    steps: [
      setup(
        wsFile([ws("wks_a", "Agents", `$ROOT/${C}/a`), ws("wks_b", "Both", `$ROOT/${C}/b`)]),
        W(`${C}/a/AGENTS.md`, `${lines(301)}claude-2\n`),
        W(`${C}/b/AGENTS.md`, "agents claude-2\n"),
        W(`${C}/b/CLAUDE.md`, "claude\n"),
      ),
      GET,
    ],
  }),
  (C) => ({
    name: "ws-symlinks",
    steps: [
      setup(
        wsFile([ws("wks_l", "Links", `$ROOT/${C}/l`)]),
        W(`${C}/outside/real.md`, `as an AI\n${lines(300)}`),
        LN(`${C}/l/CLAUDE.md`, `$ROOT/${C}/outside/real.md`),
        W(`${C}/outside/skill/SKILL.md`, "claude-2\n"),
        LN(`${C}/l/.claude/skills/linked`, `$ROOT/${C}/outside/skill`),
        W(`${C}/outside/cmd.md`, "claude-2\n"),
        LN(`${C}/l/.claude/commands/linked.md`, `$ROOT/${C}/outside/cmd.md`),
        W(`${C}/outside/rule.md`, lines(5)),
        LN(`${C}/l/.claude/rules/linked.md`, `$ROOT/${C}/outside/rule.md`),
        LN(`${C}/l/.claude/rules/dangling.md`, `$ROOT/${C}/outside/none.md`),
        LN(`${C}/l/.claude/CLAUDE.md`, `$ROOT/${C}/outside/none.md`),
      ),
      GET,
    ],
  }),
  (C) => ({
    name: "ws-imports",
    steps: [
      setup(
        wsFile([ws("wks_i", "Imports", `$ROOT/${C}/i`)]),
        W(`${C}/i/CLAUDE.md`, `@../outside.md\n@$ROOT/${C}/abs.md\n@~/x.md\n@missing.md\n@CLAUDE.md\n@sub\n`),
        W(`${C}/outside.md`, lines(150)),
        W(`${C}/abs.md`, lines(150)),
        MK(`${C}/i/sub`),
      ),
      GET,
    ],
  }),
  () => ({
    name: "fix-bodies",
    steps: [
      ...[
        "", "{", "null", "[]", '"claude-dir"', "{}", '{"id":5}', '{"id":"auth"}', '{"id":"CLAUDE-DIR"}', '{"id":" claude-dir"}',
        '{"id":"claude-dir"}', '{"id":"x","id":"projects-dir"}', '{"__proto__":{"id":"claude-dir"}}', ' {"id":"projects-dir"} ',
        `${U(0xfeff)}{"id":"claude-dir"}`, '{"id":["claude-dir"]}', '{"id":null}', '{"ID":"claude-dir"}', '{"id":"claude-dir"} x',
      ].map((b) => FIX(b)),
      ...[
        "constructor", "valueOf", "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable", "__lookupGetter__", "__lookupSetter__",
        "__defineGetter__", "__defineSetter__", "__proto__",
      ].map((id) => FIXID(id)),
      FIX(J({ id: "toString" }), J({ id: "nope" })),
      FIX(J({ id: "toLocaleString" }), J({ id: "nope" })),
    ],
  }),
];

let node = "22.23.3";
Object.defineProperty(process.versions, "node", { get: () => node, configurable: true, enumerable: true });

function resetWorld() {
  openUp(ROOT);
  for (const e of readdirSync(ROOT)) {
    if (["project", "bin", "core.json", "server.json"].includes(e)) continue;
    rmSync(join(ROOT, e), { recursive: true, force: true });
  }
  for (const e of readdirSync(join(ROOT, "project"))) rmSync(join(ROOT, "project", e), { recursive: true, force: true });
  for (const e of readdirSync(join(ROOT, "bin"))) rmSync(join(ROOT, "bin", e), { recursive: true, force: true });
}

const FAKE_HEAD = "#!/bin/sh\nprintf '%s\\0' \"$@\" > \"$0.argv\"\n";
function installGit(g) {
  const p = join(ROOT, "bin/git");
  rmSync(p, { recursive: true, force: true });
  if (g === null) return;
  if (g === "dir") return mkdirSync(p);
  writeFileSync(p, `${FAKE_HEAD}${g === "noexec" ? GIT_OK : g}\n`);
  chmodSync(p, g === "noexec" ? 0o644 : 0o755);
}

function gitArgv() {
  const p = join(ROOT, "bin/git.argv");
  let text;
  try {
    text = readFileSync(p, "utf8");
  } catch {
    return null;
  }
  rmSync(p);
  const args = text.split("\0");
  args.pop();
  return args;
}

const PLATFORM_ARCH = `"platform":${J(process.platform)},"arch":${J(process.arch)}`;

async function request(req) {
  try {
    const res =
      req.method === "GET"
        ? await doctorRoute.GET()
        : await fixRoute.POST(new Request("http://localhost/api/doctor/fix", { method: "POST", body: toAbs(req.body) }));
    let body = toRel(await res.text());
    if (req.method === "GET" && res.status === 200) {
      if (!body.includes(PLATFORM_ARCH)) throw new Error(`no ${PLATFORM_ARCH} in ${body}`);
      body = body.replace(PLATFORM_ARCH, '"platform":"$PLATFORM","arch":"$ARCH"');
    }
    return { status: res.status, type: res.headers.get("content-type"), body };
  } catch (e) {
    return { threw: toRel(e instanceof Error ? `${e.name}: ${e.message}` : String(e)) };
  }
}

const cases = [];
for (const [i, make] of CASES.entries()) {
  const C = `c${String(i).padStart(2, "0")}`;
  const c = make(C);
  resetWorld();
  for (const op of BASE) apply(op);
  installGit(GIT_OK);
  node = "22.23.3";
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, c.env ?? {});
  const steps = [];
  for (const step of c.steps) {
    if (step.setup) {
      for (const op of step.setup) apply(op);
      steps.push(step);
    } else if ("node" in step) {
      node = step.node;
      steps.push(step);
    } else if ("git" in step) {
      installGit(step.git);
      steps.push(step);
    } else {
      const rec = { request: step.request };
      if (step.as !== undefined) {
        rec.as = step.as;
        const before = snapshot();
        rec.got = await request({ ...step.request, body: step.as });
        rec.gitArgv = gitArgv();
        rec.changes = changes(before, snapshot());
        const before2 = snapshot();
        const ts = await request(step.request);
        rec.ts = { got: ts, changes: changes(before2, snapshot()) };
        gitArgv();
        // Undo what TS did there (`mkdir("[object Object]")` in its cwd).
        apply(RM("project/[object Object]"));
      } else {
        const before = snapshot();
        rec.got = await request(step.request);
        rec.gitArgv = gitArgv();
        rec.changes = changes(before, snapshot());
      }
      steps.push(rec);
    }
  }
  cases.push({ name: c.name, env: c.env ?? {}, ...(c.needs ? { needs: c.needs } : {}), steps });
}
for (const k of ENV_KEYS) delete process.env[k];
resetWorld();

writeFileSync(join(ROOT, "server.json"), J({ base: BASE, fakeHead: FAKE_HEAD, git: GIT_OK, node: "22.23.3", cases }));
process.exit(0);
