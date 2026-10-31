#!/usr/bin/env node
// Golden fixture for the memory routes (G08): `lib/server/auto-memory.ts`,
// `lib/server/rules.ts`, session.ts `memoryUpdateReminderBody` /
// `Session.prototype.notifyMemoryUpdate`, and the route handlers
// `app/api/memory/auto/route.ts` and `app/api/memory/rules/route.ts`,
// recorded from the real TS sources:
//
//   node rust/scripts/memory-golden.mjs     (node@22: session.ts needs
//                                            better-sqlite3, which bun can't
//                                            load)
//
// Re-runs itself under `--experimental-transform-types` with a resolve hook
// for the extensionless / `@/` imports, twice (two temp roots, both through
// realpath); both recordings must agree byte for byte. The child runs with
// its cwd at `<root>/project` (the first trusted root), HOME at
// `<root>/home`, CLAUDE_CONFIG_DIR at `<root>/config` (a decoy: the memory
// dir is under `homedir()/.claude`, not the CLI config dir) and umask 022.
// `Date` is pinned: `new Date()` and `Date.now()` read a clock that starts at
// 2001-01-01T00:00:00.000Z and moves 1001 ms before every call or request.
// `<root>/home/.claude/.claudius/workspaces.json` registers `<root>/ws` (with
// `<root>/ws-extra` as an additional directory), a unicode root, a root
// whose encoded memory dir name is too long for the disk, and a root with a
// NUL in it; `<root>/untrusted` exists but is not registered.
//
// Placeholders: `$ROOT` is the root and `$EROOT` its `encodeProjectDir`
// form (so `$EROOT-project` is the project's dir under
// `home/.claude/projects`). They are swapped textually in paths, URLs,
// bodies, file texts and results.
//
// Records:
// - `pure`: `encodeProjectDir`, `autoMemoryDir`, `isValidMemoryFilename`,
//   `isValidRuleFilename`, `yamlScalar`, `parseMemoryFrontmatter`,
//   `measureMemoryIndexLoadedBytes`, `memoryUpdateReminderBody` and
//   `rulesDir` over hand-picked inputs: `[input, output]` pairs, or
//   `{threw: {name, message}}`.
// - `notify`: the real `Session.prototype.notifyMemoryUpdate` on a bare
//   `Object.create(Session.prototype)` with `recentReadPaths` seeded
//   (`reads`), called once per entry of `calls`; `reminder` is what
//   `takePendingReminders` drains afterwards (null when nothing was queued).
// - `modules`: scenarios of direct calls to the exported module functions
//   (`call`: `[name, ...args]`, `now`: the pinned clock), interleaved with
//   `setup` file operations (`write` text or `bytes`, `mkdir`, `rm`,
//   `symlink`, `chmod`, and `mtime`, which sets a path's mtime and records
//   the nanoseconds it read back as `ns`). Each call records `result` (its
//   value, JSON) or `threw` (`{name, code, message}`) and `changes`: every
//   watched path whose entry differs from before the call (kind, mode, UTF-8
//   text or raw bytes, symlink target; `null` when it is gone). The watched
//   paths are every `home/.claude/projects/*/memory`, `home/.claude/rules`
//   and the trees under the root the routes could reach.
// - `routes`: groups of route requests (`method`, `url`, `body` text) and
//   setups, one world per group. Each request records `got` (status,
//   content type and body text, or `threw`: Next's empty 500), `changes`,
//   and `reminders`: for each of the group's bare sessions (in
//   `sessionManager`'s map, so the route's `sessionsByCwd` finds them), what
//   `takePendingReminders` drains after the request. `probes` groups are
//   replayed with a probe turn after each request; `final` is every watched
//   path at the end of the group. `os` / `needs` mark groups that only
//   replay on the recording platform / on a disk that enforces permissions.
//
// Written to rust/crates/claudius-core/tests/fixtures/memory_golden.json and
// replayed by crates/claudius-core/tests/memory_golden.rs (pure, notify,
// modules) and crates/claudius-server/tests/memory.rs (routes, against the
// real binary).
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
const out = join(rustDir, "crates/claudius-core/tests/fixtures/memory_golden.json");

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

if (!process.env.MEMORY_GOLDEN_ROOT) {
  const runs = [0, 1].map(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "memory-golden-")));
    try {
      // Placeholders are swapped textually in URLs, JSON text and files.
      if (!/^[A-Za-z0-9_./-]+$/.test(root)) throw new Error(`root needs escaping: ${root}`);
      mkdirSync(join(root, "project"));
      const r = spawnSync(
        process.execPath,
        ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url)],
        {
          cwd: join(root, "project"),
          encoding: "utf8",
          maxBuffer: 1 << 26,
          env: {
            PATH: process.env.PATH,
            HOME: join(root, "home"),
            CLAUDE_CONFIG_DIR: join(root, "config"),
            MEMORY_GOLDEN_ROOT: root,
          },
        },
      );
      if (r.status !== 0) {
        process.stdout.write(r.stdout);
        process.stderr.write(r.stderr);
        process.exit(r.status ?? 1);
      }
      return readFileSync(join(root, "out.json"), "utf8");
    } finally {
      openUp(root);
      rmSync(root, { recursive: true, force: true });
    }
  });
  if (runs[0] !== runs[1]) {
    if (process.env.MEMORY_GOLDEN_DUMP) {
      runs.forEach((r, i) => writeFileSync(`${process.env.MEMORY_GOLDEN_DUMP}.${i}.json`, `${JSON.stringify(JSON.parse(r), null, 1)}\n`));
    }
    throw new Error("the two recordings differ");
  }
  const fixture = JSON.parse(runs[0]);
  writeFileSync(out, `${JSON.stringify(fixture, null, 1)}\n`);
  const calls = fixture.modules.reduce((n, s) => n + s.steps.filter((x) => x.call).length, 0);
  const requests = fixture.routes.reduce((n, g) => n + g.steps.filter((x) => x.request).length, 0);
  const pure = Object.values(fixture.pure).reduce((n, cases) => n + cases.length, 0);
  console.log(
    `wrote ${out.slice(repo.length + 1)}: ${pure} pure cases, ${fixture.notify.length} notify cases, ${fixture.modules.length} module scenarios (${calls} calls), ${fixture.routes.length} route groups (${requests} requests)`,
  );
  process.exit(0);
}

// --------------------------------- child ---------------------------------

const ROOT = process.env.MEMORY_GOLDEN_ROOT;
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

// The pinned clock: `new Date()` and `Date.now()` both read it.
const BASE = Date.UTC(2001, 0, 1);
let clock = BASE;
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(clock);
    else super(...args);
  }
  static now() {
    return clock;
  }
};
const tick = () => {
  clock += 1001;
  return clock;
};

const am = await import(join(repo, "lib/server/auto-memory.ts"));
const rules = await import(join(repo, "lib/server/rules.ts"));
const { Session, memoryUpdateReminderBody } = await import(join(repo, "lib/server/session.ts"));
const { takePendingReminders } = await import(join(repo, "lib/server/system-reminders.ts"));
const { sessionManager } = await import(join(repo, "lib/server/session-manager.ts"));
const autoRoute = await import(join(repo, "app/api/memory/auto/route.ts"));
const rulesRoute = await import(join(repo, "app/api/memory/rules/route.ts"));

/** Characters by code point, so this file stays ASCII. */
const U = (...cps) => String.fromCodePoint(...cps);
const BS = String.fromCharCode(92);
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

// --------------------------------- world ---------------------------------

const UNI = `caf${U(0xe9)} x${U(0x1f600)}`;
const LONG = `long/${"a".repeat(200)}/${"b".repeat(60)}`;
const NUL = `nul${U(0)}x`;
/** `home/.claude/projects/<encoded>/memory` of `$ROOT/<rel>`. */
const MEM = (rel) => `home/.claude/projects/$EROOT-${encodeDir(rel)}/memory`;
/** The absolute path of a file in that dir. */
const MEMF = (rel, name) => `$ROOT/${MEM(rel)}/${name}`;

const WATCH = ["home/.claude/rules", "project", "ws", "ws-extra", "untrusted", "outside", "nowhere", UNI, "long"];
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Every watched path (keys with placeholders), sorted. */
function snapshot() {
  const snap = {};
  const visit = (rel) => {
    if (rel in snap) return;
    const abs = join(ROOT, toAbs(rel));
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      return;
    }
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
      for (const e of names) visit(`${rel}/${toRel(e)}`);
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
  let projects = [];
  try {
    projects = readdirSync(join(ROOT, "home/.claude/projects")).sort();
  } catch {
    // none yet
  }
  // `encodeProjectDir("")` is empty, so that cwd's memory dir is
  // `projects/memory` itself.
  for (const p of projects) visit(p === "memory" ? "home/.claude/projects/memory" : `home/.claude/projects/${toRel(p)}/memory`);
  for (const w of WATCH) visit(w);
  return Object.fromEntries(Object.keys(snap).sort().map((k) => [k, snap[k]]));
}

function changes(before, after) {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return keys.filter((k) => J(before[k]) !== J(after[k])).map((k) => [k, after[k] ?? null]);
}

const WORLD = {
  dirs: ["home/.claude/.claudius", "project", "ws", "ws-extra", "untrusted", "outside", "config", UNI, LONG],
  files: [
    [
      "home/.claude/.claudius/workspaces.json",
      `${J(
        {
          version: 1,
          workspaces: [
            ["wks_golden00001", "ws", "$ROOT/ws", ["$ROOT/ws-extra"]],
            ["wks_golden00002", "uni", `$ROOT/${UNI}`, []],
            ["wks_golden00003", "long", `$ROOT/${LONG}`, []],
            ["wks_golden00004", "nul", `$ROOT/${NUL}`, []],
          ].map(([id, name, rootPath, extra]) => ({
            id,
            name,
            rootPath,
            icon: { kind: "letter", letter: "W", color: "#d97757" },
            createdAt: 1,
            updatedAt: 1,
            defaults: { additionalDirectories: extra },
          })),
        },
        null,
        2,
      )}\n`,
    ],
    ["outside/secret.md", "---\nname: Secret\ndescription: outside\ntype: user\n---\n\nsecret body\n"],
    ["outside/plain.txt", "plain\n"],
    ["config/projects/decoy/memory/decoy.md", "decoy\n"],
  ],
};

function buildWorld() {
  // The project dir is this process's cwd: emptied, never removed.
  openUp(ROOT);
  for (const e of readdirSync(ROOT)) {
    if (e === "project" || e === "out.json") continue;
    rmSync(join(ROOT, e), { recursive: true, force: true });
  }
  for (const e of readdirSync(join(ROOT, "project"))) rmSync(join(ROOT, "project", e), { recursive: true, force: true });
  for (const d of WORLD.dirs) mkdirSync(join(ROOT, d), { recursive: true });
  for (const [p, text] of WORLD.files) {
    mkdirSync(dirname(join(ROOT, p)), { recursive: true });
    writeFileSync(join(ROOT, p), toAbs(text));
  }
}

/** Apply a setup op; returns it as the fixture records it. */
function apply(op) {
  const p = join(ROOT, toAbs(op.path));
  switch (op.op) {
    case "write":
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, op.bytes ? Buffer.from(op.bytes) : toAbs(op.text));
      return op;
    case "mkdir":
      mkdirSync(p, { recursive: true });
      return op;
    case "rm":
      openUp(p);
      rmSync(p, { recursive: true, force: true });
      return op;
    case "symlink":
      mkdirSync(dirname(p), { recursive: true });
      symlinkSync(toAbs(op.target), p);
      return op;
    case "chmod":
      chmodSync(p, op.mode);
      return op;
    case "mtime": {
      // `utimes` takes a negative number of seconds as "now"; a Date can
      // be before the epoch.
      const t = op.sec < 0 ? new RealDate(op.sec * 1000) : op.sec;
      utimesSync(p, t, t);
      return { op: "mtime", path: op.path, ns: String(statSync(p, { bigint: true }).mtimeNs) };
    }
    default:
      throw new Error(`unknown op ${op.op}`);
  }
}

const S = (...ops) => ({ setup: ops });
const W = (path, text) => ({ op: "write", path, text });
const WB = (path, bytes) => ({ op: "write", path, bytes });
const RM = (path) => ({ op: "rm", path });
const MK = (path) => ({ op: "mkdir", path });
const LN = (path, target) => ({ op: "symlink", path, target });
const CH = (path, mode) => ({ op: "chmod", path, mode });
const MT = (path, sec) => ({ op: "mtime", path, sec });

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

// ---------------------------------- pure ----------------------------------

function threwOf(e) {
  return { name: e?.name ?? null, code: e?.code ?? null, message: toRel(e instanceof Error ? e.message : String(e)) };
}
const pairs = (fn, inputs) =>
  inputs.map((args) => {
    try {
      return [args, deep(fn(...args) ?? null, toRel)];
    } catch (e) {
      return [args, { threw: threwOf(e) }];
    }
  });

const CWDS = [
  "/Users/x/my.proj",
  "/a b/c_d-e",
  "",
  "/",
  "rel/x",
  `/caf${U(0xe9)}/${U(0x1f600)}`,
  `/x${U(0)}y`,
  `/tab\there`,
  `/${U(0x4e2d)}${U(0x6587)}`,
  "/a/../b",
  "/trailing/",
];

const FILENAMES = [
  "a.md",
  "MEMORY.md",
  "-rf.md",
  "..md",
  "...md",
  "a.b.c.md",
  "a_b-c.md",
  "A1.md",
  "",
  "a",
  ".md",
  "md",
  "a.MD",
  "a.md.txt",
  "abmd",
  "a.xmd",
  "../a.md",
  "/abs.md",
  "a/b.md",
  `a${BS}b.md`,
  `a${U(0)}.md`,
  "a b.md",
  `caf${U(0xe9)}.md`,
  "a.md\n",
  "\na.md",
  "%2e%2e.md",
  "a.md/",
  "a+b.md",
  "a~.md",
  `${U(0xff21)}.md`,
];

const YAML = [
  "",
  "plain",
  "two words",
  "a:b",
  "a #b",
  "#",
  "a\nb",
  "a\rb",
  'a"b',
  "a'b",
  `a${BS}b`,
  " lead",
  "trail ",
  "\tx",
  `x${U(0xa0)}`,
  `${U(0x85)}x`,
  `${U(0x2028)}x`,
  `x${U(0x2029)}`,
  `${U(0xfeff)}x`,
  `${U(0x3000)}x`,
  ..."-?&*!|>%@`[]{},".split("").map((c) => `${c}x`),
  ..."-?&*!|>%@`[]{},".split("").map((c) => `a${c}b`),
  `caf${U(0xe9)}`,
  U(0x1f600),
  `${U(1)}${U(0x1f)}${U(0x7f)}`,
  `:${U(1)}${U(8)}${U(9)}${U(0xc)}${U(0x1f)}${U(0x7f)}${U(0x2028)}${U(0x2029)}${U(0xe9)}`,
  `#${U(0)}`,
  `x${U(0)}y`,
  "user",
  "123",
  "true",
  "null",
  "~",
  "=",
  "a: b # c",
];

const FRONTMATTER = [
  "---\nname: a\ndescription: d\ntype: user\nmodified: 2020-01-01T00:00:00.000Z\n---\n\nbody\n",
  "hello",
  "",
  "---\nname: a\n---",
  "---\nname: a\n---\nbody",
  "---\nname: a\n---\n\nbody",
  "---\nname: a\n---\n\n\nbody",
  "---\nname: a\n---xbody",
  "---\nname: a\n----\nbody",
  "---\nname:\n---\n",
  "---\nname:   \ndescription: d\n---\n",
  "---\nname: \"a: b\"\n---\n",
  "---\nname: \"unterminated\n---\n",
  "---\nname: \"a\" \"b\"\n---\n",
  `---\nname: "${BS}u00e9${BS}n"\n---\n`,
  "---\nname: \"\"\n---\n",
  `---\nname: "${BS}""\n---\n`,
  "---\nname: \"\n---\n",
  "---\nname: \"123\"\n---\n",
  "---\nname: 123\n---\n",
  "---\n name: a\n---\n",
  "---\nName: a\n---\n",
  "---\nname : a\n---\n",
  "---\nname: a\ntype: feedback\n---\n",
  "---\nname: a\ntype:\n---\n",
  "---\r\nname: a\r\n---\r\n",
  "---\nname: a\r\n---\n",
  "---\nname: a\rdescription: d\n---\n",
  `---\nname: a${U(0x2028)}x\n---\n`,
  `---\nfoo${U(0x2029)}name: z\n---\n`,
  "---\nname: first\nname: second\n---\n",
  "---\ndescription: d\nname: n\n---\n",
  "---\nxname: a\nname: b\n---\n",
  "---\n---\n",
  "---\n\n---\nbody",
  `${U(0xfeff)}---\nname: a\n---\n`,
  "---\nname: a\n---\nx\n---\ny",
  "---\nname: a\n---\n---\nname: b\n---\n",
  "--- \nname: a\n---\n",
  "---\nname: a\n--- \nbody",
  `---\nname: caf${U(0xe9)} ${U(0x1f600)}\n---\n`,
  `---\nname:${U(0xa0)}${U(0xa0)}a\n---\n`,
  "---\nname: \"a\"  \n---\n",
  "---\nname:\t\"q\"\t\n---\n",
  "---\nname: a\nmodified:\n---\n",
  "---\nname: a\nmodified: \"2020\"\n---\n",
  "---\nextra: 1\nname: a\nother: 2\n---\nbody",
  "---\nname: a\n\n---\n",
  "---\n\nname: a\n---\n",
  "---\nname:a\n---\n",
  "---\nname: a\n---\n\n",
];

const MEASURE = [
  "",
  "abc",
  `caf${U(0xe9)} ${U(0x1f600)}`,
  "---\nx\n---\nrest",
  "---\nx\n---rest",
  "---\nx\n---",
  "---\n---\n",
  "---\n\n---\nX",
  "x---\na\n---\n",
  "<!-- c -->x",
  "a<!--b-->c<!--d-->e",
  "<!--<!---->x",
  "<!-- unterminated",
  "x<!--a-->y<!-- z",
  "-->",
  "<!---->",
  "<!--->",
  "<!-->",
  "<!---->-->",
  "---\na\n---\n<!--c-->tail",
  `<!--${U(0x1f600)}-->${U(0xe9)}`,
  `- [a](a.md) ${U(0x2014)} d\n`,
];

const upd = (op, path) => ({ op, path });
const REMINDER = [
  [[], []],
  [[upd("created", "/a/b/c.md")], []],
  [[upd("created", "")], []],
  [[upd("created", ""), upd("updated", "/x/y.md")], [""]],
  [[upd("updated", "/x/y.md"), upd("deleted", "/x/z.md")], ["/x/z.md", "", "/x/y.md"]],
  [[upd("deleted", "c.md")], ["c.md"]],
  [[upd("created", "/a/b/")], []],
  [[upd("created", "/")], ["/"]],
  [[upd("updated", `/caf${U(0xe9)}/${U(0x1f600)}.md`)], [`/caf${U(0xe9)}/${U(0x1f600)}.md`]],
  [[upd("created", "/m/a.md"), upd("created", "/m/a.md")], ["/m/a.md", "/m/a.md"]],
  [[upd("updated", "/m/a, b.md")], ["/elsewhere"]],
];

const RULES_DIR = [
  ["user", null],
  ["user", "/ignored"],
  ["user", "rel"],
  ["project", null],
  ["project", undefined],
  ["project", ""],
  ["project", "rel/x"],
  ["project", "./x"],
  ["project", `/a${U(0)}b`],
  ["project", "/a/../b/./c/"],
  ["project", "/"],
  ["project", "//a//b"],
  ["project", "$ROOT/project"],
  ["project", ` /lead`],
  ["project", `/caf${U(0xe9)}`],
];

const pure = {
  encodeProjectDir: pairs(am.encodeProjectDir, CWDS.map((c) => [c])),
  autoMemoryDir: pairs(am.autoMemoryDir, CWDS.map((c) => [c])),
  isValidMemoryFilename: pairs(am.isValidMemoryFilename, FILENAMES.map((f) => [f])),
  isValidRuleFilename: pairs(rules.isValidRuleFilename, FILENAMES.map((f) => [f])),
  yamlScalar: pairs(am.yamlScalar, YAML.map((y) => [y])),
  parseMemoryFrontmatter: pairs(am.parseMemoryFrontmatter, FRONTMATTER.map((f) => [f])),
  measureMemoryIndexLoadedBytes: pairs(am.measureMemoryIndexLoadedBytes, MEASURE.map((m) => [m])),
  memoryUpdateReminderBody: pairs(memoryUpdateReminderBody, REMINDER),
  rulesDir: RULES_DIR.map(([scope, cwd]) => {
    try {
      return [[scope, cwd ?? null], deep(rules.rulesDir(scope, cwd === null || cwd === undefined ? cwd : toAbs(cwd)), toRel)];
    } catch (e) {
      return [[scope, cwd ?? null], { threw: threwOf(e) }];
    }
  }),
};
// `undefined` and `null` both reach `rulesDir` above; the fixture writes both as null.

// --------------------------------- notify ---------------------------------

function bareSession(id, cwd, reads) {
  const host = Object.create(Session.prototype);
  host.id = id;
  host.cwd = cwd;
  host.query = null;
  host.recentReadPaths = new Set(reads);
  return host;
}

const NOTIFY = [
  { reads: [], calls: [[upd("created", "/m/a.md")]] },
  { reads: ["/m/a.md", "/m/b.md"], calls: [[upd("updated", "/m/b.md")]] },
  { reads: ["/x", "/m/a.md", "/m/b.md"], calls: [[upd("deleted", "/m/b.md"), upd("created", "/m/a.md")]] },
  { reads: ["/m/a.md"], calls: [[]] },
  { reads: ["/m/a.md"], calls: [[upd("created", "")]] },
  { reads: [""], calls: [[upd("created", "")]] },
  { reads: ["/m/a.md"], calls: [[upd("created", "/m/a.md")], [upd("deleted", "/m/a.md")]] },
  { reads: ["/m/a.md/"], calls: [[upd("updated", "/m/a.md")]] },
  { reads: ["/m/a.md", "/m/MEMORY.md"], calls: [[upd("updated", "/m/a.md"), upd("updated", "/m/a.md")]] },
  { reads: ["/m/b.md", "/m/a.md"], calls: [[upd("created", "/m/a.md"), upd("created", "/m/b.md")]] },
  { reads: [`/caf${U(0xe9)}/${U(0x1f600)}.md`], calls: [[upd("created", `/caf${U(0xe9)}/${U(0x1f600)}.md`)]] },
  { reads: ["/m/a.md"], calls: [[], [upd("created", "/m/c.md")], []] },
  { reads: ["/m/a.md"], calls: [[upd("created", "rel.md")]] },
  { reads: ["rel.md"], calls: [[upd("created", "rel.md")]] },
];
const notify = NOTIFY.map((c, i) => {
  const host = bareSession(`notify-${i}`, "/m", c.reads);
  for (const updates of c.calls) host.notifyMemoryUpdate(updates);
  return { reads: c.reads, calls: c.calls, reminder: takePendingReminders(host) };
});

// --------------------------------- modules ---------------------------------

const MODULE_FNS = {
  listAutoMemory: am.listAutoMemory,
  readMemoryFile: am.readMemoryFile,
  writeMemoryFile: am.writeMemoryFile,
  patchMemoryFile: am.patchMemoryFile,
  deleteMemoryFile: am.deleteMemoryFile,
  appendMemoryIndex: am.appendMemoryIndex,
  listRules: rules.listRules,
  readRule: rules.readRule,
  writeRule: rules.writeRule,
  deleteRule: rules.deleteRule,
};

async function runScenario(sc) {
  buildWorld();
  const steps = [];
  for (const step of sc.steps) {
    if (step.setup) {
      steps.push({ setup: step.setup.map(apply) });
      continue;
    }
    const [fn, ...args] = step.call;
    const before = snapshot();
    const now = tick();
    const rec = { call: step.call, now };
    try {
      const result = await MODULE_FNS[fn](...deep(args, toAbs));
      rec.result = deep(result ?? null, toRel);
    } catch (e) {
      rec.threw = threwOf(e);
    }
    rec.changes = changes(before, snapshot());
    steps.push(rec);
  }
  return { name: sc.name, os: sc.os ?? null, needs: sc.needs ?? [], steps, final: snapshot() };
}

const P = "$ROOT/project";
const C = (fn, ...args) => ({ call: [fn, ...args] });
const mem = (filename, type, name, description, body) => ({ filename, type, name, description, body });
const PM = MEM("project");
/** The bytes of `exact.md`'s index line around its description. */
const EXACT_LINE = Buffer.byteLength(`- [E](exact.md) ${U(0x2014)} \n`);
/** An index of `n` one-line entries, each `width` bytes. */
const bigIndex = (n, width) =>
  Array.from({ length: n }, (_, i) => {
    const head = `- [e${i}](e${i}.md) ${U(0x2014)} `;
    return `${head}${"x".repeat(width - Buffer.byteLength(head) - 1)}\n`;
  }).join("");

const MODULES = [
  {
    name: "auto basics",
    steps: [
      C("listAutoMemory", P),
      C("readMemoryFile", P, "a.md"),
      C("readMemoryFile", P, "../a.md"),
      C("deleteMemoryFile", P, "a.md"),
      C("patchMemoryFile", P, { filename: "a.md", description: "x" }),
      C("appendMemoryIndex", P, "x.md", "X", "no dir yet"),
      C("writeMemoryFile", P, mem("a.md", "user", "Alpha", "first one", "Alpha body\n")),
      C("writeMemoryFile", P, mem("a.md", "user", "Alpha", "again", "x")),
      C("writeMemoryFile", P, mem("b.md", "feedback", "Be: #1", "  spaced  ", "")),
      C("writeMemoryFile", P, mem("c.md", "project", "-dash", "line\nbreak", "---\nfake: fm\n---\n")),
      C("writeMemoryFile", P, mem("d.md", "reference", `caf${U(0xe9)} ${U(0x1f600)}`, 'say "hi"', "x")),
      C("writeMemoryFile", P, mem("..md", "user", "dots", "d", "y")),
      C("writeMemoryFile", P, mem("-rf.md", "user", "[x]", "{y}", "z")),
      C("writeMemoryFile", P, mem("e.md", "user", `${U(0x85)}nel`, `tab\tin`, `${U(0x2028)}ls`)),
      ...FILENAMES.filter((f) => !am.isValidMemoryFilename(f)).map((f) => C("writeMemoryFile", P, mem(f, "user", "n", "d", "b"))),
      C("writeMemoryFile", P, mem("f.md", "user", "  ", "d", "b")),
      C("writeMemoryFile", P, mem("f.md", "user", "n", "\t\n", "b")),
      C("writeMemoryFile", P, mem("f.md", "user", U(0xa0), "d", "b")),
      C("writeMemoryFile", P, mem("f.md", "user", "n", U(0xfeff), "b")),
      C("writeMemoryFile", P, mem("f.md", "other", "n", "d", "b")),
      C("writeMemoryFile", P, mem("f.md", "User", "n", "d", "b")),
      C("writeMemoryFile", P, mem("f.md", "", "n", "d", "b")),
      C("writeMemoryFile", P, mem("../f.md", "nope", "", "", "b")),
      C("readMemoryFile", P, "a.md"),
      C("readMemoryFile", P, "MEMORY.md"),
      C("readMemoryFile", P, "../MEMORY.md"),
      C("readMemoryFile", P, "nope.md"),
      S(
        W(`${PM}/notes.txt`, "not listed\n"),
        W(`${PM}/UPPER.MD`, "not listed\n"),
        W(`${PM}/tie1.md`, "tie\n"),
        W(`${PM}/tie0.md`, "tie\n"),
        MT(`${PM}/a.md`, 1700000000.123456),
        MT(`${PM}/b.md`, 1700000005.5),
        MT(`${PM}/c.md`, 1600000000),
        MT(`${PM}/d.md`, 1800000000.000001),
        MT(`${PM}/e.md`, 1700000003),
        MT(`${PM}/..md`, 1700000001.25),
        MT(`${PM}/-rf.md`, 1700000002),
        MT(`${PM}/MEMORY.md`, 1700000004),
        MT(`${PM}/tie1.md`, 1650000000.5),
        MT(`${PM}/tie0.md`, 1650000000.5),
      ),
      C("listAutoMemory", P),
      C("listAutoMemory", `${P}/`),
      C("listAutoMemory", "$ROOT/elsewhere"),
    ],
  },
  {
    name: "auto odd cwds",
    steps: [
      ...CWDS.map((cwd) => C("writeMemoryFile", cwd, mem("odd.md", "user", "odd", `cwd ${J(cwd)}`, "b"))),
      S(MT("home/.claude/projects/memory/odd.md", 1700000000), MT("home/.claude/projects/memory/MEMORY.md", 1700000001)),
      C("listAutoMemory", ""),
      C("readMemoryFile", "", "odd.md"),
      C("deleteMemoryFile", "/a/../b", "odd.md"),
      C("writeMemoryFile", `$ROOT/${LONG}`, mem("long.md", "user", "n", "d", "b")),
      C("listAutoMemory", `$ROOT/${LONG}`),
      C("readMemoryFile", `$ROOT/${LONG}`, "long.md"),
      C("patchMemoryFile", `$ROOT/${LONG}`, { filename: "long.md", body: "x" }),
      C("deleteMemoryFile", `$ROOT/${LONG}`, "long.md"),
    ],
  },
  {
    name: "auto patch",
    steps: [
      C("writeMemoryFile", P, mem("a.md", "user", "Alpha", "first", "Alpha body\n")),
      C("writeMemoryFile", P, mem("q.md", "feedback", "a: b", "c # d", "q body")),
      C("patchMemoryFile", P, { filename: "a.md", description: "second" }),
      C("patchMemoryFile", P, { filename: "a.md" }),
      C("patchMemoryFile", P, { filename: "a.md", description: "second" }),
      C("patchMemoryFile", P, { filename: "a.md", type: "bogus" }),
      C("patchMemoryFile", P, { filename: "a.md", type: "project", body: "new body" }),
      C("patchMemoryFile", P, { filename: "a.md", type: "" }),
      C("patchMemoryFile", P, { filename: "a.md", type: 0 }),
      C("patchMemoryFile", P, { filename: "a.md", type: false }),
      C("patchMemoryFile", P, { filename: "a.md", type: null, description: null }),
      C("patchMemoryFile", P, { filename: "a.md", type: 7 }),
      C("patchMemoryFile", P, { filename: "a.md", type: ["user"] }),
      C("patchMemoryFile", P, { filename: "a.md", description: [":", "x"] }),
      C("patchMemoryFile", P, { filename: "a.md", description: [null, "#", [1, 2]] }),
      C("patchMemoryFile", P, { filename: "a.md", description: ["x"] }),
      C("patchMemoryFile", P, { filename: "a.md", description: 5 }),
      C("patchMemoryFile", P, { filename: "a.md", description: true }),
      C("patchMemoryFile", P, { filename: "a.md", description: { a: ":" } }),
      C("patchMemoryFile", P, { filename: "a.md", description: [{ toString: 1 }, ":"] }),
      C("patchMemoryFile", P, { filename: "a.md", description: "" }),
      C("patchMemoryFile", P, { filename: "a.md", description: " padded " }),
      C("patchMemoryFile", P, { filename: "a.md", body: 5 }),
      C("patchMemoryFile", P, { filename: "a.md", body: 1.5e300 }),
      C("patchMemoryFile", P, { filename: "a.md", body: [1, null, "x", [2, [3]]] }),
      C("patchMemoryFile", P, { filename: "a.md", body: { toString: 1 } }),
      C("patchMemoryFile", P, { filename: "a.md", body: { valueOf: 1 } }),
      C("patchMemoryFile", P, { filename: "a.md", body: true }),
      C("patchMemoryFile", P, { filename: "a.md", body: "" }),
      C("patchMemoryFile", P, { filename: "a.md", body: "---\nname: inner\n---\n" }),
      C("patchMemoryFile", P, { filename: "q.md", body: "kept identity" }),
      C("patchMemoryFile", P, { filename: "zz.md" }),
      C("patchMemoryFile", P, { filename: "../a.md" }),
      C("patchMemoryFile", P, { filename: "zz.md", type: "bogus" }),
      S(
        W(`${PM}/plain.md`, "no frontmatter\n"),
        W(`${PM}/noname.md`, "---\ndescription: d\n---\n\nb"),
        W(`${PM}/extra.md`, "---\nextra: kept?\nname: Extra\nother: 2\n---\nbody stays\n"),
        W(`${PM}/crlf.md`, "---\r\nname: c\r\n---\r\n"),
        W(`${PM}/bom.md`, `${U(0xfeff)}---\nname: b\n---\n`),
        WB(`${PM}/bytes.md`, [...Buffer.from("---\nname: bytes\n---\n\n"), 0xff, 0xfe, 0x41, 0xc3]),
        W(`${PM}/quoted.md`, `---\nname: "q${BS}"uote: x"\ndescription: "d"\ntype: "feedback"\n---\n\nquoted\n`),
        W(
          `${PM}/MEMORY.md`,
          `# index\n- [Extra](extra.md) ${U(0x2014)} old\n- [Extra again](extra.md) ${U(0x2014)} twice\n- [Q](q.md) mention (a.md) here\n`,
        ),
      ),
      C("patchMemoryFile", P, { filename: "plain.md", body: "x" }),
      C("patchMemoryFile", P, { filename: "noname.md", body: "x" }),
      C("patchMemoryFile", P, { filename: "extra.md", description: "new" }),
      C("patchMemoryFile", P, { filename: "crlf.md", body: "x" }),
      C("patchMemoryFile", P, { filename: "bom.md", body: "x" }),
      C("patchMemoryFile", P, { filename: "bytes.md" }),
      C("patchMemoryFile", P, { filename: "quoted.md", description: "e" }),
      C("patchMemoryFile", P, { filename: "a.md", description: "via mention" }),
      C("patchMemoryFile", P, { filename: "noindex.md", description: "x" }),
      S(RM(`${PM}/MEMORY.md`)),
      C("patchMemoryFile", P, { filename: "extra.md", description: "no index" }),
      S(MK(`${PM}/MEMORY.md`)),
      C("patchMemoryFile", P, { filename: "extra.md", description: "index is a dir" }),
      C("patchMemoryFile", P, { filename: "extra.md", body: "index is a dir, description kept" }),
      S(RM(`${PM}/MEMORY.md`), W(`${PM}/MEMORY.md`, "# index\n- [Old name](extra.md) hand-edited\n- [Q](q.md) kept\n")),
      C("patchMemoryFile", P, { filename: "extra.md", description: null }),
      S(W(`${PM}/MEMORY.md`, "- [Old name](extra.md) hand-edited\n")),
      C("patchMemoryFile", P, { filename: "extra.md", description: "index is a dir" }),
    ],
  },
  {
    name: "auto delete",
    steps: [
      C("writeMemoryFile", P, mem("a.md", "user", "A", "a", "a")),
      C("writeMemoryFile", P, mem("b.md", "user", "B", "b", "b")),
      C("writeMemoryFile", P, mem("c.md", "user", "C", "c", "c")),
      C("deleteMemoryFile", P, "b.md"),
      C("deleteMemoryFile", P, "b.md"),
      C("deleteMemoryFile", P, "../b.md"),
      C("deleteMemoryFile", P, ""),
      S(W(`${PM}/MEMORY.md`, `- [A](a.md) ${U(0x2014)} a\nfree text (a.md) again\n- [C](c.md) ${U(0x2014)} c`)),
      C("deleteMemoryFile", P, "a.md"),
      S(W(`${PM}/x.md`, "x")),
      C("deleteMemoryFile", P, "x.md"),
      C("deleteMemoryFile", P, "MEMORY.md"),
      C("deleteMemoryFile", P, "c.md"),
      S(
        W(`${PM}/y.md`, "y"),
        LN(`${PM}/link.md`, "$ROOT/outside/plain.txt"),
        LN(`${PM}/dangling.md`, "$ROOT/outside/nope.md"),
        MK(`${PM}/MEMORY.md`),
      ),
      C("deleteMemoryFile", P, "link.md"),
      C("deleteMemoryFile", P, "dangling.md"),
      C("deleteMemoryFile", P, "y.md"),
    ],
  },
  {
    name: "auto index",
    steps: [
      S(W(`${PM}/MEMORY.md`, "# no trailing newline")),
      C("appendMemoryIndex", P, "a.md", "A", "first"),
      C("appendMemoryIndex", P, "a.md", "A", "again"),
      C("appendMemoryIndex", P, "aa.md", "AA", "not the same marker"),
      C("appendMemoryIndex", P, "x).md", "odd", "marker with paren"),
      C("appendMemoryIndex", P, "", "", ""),
      C("appendMemoryIndex", P, "u.md", `caf${U(0xe9)}`, `${U(0x1f600)} d`),
      S(W(`${PM}/MEMORY.md`, "")),
      C("appendMemoryIndex", P, "e.md", "E", "empty index"),
      S(W(`${PM}/MEMORY.md`, bigIndex(199, 100))),
      C("appendMemoryIndex", P, "fits.md", "F", "x".repeat(70)),
      C("appendMemoryIndex", P, "over.md", "O", "x"),
      S(W(`${PM}/MEMORY.md`, bigIndex(199, 100))),
      C("appendMemoryIndex", P, "exact.md", "E", "x".repeat(101 - EXACT_LINE)),
      C("appendMemoryIndex", P, "exact.md", "E", "x".repeat(100 - EXACT_LINE)),
      S(W(`${PM}/MEMORY.md`, `---\n${"f".repeat(400)}\n---\n<!--${"c".repeat(300)}-->${bigIndex(199, 100)}`)),
      C("appendMemoryIndex", P, "fm.md", "F", "x".repeat(70)),
      C("appendMemoryIndex", P, "fm2.md", "G", "x"),
      S(W(`${PM}/MEMORY.md`, bigIndex(199, 100))),
      C("writeMemoryFile", P, mem("big.md", "user", "Big", "x".repeat(200), "body")),
      C("writeMemoryFile", P, mem("e0.md", "user", "Already", "indexed", "body")),
      S(RM(`${PM}/MEMORY.md`)),
      C("writeMemoryFile", P, mem("MEMORY.md", "user", "Self", "the index itself", "self body\n")),
      C("readMemoryFile", P, "MEMORY.md"),
      C("patchMemoryFile", P, { filename: "MEMORY.md", description: "patched self" }),
      C("writeMemoryFile", P, mem("MEMORY.md", "user", "Self", "again", "x")),
      S(RM(`${PM}/MEMORY.md`), MK(`${PM}/MEMORY.md`)),
      C("writeMemoryFile", P, mem("g.md", "user", "G", "index is a dir", "g")),
      C("appendMemoryIndex", P, "h.md", "H", "index is a dir"),
      S(RM(`${PM}/MEMORY.md`), WB(`${PM}/MEMORY.md`, [0x2d, 0x20, 0xff, 0x0a, 0xe2, 0x82])),
      C("appendMemoryIndex", P, "i.md", "I", "lossy index"),
    ],
  },
  {
    name: "auto links and odd entries",
    steps: [
      S(
        LN(`${PM}/link.md`, "$ROOT/outside/secret.md"),
        LN(`${PM}/dangling.md`, "$ROOT/outside/nope.md"),
        LN(`${PM}/loop.md`, `$ROOT/${PM}/loop.md`),
        LN(`${PM}/text.md`, "$ROOT/outside/plain.txt"),
        W(`${PM}/real.md`, "real"),
        MT("outside/secret.md", 1700000000),
        MT("outside/plain.txt", 1700000001),
        MT(`${PM}/real.md`, 1700000002),
      ),
      C("listAutoMemory", P),
      C("readMemoryFile", P, "link.md"),
      C("readMemoryFile", P, "dangling.md"),
      C("readMemoryFile", P, "loop.md"),
      C("writeMemoryFile", P, mem("link.md", "user", "n", "d", "b")),
      C("writeMemoryFile", P, mem("dangling.md", "user", "n", "d", "b")),
      C("writeMemoryFile", P, mem("loop.md", "user", "n", "d", "b")),
      C("patchMemoryFile", P, { filename: "link.md", body: "written through the link\n" }),
      C("patchMemoryFile", P, { filename: "text.md", body: "x" }),
      C("patchMemoryFile", P, { filename: "dangling.md", body: "x" }),
      C("patchMemoryFile", P, { filename: "loop.md", body: "x" }),
      C("deleteMemoryFile", P, "loop.md"),
      S(RM(`${PM}`), LN(`${PM}`, "$ROOT/outside"), MT("outside/secret.md", 1700000005)),
      C("listAutoMemory", P),
      C("writeMemoryFile", P, mem("via.md", "user", "Via", "dir link", "b")),
      S(RM(`${PM}`), W(`${PM}`, "a file")),
      C("listAutoMemory", P),
      C("readMemoryFile", P, "a.md"),
      C("writeMemoryFile", P, mem("a.md", "user", "n", "d", "b")),
      C("patchMemoryFile", P, { filename: "a.md" }),
      C("deleteMemoryFile", P, "a.md"),
      C("appendMemoryIndex", P, "a.md", "n", "d"),
    ],
  },
  {
    name: "auto listing edges",
    steps: [
      S(
        W(`${PM}/plainmd`, "not listed\n"),
        W(`${PM}/x.amd`, "not listed\n"),
        W(`${PM}/old.md`, "before the epoch\n"),
        W(`${PM}/older.md`, "a day before the epoch\n"),
        MT(`${PM}/old.md`, -1.5),
        MT(`${PM}/older.md`, -86400.25),
        ...Array.from({ length: 48 }, (_, i) => W(`${PM}/t${String(i).padStart(2, "0")}.md`, `tie ${i}\n`)),
        ...Array.from({ length: 48 }, (_, i) => MT(`${PM}/t${String(i).padStart(2, "0")}.md`, 1600000000 + ((i * 7) % 3) * 1000)),
      ),
      C("listAutoMemory", P),
      C("readMemoryFile", P, "plainmd"),
      C("deleteMemoryFile", P, "x.amd"),
    ],
  },
  {
    name: "auto directory entries",
    os: process.platform,
    steps: [
      S(MK(`${PM}/sub.md`), W(`${PM}/MEMORY.md`, "- [Sub](sub.md) x\n")),
      C("readMemoryFile", P, "sub.md"),
      C("writeMemoryFile", P, mem("sub.md", "user", "n", "d", "b")),
      C("patchMemoryFile", P, { filename: "sub.md" }),
      C("deleteMemoryFile", P, "sub.md"),
    ],
  },
  {
    name: "auto permissions",
    needs: ["perm"],
    steps: [
      C("writeMemoryFile", P, mem("a.md", "user", "A", "a", "a")),
      S(CH(`${PM}/a.md`, 0o444)),
      C("patchMemoryFile", P, { filename: "a.md", body: "x" }),
      S(CH(`${PM}/a.md`, 0o000), MT(`${PM}/a.md`, 1700000000), MT(`${PM}/MEMORY.md`, 1700000001)),
      C("readMemoryFile", P, "a.md"),
      C("patchMemoryFile", P, { filename: "a.md", body: "x" }),
      C("listAutoMemory", P),
      S(CH(`${PM}/a.md`, 0o644), CH(PM, 0o555)),
      C("writeMemoryFile", P, mem("b.md", "user", "B", "b", "b")),
      C("deleteMemoryFile", P, "a.md"),
      C("patchMemoryFile", P, { filename: "a.md", description: "dir read-only" }),
      S(CH(PM, 0o000)),
      C("listAutoMemory", P),
      C("readMemoryFile", P, "a.md"),
      C("deleteMemoryFile", P, "a.md"),
      C("writeMemoryFile", P, mem("c.md", "user", "C", "c", "c")),
      S(CH(PM, 0o755), CH(`${PM}/MEMORY.md`, 0o444)),
      C("writeMemoryFile", P, mem("d.md", "user", "D", "index read-only", "d")),
      C("deleteMemoryFile", P, "a.md"),
      S(CH(`${PM}/MEMORY.md`, 0o000)),
      C("writeMemoryFile", P, mem("e.md", "user", "E", "index unreadable", "e")),
      S(CH(`${PM}/MEMORY.md`, 0o644)),
    ],
  },
  {
    name: "rules user",
    steps: [
      C("listRules", "user"),
      C("readRule", "user", "a.md"),
      C("deleteRule", "user", "a.md"),
      C("writeRule", "user", "b.md", "x", null, true),
      C("writeRule", "user", "a.md", "# A\n\nrule body\n"),
      C("writeRule", "user", "a.md", "again"),
      C("writeRule", "user", "a.md", "edited\n", null, true),
      C("writeRule", "user", "a.md", "", "/ignored", true),
      C("writeRule", "user", "u.md", `caf${U(0xe9)} ${U(0x1f600)}\r\n`, null, false),
      ...FILENAMES.filter((f) => !rules.isValidRuleFilename(f)).map((f) => C("writeRule", "user", f, "x")),
      C("readRule", "user", "a.md"),
      C("readRule", "user", "u.md"),
      C("readRule", "user", "../a.md"),
      C("readRule", "user", "nope.md"),
      S(
        W("home/.claude/rules/notes.txt", "n"),
        W(`home/.claude/rules/caf${U(0xe9)}.md`, "listed but not readable by name"),
        MT("home/.claude/rules/a.md", 1700000000.75),
        MT("home/.claude/rules/u.md", 1700000000.75),
        MT(`home/.claude/rules/caf${U(0xe9)}.md`, 1500000000),
      ),
      C("listRules", "user"),
      C("listRules", "user", "/ignored"),
      C("readRule", "user", `caf${U(0xe9)}.md`),
      C("deleteRule", "user", "a.md"),
      C("deleteRule", "user", "a.md"),
      C("deleteRule", "user", "../u.md"),
    ],
  },
  {
    name: "rules project",
    steps: [
      C("listRules", "project", P),
      C("writeRule", "project", "p.md", "project rule\n", P),
      C("writeRule", "project", "p.md", "x", P),
      C("writeRule", "project", "p.md", "edited", P, true),
      C("readRule", "project", "p.md", P),
      S(MT("project/.claude/rules/p.md", 1700000000)),
      C("listRules", "project", P),
      C("listRules", "project", `${P}/`),
      C("listRules", "project", "$ROOT/ws/../project"),
      C("writeRule", "project", "n.md", "creates the tree", "$ROOT/nowhere/deep"),
      C("listRules", "project", null),
      C("listRules", "project", ""),
      C("listRules", "project", "rel/x"),
      C("listRules", "project", `/a${U(0)}b`),
      C("readRule", "project", "p.md", null),
      C("readRule", "project", "../p.md", null),
      C("readRule", "project", "p.md", "rel"),
      C("writeRule", "project", "p.md", "x", null),
      C("writeRule", "project", "../p.md", "x", null),
      C("writeRule", "project", "p.md", "x", `/a${U(0)}b`, true),
      C("deleteRule", "project", "p.md", "rel"),
      C("deleteRule", "project", "bad name", "rel"),
      C("deleteRule", "project", "p.md", P),
      C("deleteRule", "project", "p.md", P),
    ],
  },
  {
    name: "rules odd entries",
    steps: [
      S(
        W("project/.claude/rules/real.md", "real"),
        LN("project/.claude/rules/link.md", "$ROOT/outside/plain.txt"),
        LN("project/.claude/rules/dangling.md", "$ROOT/outside/nope.md"),
        LN("project/.claude/rules/loop.md", "$ROOT/project/.claude/rules/loop.md"),
        MT("project/.claude/rules/real.md", 1700000000),
        MT("outside/plain.txt", 1700000001),
      ),
      C("listRules", "project", P),
      C("readRule", "project", "link.md", P),
      C("readRule", "project", "dangling.md", P),
      C("readRule", "project", "loop.md", P),
      C("writeRule", "project", "link.md", "x", P),
      C("writeRule", "project", "dangling.md", "x", P),
      C("writeRule", "project", "dangling.md", "x", P, true),
      C("writeRule", "project", "loop.md", "x", P, true),
      C("writeRule", "project", "link.md", "through the link\n", P, true),
      C("deleteRule", "project", "dangling.md", P),
      C("deleteRule", "project", "link.md", P),
      S(RM("project/.claude/rules"), W("project/.claude/rules", "a file")),
      C("listRules", "project", P),
      C("readRule", "project", "a.md", P),
      C("writeRule", "project", "a.md", "x", P),
      C("writeRule", "project", "a.md", "x", P, true),
      C("deleteRule", "project", "a.md", P),
      S(RM("project/.claude"), W("project/.claude", "a file")),
      C("writeRule", "project", "a.md", "x", P),
      C("listRules", "project", P),
    ],
  },
  {
    name: "rules directory entries",
    os: process.platform,
    steps: [
      S(MK("home/.claude/rules/sub.md")),
      C("readRule", "user", "sub.md"),
      C("writeRule", "user", "sub.md", "x"),
      C("writeRule", "user", "sub.md", "x", null, true),
      C("deleteRule", "user", "sub.md"),
    ],
  },
  {
    name: "rules permissions",
    needs: ["perm"],
    steps: [
      C("writeRule", "user", "a.md", "a"),
      S(CH("home/.claude/rules/a.md", 0o444)),
      C("writeRule", "user", "a.md", "x", null, true),
      S(CH("home/.claude/rules/a.md", 0o000)),
      C("readRule", "user", "a.md"),
      S(CH("home/.claude/rules/a.md", 0o644), CH("home/.claude/rules", 0o555)),
      C("writeRule", "user", "b.md", "b"),
      C("writeRule", "user", "a.md", "still writable", null, true),
      C("deleteRule", "user", "a.md"),
      S(CH("home/.claude/rules", 0o000)),
      C("listRules", "user"),
      C("readRule", "user", "a.md"),
      C("writeRule", "user", "a.md", "x", null, true),
      C("deleteRule", "user", "a.md"),
      S(CH("home/.claude/rules", 0o755), RM("home/.claude/rules"), CH("home/.claude", 0o555)),
      C("writeRule", "user", "c.md", "c"),
      S(CH("home/.claude", 0o755)),
    ],
  },
];

const modules = [];
for (const sc of MODULES) {
  if ((sc.needs ?? []).includes("perm") && !PERM) {
    modules.push({ name: sc.name, os: null, needs: sc.needs, skipped: true });
    continue;
  }
  modules.push(await runScenario(sc));
}

// --------------------------------- routes ---------------------------------

async function request(req) {
  if (!/^[\x21-\x7e]+$/.test(req.url) || req.url.includes("#")) throw new Error(`url must be plain ASCII: ${req.url}`);
  const init = { method: req.method };
  if (req.body !== undefined) init.body = toAbs(req.body);
  const r = new Request(`http://localhost${toAbs(req.url)}`, init);
  const mod = req.url.startsWith("/api/memory/auto") ? autoRoute : rulesRoute;
  try {
    const res = await mod[req.method](r);
    return { status: res.status, type: res.headers.get("content-type"), body: toRel(await res.text()) };
  } catch (e) {
    return { threw: toRel(e instanceof Error ? `${e.name}: ${e.message}` : String(e)) };
  }
}

async function runGroup(group) {
  buildWorld();
  sessionManager.sessions.clear();
  const hosts = (group.sessions ?? []).map((s) => {
    const host = bareSession(`00000000-0000-4000-8000-00000000000${s.key.charCodeAt(0) - 64}`, toAbs(s.cwd), s.reads.map(toAbs));
    sessionManager.sessions.set(host.id, host);
    return [s.key, host];
  });
  const steps = [];
  for (const step of group.steps) {
    if (step.setup) {
      steps.push({ setup: step.setup.map(apply) });
      continue;
    }
    const before = snapshot();
    tick();
    const got = await request(step);
    const after = snapshot();
    const reminders = Object.fromEntries(hosts.map(([k, h]) => [k, deep(takePendingReminders(h), toRel)]));
    steps.push({
      request: { method: step.method, url: step.url, ...(step.body !== undefined ? { body: step.body } : {}) },
      got,
      changes: changes(before, after),
      reminders,
    });
  }
  sessionManager.sessions.clear();
  return {
    name: group.name,
    os: group.os ?? null,
    needs: group.needs ?? [],
    sessions: group.sessions ?? [],
    probes: !!group.probes,
    steps,
    final: snapshot(),
  };
}

const AUTO = (method, query, body) => ({
  method,
  url: `/api/memory/auto${query === undefined ? "" : `?${query}`}`,
  ...(body === undefined ? {} : { body: typeof body === "string" ? body : J(body) }),
});
const RULES = (method, query, body) => ({
  method,
  url: `/api/memory/rules${query === undefined ? "" : `?${query}`}`,
  ...(body === undefined ? {} : { body: typeof body === "string" ? body : J(body) }),
});
const CW = "cwd=$ROOT/project";
const WS = "cwd=$ROOT/ws";
const UNIQ = `cwd=$ROOT/${encodeURIComponent(UNI)}`;
const LONGQ = `cwd=$ROOT/${LONG}`;
const NULQ = "cwd=$ROOT/nul%00x";
const body = (filename, type = "user", name = "N", description = "D", b = "B") => ({ filename, type, name, description, body: b });

// Session A (project) has Read the project's a.md and index plus an unrelated
// file; B (project) has Read nothing; C (ws) has Read the project's a.md.
const SESSIONS = [
  { key: "A", cwd: "$ROOT/project", reads: [MEMF("project", "a.md"), "$ROOT/outside/plain.txt", MEMF("project", "MEMORY.md"), MEMF("project", "b.md")] },
  { key: "B", cwd: "$ROOT/project", reads: [] },
  { key: "C", cwd: "$ROOT/ws", reads: [MEMF("project", "a.md"), MEMF("ws", "w.md")] },
];

const ROUTES = [
  {
    name: "auto flow",
    sessions: SESSIONS,
    probes: true,
    steps: [
      AUTO("GET", CW),
      AUTO("POST", CW, body("a.md", "user", "Alpha", "first", "Alpha body\n")),
      AUTO("GET", `${CW}&file=a.md`),
      AUTO("POST", CW, body("b.md", "feedback", "Be: #1", "line\nbreak", "")),
      S(MT(`${PM}/a.md`, 1700000000.123456), MT(`${PM}/b.md`, 1700000001), MT(`${PM}/MEMORY.md`, 1600000000.5)),
      AUTO("GET", CW),
      AUTO("PATCH", `${CW}&filename=a.md`, { description: "changed" }),
      AUTO("PATCH", `${CW}&filename=b.md`, { body: "b body" }),
      AUTO("DELETE", `${CW}&filename=a.md`),
      AUTO("DELETE", `${CW}&filename=nope.md`),
      AUTO("POST", WS, body("w.md", "project", "W", "ws memory", "w")),
      AUTO("PATCH", `${WS}&filename=w.md`, { type: "reference" }),
      AUTO("POST", "cwd=", body("c.md")),
      AUTO("POST", undefined, body("d.md")),
      AUTO("DELETE", "filename=c.md"),
      AUTO("POST", `cwd=$ROOT/ws-extra`, body("x.md")),
      AUTO("POST", CW, body("b.md")),
      AUTO("PATCH", `${CW}&filename=b.md`, { type: "bogus" }),
    ],
  },
  {
    name: "auto requests",
    sessions: SESSIONS,
    probes: false,
    steps: [
      // ---- cwd ----
      AUTO("GET", "cwd=$ROOT/untrusted"),
      AUTO("GET", "cwd=$ROOT/nowhere"),
      AUTO("GET", "cwd=relative"),
      AUTO("GET", "cwd=%20"),
      AUTO("GET", "cwd=$ROOT/project/"),
      AUTO("GET", "cwd=$ROOT/ws/../project"),
      AUTO("GET", `cwd=$ROOT/project&cwd=$ROOT/untrusted`),
      AUTO("POST", "cwd=$ROOT/untrusted", body("a.md")),
      AUTO("PATCH", "cwd=$ROOT/untrusted&filename=a.md", "{}"),
      AUTO("DELETE", "cwd=$ROOT/untrusted&filename=a.md"),
      AUTO("POST", "cwd=$ROOT/untrusted", "not json"),
      // ---- bodies ----
      AUTO("POST", CW),
      AUTO("POST", CW, ""),
      AUTO("POST", CW, "{"),
      AUTO("POST", CW, "null"),
      AUTO("POST", CW, "[]"),
      AUTO("POST", CW, '"a.md"'),
      AUTO("POST", CW, "5"),
      AUTO("POST", CW, "{}"),
      AUTO("POST", CW, { filename: "a.md", type: "user", name: "n", description: "d" }),
      AUTO("POST", CW, { filename: "a.md", type: "user", name: "n", description: 5, body: "b" }),
      AUTO("POST", CW, { filename: 1, type: "user", name: "n", description: "d", body: "b" }),
      AUTO("POST", CW, { filename: "a.md", type: null, name: "n", description: "d", body: "b" }),
      AUTO("POST", CW, { filename: "a.md", type: "user", name: ["n"], description: "d", body: "b" }),
      AUTO("POST", CW, '{"filename":"a.md","type":"user","name":"n","description":"d","body":1e400}'),
      AUTO("POST", CW, `${U(0xfeff)}{"filename":"bom.md","type":"user","name":"n","description":"d","body":"b"}`),
      AUTO("POST", CW, body("bad name.md")),
      AUTO("POST", CW, body("../a.md")),
      AUTO("POST", CW, body("a.md", "other")),
      AUTO("POST", CW, body("a.md", "user", " ", "d")),
      AUTO("POST", CW, body("a.md", "user", "Alpha", "first", "Alpha body\n")),
      AUTO("POST", CW, body("a.md")),
      AUTO("POST", CW, { ...body("e.md"), extra: true, body: `caf${U(0xe9)} ${U(0x1f600)}` }),
      AUTO("POST", CW, `{"filename":"s.md","type":"user","name":"n${BS}ud800","description":"d","body":"lone ${BS}udc00 half"}`),
      AUTO("POST", CW, `{"filename":"dup.md","filename":"dup2.md","type":"user","name":"n","description":"d","body":"b"}`),
      // ---- GET ----
      S(
        MT(`${PM}/a.md`, 1700000006),
        MT(`${PM}/MEMORY.md`, 1700000005),
        MT(`${PM}/e.md`, 1700000004),
        MT(`${PM}/s.md`, 1700000003),
        MT(`${PM}/bom.md`, 1700000002),
        MT(`${PM}/dup2.md`, 1700000001),
      ),
      AUTO("GET", `${CW}&file=`),
      AUTO("GET", `${CW}&file=a.md`),
      AUTO("GET", `${CW}&file=e.md`),
      AUTO("GET", `${CW}&file=MEMORY.md`),
      AUTO("GET", `${CW}&file=nope.md`),
      AUTO("GET", `${CW}&file=..%2FMEMORY.md`),
      AUTO("GET", `${CW}&file=%2e%2e%2fa.md`),
      AUTO("GET", `${CW}&file=a.md%00`),
      AUTO("GET", `${CW}&file=a+b.md`),
      AUTO("GET", `${CW}&file=%61.md`),
      AUTO("GET", `${CW}&file=a.md&file=nope.md`),
      AUTO("GET", `${CW}&file=%E9.md`),
      // ---- PATCH ----
      AUTO("PATCH", CW, "{}"),
      AUTO("PATCH", `${CW}&filename=`, "{}"),
      AUTO("PATCH", `${CW}&filename=a.md`),
      AUTO("PATCH", `${CW}&filename=a.md`, "{"),
      AUTO("PATCH", `${CW}&filename=a.md`, "null"),
      AUTO("PATCH", `${CW}&filename=a.md`, "[]"),
      AUTO("PATCH", `${CW}&filename=a.md`, '"x"'),
      AUTO("PATCH", `${CW}&filename=a.md`, "{}"),
      AUTO("PATCH", `${CW}&filename=a.md`, { other: 1 }),
      AUTO("PATCH", `${CW}&filename=a.md`, { description: null }),
      AUTO("PATCH", `${CW}&filename=a.md`, { type: 0 }),
      AUTO("PATCH", `${CW}&filename=a.md`, "{\"type\":-0}"),
      AUTO("PATCH", `${CW}&filename=a.md`, { type: false, body: 12.5 }),
      AUTO("PATCH", `${CW}&filename=a.md`, { type: "" }),
      AUTO("PATCH", `${CW}&filename=a.md`, { type: "bogus" }),
      AUTO("PATCH", `${CW}&filename=a.md`, { type: 1 }),
      AUTO("PATCH", `${CW}&filename=a.md`, { description: [":", 2] }),
      AUTO("PATCH", `${CW}&filename=a.md`, { description: ["plain"] }),
      AUTO("PATCH", `${CW}&filename=a.md`, { description: 3 }),
      AUTO("PATCH", `${CW}&filename=a.md`, { body: { valueOf: 1 } }),
      AUTO("PATCH", `${CW}&filename=a.md`, { body: { toString: 1 } }),
      AUTO("PATCH", `${CW}&filename=a.md`, { body: [1, [2, null]] }),
      AUTO("PATCH", `${CW}&filename=a.md`, '{"body":"1e400 next","description":"big","type":"user"}'),
      AUTO("PATCH", `${CW}&filename=a.md`, '{"description":"n1.0","body":1.0}'),
      AUTO("PATCH", `${CW}&filename=a.md`, `{"description":"${BS}ud83d lone"}`),
      AUTO("PATCH", `${CW}&filename=a.md`, { description: "final", type: "feedback", body: "final body\n" }),
      AUTO("PATCH", `${CW}&filename=nope.md`, { body: "x" }),
      AUTO("PATCH", `${CW}&filename=..%2Fa.md`, { body: "x" }),
      AUTO("PATCH", `${CW}&filename=a.md&filename=e.md`, { body: "first wins" }),
      // ---- DELETE ----
      AUTO("DELETE", CW),
      AUTO("DELETE", `${CW}&filename=`),
      AUTO("DELETE", `${CW}&filename=..%2Fa.md`),
      AUTO("DELETE", `${CW}&filename=nope.md`),
      AUTO("DELETE", `${CW}&filename=e.md`, "ignored body"),
      AUTO("DELETE", `${CW}&filename=e.md`),
      S(MT(`${PM}/a.md`, 1700000000), MT(`${PM}/MEMORY.md`, 1700000000), MT(`${PM}/s.md`, 1700000002), MT(`${PM}/bom.md`, 1700000001), MT(`${PM}/dup2.md`, 1700000003)),
      AUTO("GET", CW),
    ],
  },
  {
    name: "auto cwds",
    sessions: SESSIONS,
    probes: false,
    steps: [
      AUTO("GET", UNIQ),
      AUTO("POST", UNIQ, body("u.md", "user", "Uni", "unicode root")),
      S(MT(`${MEM(UNI)}/u.md`, 1700000000), MT(`${MEM(UNI)}/MEMORY.md`, 1700000001)),
      AUTO("GET", UNIQ),
      AUTO("DELETE", `${UNIQ}&filename=u.md`),
      AUTO("GET", LONGQ),
      AUTO("POST", LONGQ, body("l.md")),
      AUTO("GET", `${LONGQ}&file=l.md`),
      AUTO("PATCH", `${LONGQ}&filename=l.md`, { body: "x" }),
      AUTO("DELETE", `${LONGQ}&filename=l.md`),
      AUTO("GET", NULQ),
      AUTO("POST", NULQ, body("n.md", "user", "Nul", "nul root")),
      AUTO("GET", `${NULQ}&file=n.md`),
      AUTO("GET", "cwd=$ROOT/ws-extra"),
      AUTO("POST", "cwd=$ROOT/ws-extra", body("x.md")),
      S(MT(`${MEM("ws-extra")}/x.md`, 1700000000), MT(`${MEM("ws-extra")}/MEMORY.md`, 1700000000)),
      AUTO("GET", "cwd=$ROOT/ws-extra"),
    ],
  },
  {
    name: "auto disk errors",
    sessions: SESSIONS,
    probes: false,
    steps: [
      S(W(MEM("ws-extra"), "memory is a file")),
      AUTO("GET", "cwd=$ROOT/ws-extra"),
      AUTO("GET", "cwd=$ROOT/ws-extra&file=a.md"),
      AUTO("POST", "cwd=$ROOT/ws-extra", body("a.md")),
      AUTO("PATCH", "cwd=$ROOT/ws-extra&filename=a.md", { body: "x" }),
      AUTO("DELETE", "cwd=$ROOT/ws-extra&filename=a.md"),
      S(RM(MEM("ws-extra")), MK(`${MEM("ws-extra")}/MEMORY.md`)),
      AUTO("POST", "cwd=$ROOT/ws-extra", body("a.md")),
      AUTO("PATCH", "cwd=$ROOT/ws-extra&filename=a.md", { description: "new" }),
      AUTO("PATCH", "cwd=$ROOT/ws-extra&filename=a.md", { body: "x" }),
      AUTO("DELETE", "cwd=$ROOT/ws-extra&filename=a.md"),
      S(RM(MEM("ws-extra")), W(`${MEM("ws-extra")}/MEMORY.md`, bigIndex(199, 100))),
      AUTO("POST", "cwd=$ROOT/ws-extra", body("big.md", "user", "Big", "x".repeat(200))),
      AUTO("POST", "cwd=$ROOT/ws-extra", body("small.md", "user", "S", "s")),
      S(
        RM(MEM("ws-extra")),
        LN(`${MEM("ws-extra")}/link.md`, "$ROOT/outside/secret.md"),
        LN(`${MEM("ws-extra")}/loop.md`, `$ROOT/${MEM("ws-extra")}/loop.md`),
      ),
      AUTO("GET", "cwd=$ROOT/ws-extra&file=link.md"),
      AUTO("GET", "cwd=$ROOT/ws-extra&file=loop.md"),
      AUTO("PATCH", "cwd=$ROOT/ws-extra&filename=link.md", { description: "through" }),
      AUTO("PATCH", "cwd=$ROOT/ws-extra&filename=loop.md", { body: "x" }),
      AUTO("POST", "cwd=$ROOT/ws-extra", body("loop.md")),
      AUTO("DELETE", "cwd=$ROOT/ws-extra&filename=link.md"),
    ],
  },
  {
    name: "auto directory entries",
    os: process.platform,
    sessions: [],
    probes: false,
    steps: [
      S(MK(`${PM}/sub.md`)),
      AUTO("GET", `${CW}&file=sub.md`),
      AUTO("PATCH", `${CW}&filename=sub.md`, { body: "x" }),
      AUTO("DELETE", `${CW}&filename=sub.md`),
      AUTO("POST", CW, body("sub.md")),
    ],
  },
  {
    name: "auto permissions",
    needs: ["perm"],
    sessions: [],
    probes: false,
    steps: [
      AUTO("POST", CW, body("a.md")),
      S(CH(PM, 0o555)),
      AUTO("POST", CW, body("b.md")),
      AUTO("DELETE", `${CW}&filename=a.md`),
      S(CH(PM, 0o000)),
      AUTO("GET", CW),
      AUTO("GET", `${CW}&file=a.md`),
      AUTO("PATCH", `${CW}&filename=a.md`, { body: "x" }),
      S(CH(PM, 0o755)),
    ],
  },
  {
    name: "rules flow",
    probes: false,
    steps: [
      RULES("GET", "scope=user"),
      RULES("POST", "scope=user", { filename: "a.md", body: "# A\n" }),
      RULES("GET", "scope=user&file=a.md"),
      RULES("PATCH", "scope=user&filename=a.md", { body: "edited" }),
      S(MT("home/.claude/rules/a.md", 1700000000.5)),
      RULES("GET", "scope=user"),
      RULES("GET", `scope=user&cwd=$ROOT/untrusted`),
      RULES("DELETE", "scope=user&filename=a.md"),
      RULES("GET", CW),
      RULES("POST", CW, { filename: "p.md", body: "project rule\n" }),
      RULES("GET", `scope=project&${CW}&file=p.md`),
      S(MT("project/.claude/rules/p.md", 1700000000)),
      RULES("GET", `scope=project&${CW}`),
      RULES("PATCH", `scope=project&${CW}&filename=p.md`, { body: "edited project rule" }),
      RULES("DELETE", `scope=project&${CW}&filename=p.md`),
      RULES("POST", `scope=project&${WS}`, { filename: "w.md", body: "ws rule" }),
      RULES("GET", `scope=project&cwd=$ROOT/ws-extra`),
      RULES("GET", "scope=project"),
      RULES("GET", "scope=project&cwd="),
      RULES("POST", "scope=project", { filename: "q.md", body: "default cwd" }),
    ],
  },
  {
    name: "rules requests",
    probes: false,
    steps: [
      RULES("GET", "scope="),
      RULES("GET", "scope=USER"),
      RULES("GET", "scope=global"),
      RULES("POST", "scope=bad", "not json"),
      RULES("PATCH", "scope=bad", "{}"),
      RULES("DELETE", "scope=bad&filename=a.md"),
      RULES("GET", "scope=project&cwd=$ROOT/untrusted"),
      RULES("POST", "scope=project&cwd=$ROOT/untrusted", "not json"),
      RULES("PATCH", "scope=project&cwd=$ROOT/untrusted", "{}"),
      RULES("DELETE", "scope=project&cwd=$ROOT/untrusted"),
      RULES("GET", "scope=user&scope=project"),
      // ---- bodies ----
      RULES("POST", "scope=user"),
      RULES("POST", "scope=user", ""),
      RULES("POST", "scope=user", "{"),
      RULES("POST", "scope=user", "null"),
      RULES("POST", "scope=user", "[]"),
      RULES("POST", "scope=user", "{}"),
      RULES("POST", "scope=user", { filename: "a.md" }),
      RULES("POST", "scope=user", { filename: "a.md", body: 5 }),
      RULES("POST", "scope=user", { filename: 5, body: "x" }),
      RULES("POST", "scope=user", '{"filename":"a.md","body":1e400}'),
      RULES("POST", "scope=user", { filename: "bad name.md", body: "x" }),
      RULES("POST", "scope=user", { filename: "../a.md", body: "x" }),
      RULES("POST", "scope=user", { filename: "/abs.md", body: "x" }),
      RULES("POST", "scope=user", { filename: "a.md", body: "" }),
      RULES("POST", "scope=user", { filename: "a.md", body: "again" }),
      RULES("POST", "scope=user", `{"filename":"s.md","body":"lone ${BS}ud800 half"}`),
      RULES("POST", "scope=user", `${U(0xfeff)}{"filename":"bom.md","body":"b"}`),
      // ---- GET ----
      S(MT("home/.claude/rules/a.md", 1700000003), MT("home/.claude/rules/s.md", 1700000002), MT("home/.claude/rules/bom.md", 1700000001)),
      RULES("GET", "scope=user&file="),
      RULES("GET", "scope=user&file=a.md"),
      RULES("GET", "scope=user&file=s.md"),
      RULES("GET", "scope=user&file=nope.md"),
      RULES("GET", "scope=user&file=..%2Fa.md"),
      RULES("GET", "scope=user&file=a.md%00"),
      // ---- PATCH ----
      RULES("PATCH", "scope=user", "{}"),
      RULES("PATCH", "scope=user&filename=", "{}"),
      RULES("PATCH", "scope=user&filename=a.md"),
      RULES("PATCH", "scope=user&filename=a.md", "{"),
      RULES("PATCH", "scope=user&filename=a.md", "null"),
      RULES("PATCH", "scope=user&filename=a.md", "{}"),
      RULES("PATCH", "scope=user&filename=a.md", { body: null }),
      RULES("PATCH", "scope=user&filename=a.md", { body: ["x"] }),
      RULES("PATCH", "scope=user&filename=nope.md", { body: "x" }),
      RULES("PATCH", "scope=user&filename=..%2Fa.md", { body: "x" }),
      RULES("PATCH", "scope=user&filename=a.md", { body: "patched", filename: "ignored.md" }),
      // ---- DELETE ----
      RULES("DELETE", "scope=user"),
      RULES("DELETE", "scope=user&filename="),
      RULES("DELETE", "scope=user&filename=..%2Fa.md"),
      RULES("DELETE", "scope=user&filename=nope.md"),
      RULES("DELETE", "scope=user&filename=a.md"),
      RULES("DELETE", "filename=s.md"),
      // ---- odd project roots ----
      RULES("GET", `scope=project&${NULQ}`),
      RULES("POST", `scope=project&${NULQ}`, { filename: "n.md", body: "x" }),
      RULES("POST", `scope=project&${NULQ}`, { filename: "bad name", body: "x" }),
      RULES("GET", `scope=project&${NULQ}&file=n.md`),
      RULES("GET", `scope=project&${NULQ}&file=bad`),
      RULES("PATCH", `scope=project&${NULQ}&filename=n.md`, { body: "x" }),
      RULES("DELETE", `scope=project&${NULQ}&filename=n.md`),
      RULES("DELETE", `scope=project&${NULQ}&filename=bad`),
      RULES("POST", `scope=project&${UNIQ}`, { filename: "u.md", body: "unicode root" }),
      S(MT(`${UNI}/.claude/rules/u.md`, 1700000000)),
      RULES("GET", `scope=project&${UNIQ}`),
      RULES("POST", `scope=project&${LONGQ}`, { filename: "l.md", body: "long root" }),
      S(MT(`${LONG}/.claude/rules/l.md`, 1700000000)),
      RULES("GET", `scope=project&${LONGQ}`),
      S(MT("home/.claude/rules/bom.md", 1700000000), MT("home/.claude/rules/s.md", 1700000000.5)),
      RULES("GET", "scope=user"),
    ],
  },
  {
    name: "rules disk errors",
    probes: false,
    steps: [
      S(W("home/.claude/rules", "rules is a file")),
      RULES("GET", "scope=user"),
      RULES("GET", "scope=user&file=a.md"),
      RULES("POST", "scope=user", { filename: "a.md", body: "x" }),
      RULES("PATCH", "scope=user&filename=a.md", { body: "x" }),
      RULES("DELETE", "scope=user&filename=a.md"),
      S(
        RM("home/.claude/rules"),
        LN("home/.claude/rules/link.md", "$ROOT/outside/plain.txt"),
        LN("home/.claude/rules/loop.md", "$ROOT/home/.claude/rules/loop.md"),
        LN("home/.claude/rules/dangling.md", "$ROOT/outside/nope.md"),
        MT("outside/plain.txt", 1700000000),
      ),
      RULES("GET", "scope=user"),
      RULES("GET", "scope=user&file=link.md"),
      RULES("GET", "scope=user&file=loop.md"),
      RULES("PATCH", "scope=user&filename=loop.md", { body: "x" }),
      RULES("PATCH", "scope=user&filename=dangling.md", { body: "x" }),
      RULES("POST", "scope=user", { filename: "dangling.md", body: "x" }),
      RULES("PATCH", "scope=user&filename=link.md", { body: "through the link\n" }),
      RULES("DELETE", "scope=user&filename=link.md"),
      S(RM("home/.claude/rules"), RM("home/.claude"), W("home/.claude", "a file")),
      RULES("GET", "scope=user"),
      RULES("POST", "scope=user", { filename: "a.md", body: "x" }),
      S(RM("home/.claude"), MK("home/.claude/.claudius")),
    ],
  },
  {
    name: "rules directory entries",
    os: process.platform,
    probes: false,
    steps: [
      S(MK("home/.claude/rules/sub.md")),
      RULES("GET", "scope=user&file=sub.md"),
      RULES("POST", "scope=user", { filename: "sub.md", body: "x" }),
      RULES("PATCH", "scope=user&filename=sub.md", { body: "x" }),
      RULES("DELETE", "scope=user&filename=sub.md"),
    ],
  },
  {
    name: "rules permissions",
    needs: ["perm"],
    probes: false,
    steps: [
      RULES("POST", "scope=user", { filename: "a.md", body: "a" }),
      S(CH("home/.claude/rules", 0o555)),
      RULES("POST", "scope=user", { filename: "b.md", body: "b" }),
      RULES("DELETE", "scope=user&filename=a.md"),
      S(CH("home/.claude/rules", 0o000)),
      RULES("GET", "scope=user"),
      RULES("GET", "scope=user&file=a.md"),
      RULES("PATCH", "scope=user&filename=a.md", { body: "x" }),
      S(CH("home/.claude/rules", 0o755)),
    ],
  },
];

const routes = [];
for (const g of ROUTES) {
  if ((g.needs ?? []).includes("perm") && !PERM) {
    routes.push({ name: g.name, os: null, needs: g.needs, skipped: true });
    continue;
  }
  routes.push(await runGroup(g));
}

const fixture = {
  node: process.version,
  platform: process.platform,
  perm: PERM,
  clockBase: BASE,
  world: WORLD,
  pure,
  notify,
  modules,
  routes,
};
writeFileSync(join(ROOT, "out.json"), JSON.stringify(fixture));
