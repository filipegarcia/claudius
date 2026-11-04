#!/usr/bin/env node
// Golden fixture for D12: `lib/server/skills.ts`, `hooks.ts`,
// `keybindings.ts`, `claudemd.ts`, the name rules of
// `lib/shared/skill-names.ts` and `invisible-unicode.ts`, and the route
// handlers `app/api/skills/route.ts`, `skills/[name]/route.ts`,
// `hooks/route.ts`, `hooks/disabled/route.ts`, `keybindings/route.ts` and
// `claudemd/route.ts`, recorded from the real TS sources:
//
//   node rust/scripts/skills-hooks-golden.mjs     (node@22)
//
// Re-runs itself under `--experimental-transform-types` with a resolve hook
// for the extensionless / `@/` imports, twice (two temp roots, both through
// realpath); both recordings must agree byte for byte. The child runs with
// its cwd at `<root>/project` (the first trusted root), HOME at
// `<root>/home`, CLAUDE_CONFIG_DIR at `<root>/config` (a decoy holding
// skills, settings, CLAUDE.md and keybindings that nothing may read) and
// umask 022. `<root>/home/.claude/.claudius/workspaces.json` registers
// `<root>/ws`, a unicode root, a root with a NUL in it and `<root>/dotfile`
// (whose `.claude` is a file); `<root>/untrusted` exists but is not
// registered.
//
// `$ROOT` stands for the root in paths, URLs, bodies, file texts and
// results (swapped textually); `.tmp-PID-N` for the pid and counter in the
// name of `writeSettings`' temp file.
//
// Records:
// - `props`: for every code point, the bits of the Unicode properties the
//   name rules read (`\p{L}`, `\p{M}`, `\p{N}`, Cc, Cf, Cs, Co, Cn,
//   Default_Ignorable_Code_Point, Zs, Soft_Dotted, sc=Latin, sc=Common,
//   sc=Inherited, bit 0 first), as runs `start:bits` in hex.
// - `names`: `[name, bits, visualized, count]`: `isValidSkillDirName` (bit
//   0), `isEngineShownName` (1), `isEngineOfferableName` (2) and
//   `visualizeHiddenNameUnicode`, over hand-picked names and every pair /
//   triple of a set of interesting code points.
// - `modules`: scenarios of direct calls to the exported module functions
//   (`call`, `args` as JSON text where `1e400` is Infinity), interleaved
//   with `setup` file operations (`write` text or `bytes`, `mkdir`, `rm`,
//   `symlink`, `chmod`). Each call records `result` (`JSON.stringify` of
//   its value, "undefined", or "circular" when that throws) or `threw`
//   (`{name, message}`), and `changes`: every watched path whose entry
//   differs from before the call (kind, mode, UTF-8 text or raw bytes,
//   symlink target; `null` when it is gone). Watched: `home/.claude` (but
//   not `.claudius`), `project`, `ws`, `untrusted`, `outside`, `dotfile`,
//   `config` and the unicode root.
// - `routes`: groups of route requests (`method`, `url`, `body` text) and
//   setups, one world per group. Each request records `got` (status,
//   content type and body text, or `threw`: Next's empty 500, as
//   `Name: message`) and `changes`; `final` is every watched path at the
//   end. `needs: ["perm"]` marks groups that only replay on a disk that
//   enforces permissions (not root).
//
// Written to rust/crates/claudius-core/tests/fixtures/skills_hooks_golden.json
// and replayed by crates/claudius-core/tests/skills_hooks_golden.rs (props,
// names, modules) and crates/claudius-server/tests/skills_hooks.rs (routes,
// against the real binary).
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
const out = join(rustDir, "crates/claudius-core/tests/fixtures/skills_hooks_golden.json");

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

if (!process.env.SKILLS_HOOKS_GOLDEN_ROOT) {
  const runs = [0, 1].map(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "skills-hooks-golden-")));
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
            SKILLS_HOOKS_GOLDEN_ROOT: root,
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
    if (process.env.SKILLS_HOOKS_GOLDEN_DUMP) {
      runs.forEach((r, i) => writeFileSync(`${process.env.SKILLS_HOOKS_GOLDEN_DUMP}.${i}.json`, `${JSON.stringify(JSON.parse(r), null, 1)}\n`));
    }
    throw new Error("the two recordings differ");
  }
  const fixture = JSON.parse(runs[0]);
  writeFileSync(out, `${JSON.stringify(fixture, null, 1)}\n`);
  const calls = fixture.modules.reduce((n, s) => n + (s.steps ?? []).filter((x) => x.call).length, 0);
  const requests = fixture.routes.reduce((n, g) => n + (g.steps ?? []).filter((x) => x.request).length, 0);
  console.log(
    `wrote ${out.slice(repo.length + 1)}: ${fixture.props.split(",").length} property runs, ${fixture.names.length} names, ${fixture.modules.length} module scenarios (${calls} calls), ${fixture.routes.length} route groups (${requests} requests)`,
  );
  process.exit(0);
}

// --------------------------------- child ---------------------------------

const ROOT = process.env.SKILLS_HOOKS_GOLDEN_ROOT;
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

const skills = await import(join(repo, "lib/server/skills.ts"));
const hooks = await import(join(repo, "lib/server/hooks.ts"));
const kb = await import(join(repo, "lib/server/keybindings.ts"));
const cmd = await import(join(repo, "lib/server/claudemd.ts"));
const skillNames = await import(join(repo, "lib/shared/skill-names.ts"));
const invisible = await import(join(repo, "lib/shared/invisible-unicode.ts"));
const R = {
  skills: await import(join(repo, "app/api/skills/route.ts")),
  skill: await import(join(repo, "app/api/skills/[name]/route.ts")),
  hooks: await import(join(repo, "app/api/hooks/route.ts")),
  hooksDisabled: await import(join(repo, "app/api/hooks/disabled/route.ts")),
  keybindings: await import(join(repo, "app/api/keybindings/route.ts")),
  claudemd: await import(join(repo, "app/api/claudemd/route.ts")),
};

/** Characters by code point, so this file stays ASCII. */
const U = (...cps) => String.fromCodePoint(...cps);
const BS = String.fromCharCode(92);
const J = (v) => JSON.stringify(v);

const toAbs = (s) => s.replaceAll("$ROOT", ROOT);
// `writeSettings`' temp file is named after the pid and a counter.
const toRel = (s) => s.replaceAll(ROOT, "$ROOT").replace(/\.tmp-[0-9]+-[0-9]+/g, ".tmp-PID-N");

// ---------------------------------- pure ----------------------------------

const PROPS = [
  /\p{L}/u,
  /\p{M}/u,
  /\p{N}/u,
  /\p{Cc}/u,
  /\p{Cf}/u,
  /\p{Cs}/u,
  /\p{Co}/u,
  /\p{Cn}/u,
  /\p{Default_Ignorable_Code_Point}/u,
  /\p{Zs}/u,
  /\p{Soft_Dotted}/u,
  /\p{sc=Latin}/u,
  /\p{sc=Common}/u,
  /\p{sc=Inherited}/u,
];
const runs = [];
let prevBits = -1;
for (let cp = 0; cp <= 0x10ffff; cp++) {
  const s = String.fromCodePoint(cp);
  let bits = 0;
  for (let i = 0; i < PROPS.length; i++) if (PROPS[i].test(s)) bits |= 1 << i;
  if (bits !== prevBits) {
    runs.push(`${cp.toString(16)}:${bits.toString(16)}`);
    prevBits = bits;
  }
}

const lone = (u) => String.fromCharCode(u);
const HAND_NAMES = [
  "",
  "a",
  "deploy",
  "my-skill_1.2",
  ".hidden",
  "..",
  ".",
  "a.",
  "-a",
  "_a",
  "a b",
  "a  b",
  " a",
  "a ",
  " ",
  "a/b",
  `a${BS}b`,
  "a:b",
  "a: b",
  "a :b",
  ":a",
  "a:",
  ":",
  "<a>",
  "a>b",
  U(0xe9),
  `caf${U(0xe9)}`,
  `cafe${U(0x301)}`,
  `${U(0x301)}a`,
  `a${U(0x301).repeat(7)}`,
  `a${U(0x301).repeat(8)}`,
  `a${U(0x301).repeat(9)}`,
  `a${U(0x301).repeat(10)}`,
  `i${U(0x307)}`,
  `i${U(0x301, 0x307)}`,
  `i${U(0x301)}x${U(0x307)}`,
  `j${U(0x307)}`,
  `${U(0x131, 0x301)}`,
  `${U(0x237, 0x308)}`,
  `a${U(0x981)}`,
  `${U(0x995, 0x981)}`,
  `1${U(0x301)}`,
  `1${U(0x981)}`,
  `a${U(0x301, 0x981)}`,
  `${U(0x995, 0x301, 0x981)}`,
  `deploy${U(0x3164)}`,
  `${U(0x115f)}a`,
  `a${U(0x1160)}`,
  U(0x1100, 0x1161),
  U(0x1100, 0x1161, 0x11a8),
  `a${U(0x1161)}`,
  `${U(0x1100)}${U(0x1161).repeat(9)}`,
  `a${U(0xd7b0)}`,
  `a${U(0x200b)}`,
  `a${U(0x200d)}b`,
  `a${U(0x202e)}b`,
  `a${U(0xfeff)}`,
  U(0xfeff),
  `a${U(0xa0)}b`,
  `a${U(0x3000)}b`,
  `a${U(0x2028)}`,
  `a${U(0x2029)}`,
  `a${U(0x2800)}`,
  `a${U(0xfffc)}`,
  `a${U(0x1d159)}`,
  `a${U(0x13441)}`,
  `a${U(0x13442)}`,
  `a${U(0x16fe4)}`,
  `a${U(0xfe0f)}`,
  `a${U(0x34f)}`,
  `a${U(0xe000)}`,
  `a${U(0x378)}`,
  `a${U(0x7f)}`,
  `a${U(0)}`,
  `a${U(0x85)}`,
  `a${U(0x9f)}`,
  `a${U(0xad)}`,
  `a${U(0x180e)}`,
  `a${U(0xe0041)}`,
  `a${lone(0xd800)}`,
  `${lone(0xdc00)}a`,
  `${lone(0xdc00)}${lone(0xd800)}`,
  U(0x1f600),
  `${U(0x1f468, 0x200d, 0x1f4bb)}`,
  "a".repeat(256),
  "a".repeat(257),
  U(0x1f600).repeat(128),
  `${U(0x1f600).repeat(128)}a`,
  `x${U(0x10940)}`,
  U(0x4e2d, 0x6587),
  U(0x661, 0x662),
  U(0x2163),
  U(0xbd),
  // Not U+10F800 and up: the Rust side's stand-ins for lone surrogates.
  `a${U(0xf0000)}`,
  `a${U(0x10f7ff)}`,
  `a${U(0xffff)}`,
  `a${U(0xfffd)}`,
  `x${U(0x5d0, 0x5b0)}`,
  `${U(0x5b0)}x`,
  `a${U(0x20dd)}`,
  `${U(0x30, 0x20e3)}`,
  "&lt;a&gt;",
];
const CPS = [
  0x61, 0x31, 0x20, 0x3a, 0x2e, 0x2d, 0x5f, 0x3c, 0x301, 0x307, 0x308, 0x34f, 0x981, 0x995, 0x131, 0x69, 0x6a,
  0x1160, 0x1100, 0xd7b0, 0x3164, 0x200d, 0xa0, 0xfe0f, 0x2028, 0x5d0, 0x5b0, 0x1f600, 0x4e00, 0x660, 0xd800,
  0xdc00,
];
const TRI = [0x61, 0x20, 0x3a, 0x301, 0x307, 0x981, 0x69, 0x131, 0x1100, 0x1160, 0x3164, 0x5b0, 0x31, 0xd800];
const ch = (cp) => (cp >= 0xd800 && cp <= 0xdfff ? lone(cp) : U(cp));
const allNames = [...HAND_NAMES];
for (const a of CPS) for (const b of CPS) allNames.push(ch(a) + ch(b));
for (const a of TRI) for (const b of TRI) for (const c of TRI) allNames.push(ch(a) + ch(b) + ch(c));
const names = allNames.map((n) => {
  const bits =
    (skills.isValidSkillDirName(n) ? 1 : 0) |
    (skillNames.isEngineShownName(n) ? 2 : 0) |
    (skillNames.isEngineOfferableName(n) ? 4 : 0);
  const v = invisible.visualizeHiddenNameUnicode(n);
  return [n, bits, v.visualized, v.count];
});

// --------------------------------- world ---------------------------------

const UNI = `caf${U(0xe9)} x${U(0x1f600)}`;
const NUL = `nul${U(0)}x`;
const P = "$ROOT/project";
const WSC = "$ROOT/ws";
const UNIC = `$ROOT/${UNI}`;
const NULC = `$ROOT/${NUL}`;
const DOT = "$ROOT/dotfile";
const SK = "home/.claude/skills";
const PSK = "project/.claude/skills";

const WATCH = ["home/.claude", "project", "ws", "untrusted", "outside", "dotfile", "config", UNI];
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Every watched path (keys with placeholders), sorted. */
function snapshot() {
  const snap = {};
  const visit = (rel) => {
    if (rel in snap || rel === "home/.claude/.claudius") return;
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
      let entries = [];
      try {
        entries = readdirSync(abs).sort();
      } catch {
        snap[rel].unreadable = true;
      }
      for (const e of entries) visit(`${rel}/${toRel(e)}`);
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
  for (const w of WATCH) visit(w);
  return Object.fromEntries(Object.keys(snap).sort().map((k) => [k, snap[k]]));
}

function changes(before, after) {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return keys.filter((k) => J(before[k]) !== J(after[k])).map((k) => [k, after[k] ?? null]);
}

const WORLD = {
  dirs: ["home/.claude/.claudius", "project", "ws", "untrusted", "outside", "config", "dotfile", UNI],
  files: [
    [
      "home/.claude/.claudius/workspaces.json",
      `${J(
        {
          version: 1,
          workspaces: [
            ["wks_golden00001", "ws", WSC],
            ["wks_golden00002", "uni", UNIC],
            ["wks_golden00003", "nul", NULC],
            ["wks_golden00004", "dotfile", DOT],
          ].map(([id, name, rootPath]) => ({
            id,
            name,
            rootPath,
            icon: { kind: "letter", letter: "W", color: "#d97757" },
            createdAt: 1,
            updatedAt: 1,
            defaults: { additionalDirectories: [] },
          })),
        },
        null,
        2,
      )}\n`,
    ],
    ["outside/secret.md", "secret line\n"],
    ["outside/SKILL.md", "---\nname: Outside\n---\noutside body\n"],
    ["dotfile/.claude", "a file, not a folder\n"],
    ["config/skills/decoy/SKILL.md", "---\nname: decoy\n---\n"],
    ["config/settings.json", '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"decoy"}]}]}}\n'],
    ["config/CLAUDE.md", "decoy\n"],
    ["config/keybindings.json", '{"decoy":true}\n'],
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

/** JSON text where Infinity is `1e400` (so `JSON.parse` gives it back). */
function ser(v) {
  const INF = `${BS}u0000inf`;
  const NINF = `${BS}u0000-inf`;
  return JSON.stringify(v, (k, x) => (typeof x === "number" && !Number.isFinite(x) ? (x > 0 ? `${U(0)}inf` : `${U(0)}-inf`) : x))
    .replaceAll(`"${INF}"`, "1e400")
    .replaceAll(`"${NINF}"`, "-1e400");
}

const SKILL_MD = (name, description, body) => `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
const CYCLIC = "---\na: &a\n  - *a\n---\nbody\n";
const BAD_UTF8 = [0x2d, 0x2d, 0x2d, 0x0a, 0x6e, 0x61, 0x6d, 0x65, 0x3a, 0x20, 0xff, 0x0a, 0x2d, 0x2d, 0x2d, 0x0a, 0x62, 0xc3, 0x28, 0x0a];
const GROUP = (command, matcher) => ({ ...(matcher === undefined ? {} : { matcher }), hooks: [{ type: "command", command }] });

// --------------------------------- modules ---------------------------------

const MOD = {
  listSkills: skills.listSkills,
  readSkill: skills.readSkill,
  writeSkill: skills.writeSkill,
  deleteSkill: skills.deleteSkill,
  listAll: hooks.listAll,
  addGroup: hooks.addGroup,
  removeGroup: hooks.removeGroup,
  setDisableAllHooks: hooks.setDisableAllHooks,
  readKeybindings: kb.readKeybindings,
  writeKeybindings: kb.writeKeybindings,
  pathFor: cmd.pathFor,
  readScope: cmd.readScope,
  writeScope: cmd.writeScope,
  readAllScopes: cmd.readAllScopes,
  resolveContent: (content, baseDir) => cmd.resolveContent(content, baseDir),
  resolveHierarchy: cmd.resolveHierarchy,
};
const C = (call, ...args) => ({ call, args: ser(args) });

function threwOf(e) {
  return { name: e?.name ?? null, message: toRel(e instanceof Error ? e.message : String(e)) };
}

function resultText(v) {
  if (v === undefined) return "undefined";
  try {
    return toRel(JSON.stringify(v));
  } catch {
    return "circular";
  }
}

const ODD_NAMES = [
  5,
  0,
  true,
  false,
  null,
  ["ab"],
  [],
  {},
  { toString: 1 },
  { valueOf: 1 },
  Infinity,
  -Infinity,
  1.5,
  -0,
  1e21,
  123456789012345680000,
  [null],
  [["x"]],
  [Infinity],
  [1, 2],
  [{ toString: 1 }],
  "a/b",
  "..",
  ".",
  ".x",
  "a b",
  "a:b",
  "",
  `a${U(0x200d)}b`,
];

const MODULES = [
  {
    name: "skills write, read and list",
    steps: [
      C("listSkills", "user", P),
      C("listSkills", "project", P),
      C("writeSkill", "user", P, "alpha", SKILL_MD("Alpha", "first one", "Alpha body")),
      C("writeSkill", "project", P, "beta", "no front matter\n"),
      C("writeSkill", "user", P, "broken", "---\nname: [unclosed\n---\nbody\n"),
      C("writeSkill", "user", P, `caf${U(0xe9)}`, "---\ndescription: unicode\n---\n"),
      C("writeSkill", "user", P, U(0x4e2d, 0x6587), `${U(0xfeff)}---\nname: bom\n---\nx`),
      C("writeSkill", "user", P, "crlf", "---\r\nname: crlf\r\n---\r\nbody\r\n"),
      C("writeSkill", "user", P, "empty", ""),
      C("writeSkill", "user", P, "lone", `a${lone(0xd800)}b`),
      C("writeSkill", "project", WSC, "gamma", "gamma\n"),
      C("writeSkill", "project", UNIC, `${U(0xe9)}t${U(0xe9)}`, `unicode ${U(0x1f600)}\n`),
      C("listSkills", "user", P),
      C("listSkills", "project", P),
      C("listSkills", "project", WSC),
      C("listSkills", "project", UNIC),
      C("readSkill", "user", P, "alpha"),
      C("readSkill", "project", P, "alpha"),
      C("readSkill", "user", P, "../alpha"),
      C("readSkill", "user", P, ".alpha"),
      C("readSkill", "user", P, ""),
      C("readSkill", "user", P, `caf${U(0xe9)}`),
      C("writeSkill", "user", P, "alpha", "rewritten\n"),
      C("readSkill", "user", P, "alpha"),
      ...ODD_NAMES.map((n) => C("writeSkill", "user", P, n, "odd\n")),
      C("writeSkill", "user", P, `deploy${U(0x3164)}`, "x"),
      C("writeSkill", "user", P, `a${U(0xfe0f)}`, "x"),
      C("writeSkill", "user", P, `${U(0x301)}a`, "x"),
      C("writeSkill", "user", P, `a${U(0x301).repeat(9)}`, "x"),
      C("writeSkill", "user", P, `cafe${U(0x301)}`, "nfd\n"),
      S(MK(`${SK}/deploy${U(0x3164)}`)),
      C("writeSkill", "user", P, `deploy${U(0x3164)}`, "now it exists\n"),
      S(W(`${SK}/${U(0x301)}a/SKILL.md`, "mark first\n")),
      C("listSkills", "user", P),
      C("readSkill", "user", P, `deploy${U(0x3164)}`),
      C("deleteSkill", "user", P, `deploy${U(0x3164)}`),
      C("deleteSkill", "user", P, "alpha"),
      C("deleteSkill", "user", P, "alpha"),
      C("deleteSkill", "user", P, "."),
      C("deleteSkill", "user", P, ".."),
      C("deleteSkill", "user", P, "a/b"),
      C("deleteSkill", "user", P, ""),
      C("deleteSkill", "project", P, "beta"),
      C("deleteSkill", "project", P, "beta"),
      C("listSkills", "project", P),
    ],
  },
  {
    name: "skills listing order and odd entries",
    steps: [
      S(
        ...[
          "beta",
          "Alpha",
          "alpha2",
          "_x",
          "-x",
          "10",
          "9",
          "x.y",
          "x-y",
          "x_y",
          `${U(0xe9)}t`,
          "et",
          "Ez",
          "zeta",
          U(0x4e2d),
          U(0x3b1),
          "a1",
          "a10",
          "a2",
          U(0x5d0),
          "Zulu",
          `deploy${U(0x3164)}`,
        ].map((n) => W(`${SK}/${n}/SKILL.md`, SKILL_MD(n, `the ${n} skill`, "body"))),
        W(`${SK}/.hidden/SKILL.md`, "hidden\n"),
        W(`${SK}/a b/SKILL.md`, "spaced\n"),
        W(`${SK}/loose.md`, "a file\n"),
        MK(`${SK}/noskill`),
        MK(`${SK}/isdir/SKILL.md`),
        WB(`${SK}/badutf8/SKILL.md`, BAD_UTF8),
        LN(`${SK}/linked`, "$ROOT/outside"),
        LN(`${SK}/linkfile/SKILL.md`, "$ROOT/outside/SKILL.md"),
        LN(`${SK}/dangling/SKILL.md`, "$ROOT/nowhere/SKILL.md"),
        W(`${SK}/lower/skill.md`, "lower-case name\n"),
      ),
      C("listSkills", "user", P),
      C("readSkill", "user", P, "linked"),
      C("readSkill", "user", P, "linkfile"),
      C("readSkill", "user", P, "dangling"),
      C("readSkill", "user", P, "noskill"),
      C("readSkill", "user", P, "isdir"),
      C("readSkill", "user", P, "badutf8"),
      C("readSkill", "user", P, "loose.md"),
      C("writeSkill", "user", P, "linked", "written through the link\n"),
      C("writeSkill", "user", P, "dangling", "written through the dangling link\n"),
      C("writeSkill", "user", P, "loose.md", "x"),
      C("writeSkill", "user", P, "isdir", "x"),
      C("deleteSkill", "user", P, "linked"),
      C("deleteSkill", "user", P, "linkfile"),
      C("deleteSkill", "user", P, "isdir"),
      C("deleteSkill", "user", P, "loose.md"),
      C("deleteSkill", "user", P, "dangling"),
      C("listSkills", "user", P),
      S(RM(SK), LN(SK, "$ROOT/outside")),
      C("listSkills", "user", P),
      C("writeSkill", "user", P, "via-link", "x"),
      S(RM(SK), W(SK, "skills is a file\n")),
      C("listSkills", "user", P),
      C("readSkill", "user", P, "a"),
      C("writeSkill", "user", P, "a", "x"),
      C("writeSkill", "user", P, `deploy${U(0x3164)}`, "x"),
      C("deleteSkill", "user", P, "a"),
      S(RM(SK), LN(SK, "$ROOT/nowhere")),
      C("listSkills", "user", P),
      C("writeSkill", "user", P, "a", "x"),
      C("listSkills", "project", DOT),
      C("writeSkill", "project", DOT, "a", "x"),
      C("deleteSkill", "project", DOT, "a"),
      C("listSkills", "project", NULC),
      C("readSkill", "project", NULC, "a"),
      C("writeSkill", "project", NULC, "a", "x"),
      C("deleteSkill", "project", NULC, "a"),
    ],
  },
  {
    name: "skills cyclic front matter",
    steps: [
      S(W(`${SK}/cyclic/SKILL.md`, CYCLIC), W(`${PSK}/fine/SKILL.md`, SKILL_MD("fine", "ok", "x"))),
      C("listSkills", "user", P),
      C("readSkill", "user", P, "cyclic"),
      C("listSkills", "project", P),
    ],
  },
  {
    name: "skills permissions",
    needs: ["perm"],
    steps: [
      S(W(`${SK}/a/SKILL.md`, "a\n"), W(`${SK}/b/SKILL.md`, "b\n"), CH(`${SK}/b`, 0o000)),
      C("listSkills", "user", P),
      C("readSkill", "user", P, "b"),
      C("writeSkill", "user", P, "b", "x"),
      C("deleteSkill", "user", P, "b"),
      S(CH(`${SK}/b`, 0o755), CH(SK, 0o555)),
      C("deleteSkill", "user", P, "a"),
      C("writeSkill", "user", P, "c", "x"),
      C("writeSkill", "user", P, "a", "still writable\n"),
      S(CH(SK, 0o000)),
      C("listSkills", "user", P),
      C("readSkill", "user", P, "a"),
      C("writeSkill", "user", P, `deploy${U(0x3164)}`, "x"),
      C("deleteSkill", "user", P, "a"),
      S(CH(SK, 0o755), CH(`${SK}/a/SKILL.md`, 0o000)),
      C("listSkills", "user", P),
      C("readSkill", "user", P, "a"),
      C("writeSkill", "user", P, "a", "x"),
      S(CH(`${SK}/a/SKILL.md`, 0o644)),
    ],
  },
  {
    name: "hooks",
    steps: [
      C("listAll", P),
      C("addGroup", "user", P, "PreToolUse", GROUP("echo user", "Bash")),
      C("addGroup", "user", P, "PreToolUse", GROUP("echo second")),
      C("addGroup", "user", P, "Stop", { hooks: [{ type: "command", command: "echo stop", timeout: 1e400 }], extra: { "10": 1, "2": 2, b: 3 } }),
      C("addGroup", "project", P, "SessionStart", GROUP(`echo ${U(0x1f600)}`)),
      C("addGroup", "local", P, "Notification", GROUP("say hi")),
      C("addGroup", "project", WSC, "PostToolUse", GROUP("ws")),
      C("listAll", P),
      C("listAll", WSC),
      C("removeGroup", "user", P, "PreToolUse", 5),
      C("removeGroup", "user", P, "PreToolUse", -1),
      C("removeGroup", "user", P, "PreToolUse", Infinity),
      C("removeGroup", "user", P, "PreToolUse", -0.5),
      C("removeGroup", "user", P, "PreToolUse", 0.5),
      C("removeGroup", "user", P, "PreToolUse", 0),
      C("removeGroup", "user", P, "PreToolUse", 0),
      C("removeGroup", "user", P, "Stop", -0),
      C("removeGroup", "local", P, "Notification", 0),
      C("setDisableAllHooks", "user", P, true),
      C("setDisableAllHooks", "user", P, true),
      C("setDisableAllHooks", "project", P, false),
      C("setDisableAllHooks", "user", P, false),
      C("listAll", P),
      S(W("home/.claude/settings.json", '{"a":1,"hooks":{"Stop":[{"hooks":[]}]},"disableAllHooks":"yes","z":2,"__proto__":{"x":1}}\n')),
      C("listAll", P),
      C("addGroup", "user", P, "Stop", GROUP("kept in place")),
      C("setDisableAllHooks", "user", P, false),
      C("setDisableAllHooks", "user", P, true),
      S(W("home/.claude/settings.json", '{"hooks":[1,2],"disableAllHooks":0}\n')),
      C("listAll", P),
      C("addGroup", "user", P, "Stop", GROUP("array hooks")),
      S(W("home/.claude/settings.json", '{"hooks":{"PreToolUse":"ab","Stop":5,"Setup":{},"Elicitation":null,"Notification":true}}\n')),
      C("listAll", P),
      C("addGroup", "user", P, "PreToolUse", GROUP("x")),
      C("removeGroup", "user", P, "PreToolUse", 0),
      C("removeGroup", "user", P, "PreToolUse", 2),
      C("addGroup", "user", P, "Stop", GROUP("x")),
      C("removeGroup", "user", P, "Stop", 0),
      C("addGroup", "user", P, "Setup", GROUP("x")),
      C("addGroup", "user", P, "Notification", GROUP("x")),
      C("addGroup", "user", P, "Elicitation", GROUP("x")),
      S(W("home/.claude/settings.json", '{"hooks":"nope"}\n')),
      C("listAll", P),
      C("addGroup", "user", P, "Stop", GROUP("x")),
      S(W("home/.claude/settings.json", "null\n")),
      C("listAll", P),
      C("addGroup", "user", P, "Stop", GROUP("x")),
      C("removeGroup", "user", P, "Stop", 0),
      C("setDisableAllHooks", "user", P, true),
      S(W("home/.claude/settings.json", "[1,2]\n")),
      C("listAll", P),
      C("addGroup", "user", P, "Stop", GROUP("x")),
      S(W("home/.claude/settings.json", '"ab"\n')),
      C("addGroup", "user", P, "Stop", GROUP("x")),
      S(W("home/.claude/settings.json", "5\n")),
      C("setDisableAllHooks", "user", P, true),
      S(W("home/.claude/settings.json", "{\n")),
      C("listAll", P),
      C("addGroup", "user", P, "Stop", GROUP("x")),
      C("removeGroup", "user", P, "Stop", 0),
      C("setDisableAllHooks", "user", P, true),
      S(W("home/.claude/settings.json", `${U(0xfeff)}{}\n`)),
      C("listAll", P),
      S(RM("home/.claude/settings.json"), MK("home/.claude/settings.json")),
      C("listAll", P),
      C("addGroup", "user", P, "Stop", GROUP("x")),
      S(RM("home/.claude/settings.json"), W("outside/settings.json", '{"theme":"dark"}\n'), LN("home/.claude/settings.json", "$ROOT/outside/settings.json")),
      C("addGroup", "user", P, "Stop", GROUP("through the link")),
      C("listAll", DOT),
      C("addGroup", "project", DOT, "Stop", GROUP("x")),
      C("addGroup", "user", DOT, "Stop", GROUP("user with dotfile cwd")),
      C("listAll", NULC),
      C("addGroup", "project", NULC, "Stop", GROUP("x")),
      C("setDisableAllHooks", "local", NULC, true),
    ],
  },
  {
    name: "hooks permissions",
    needs: ["perm"],
    steps: [
      S(W("home/.claude/settings.json", "{}\n"), CH("home/.claude/settings.json", 0o600)),
      C("addGroup", "user", P, "Stop", GROUP("mode kept")),
      S(CH("home/.claude/settings.json", 0o000)),
      C("listAll", P),
      C("setDisableAllHooks", "user", P, true),
      S(CH("home/.claude/settings.json", 0o644), CH("home/.claude", 0o555)),
      C("addGroup", "user", P, "Stop", GROUP("x")),
      S(CH("home/.claude", 0o755)),
    ],
  },
  {
    name: "keybindings",
    steps: [
      C("readKeybindings"),
      C("writeKeybindings", { bindings: [{ key: "ctrl+k", command: "palette" }], extra: { "10": 1, "2": 2, b: 3, a: 4 } }),
      C("readKeybindings"),
      C("writeKeybindings", []),
      C("readKeybindings"),
      C("writeKeybindings", { s: `a${lone(0xd800)}b`, inf: Infinity, u: U(0x1f600) }),
      C("readKeybindings"),
      S(W("home/.claude/keybindings.json", `{"s":"${BS}ud800","n":1e400,"e":"${BS}u00e9","nested":{"__proto__":1}}`)),
      C("readKeybindings"),
      S(W("home/.claude/keybindings.json", "null")),
      C("readKeybindings"),
      S(W("home/.claude/keybindings.json", "{")),
      C("readKeybindings"),
      S(W("home/.claude/keybindings.json", `${U(0xfeff)}{}`)),
      C("readKeybindings"),
      S(W("home/.claude/keybindings.json", "")),
      C("readKeybindings"),
      S(WB("home/.claude/keybindings.json", [0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d])),
      C("readKeybindings"),
      S(RM("home/.claude/keybindings.json"), MK("home/.claude/keybindings.json")),
      C("readKeybindings"),
      C("writeKeybindings", {}),
      S(RM("home/.claude/keybindings.json"), LN("home/.claude/keybindings.json", "$ROOT/outside/kb.json")),
      C("readKeybindings"),
      C("writeKeybindings", { through: "the link" }),
      C("readKeybindings"),
      S(RM("home/.claude")),
      C("readKeybindings"),
      C("writeKeybindings", { fresh: true }),
      S(RM("home/.claude"), W("home/.claude", "a file\n")),
      C("readKeybindings"),
      C("writeKeybindings", { x: 1 }),
      S(RM("home/.claude"), MK("home/.claude/.claudius")),
    ],
  },
  {
    name: "claudemd scopes",
    steps: [
      C("readAllScopes", P),
      C("pathFor", "user", P),
      C("pathFor", "project", P),
      C("pathFor", "project-claude", P),
      C("pathFor", "local", P),
      C("pathFor", "project", NULC),
      C("pathFor", "project", ""),
      C("writeScope", "user", P, "# user\n"),
      C("writeScope", "project", P, "# project\n"),
      C("writeScope", "project-claude", P, "# project claude\n"),
      C("writeScope", "local", P, "# local\n"),
      C("writeScope", "project", WSC, `ws ${U(0x1f600)}`),
      C("writeScope", "local", UNIC, ""),
      C("writeScope", "user", P, `lone ${lone(0xdc00)}\n`),
      C("readAllScopes", P),
      C("readAllScopes", WSC),
      C("readAllScopes", UNIC),
      C("readScope", "project", P),
      S(RM("project/CLAUDE.md"), W("project/AGENTS.md", "# agents\n")),
      C("readScope", "project", P),
      C("writeScope", "project", P, "# agents rewritten\n"),
      S(W("project/CLAUDE.md", "# claude again\n")),
      C("readScope", "project", P),
      C("writeScope", "project", P, "# claude rewritten\n"),
      S(RM("project/CLAUDE.md"), LN("project/CLAUDE.md", "$ROOT/nowhere/CLAUDE.md")),
      C("readScope", "project", P),
      C("writeScope", "project", P, "# dangling claude, agents present\n"),
      S(RM("project/AGENTS.md")),
      C("readScope", "project", P),
      C("writeScope", "project", P, "# through the dangling link\n"),
      S(RM("project/CLAUDE.md"), RM("outside/CLAUDE.md"), MK("project/CLAUDE.md")),
      C("readScope", "project", P),
      C("readAllScopes", P),
      C("writeScope", "project", P, "x"),
      S(RM("project/CLAUDE.md"), MK("project/AGENTS.md")),
      C("readScope", "project", P),
      C("writeScope", "project", P, "# claude beside an AGENTS.md folder\n"),
      S(RM("project/CLAUDE.md"), RM("project/AGENTS.md"), LN("project/CLAUDE.md", "$ROOT/outside/secret.md")),
      C("readScope", "project", P),
      C("writeScope", "project", P, "# through the link\n"),
      S(W("ws/CLAUDE.local.md", "x"), LN("ws/AGENTS.md", "$ROOT/outside/secret.md")),
      C("readScope", "local", WSC),
      C("readScope", "project", WSC),
      C("readAllScopes", DOT),
      C("readScope", "project-claude", DOT),
      C("writeScope", "project-claude", DOT, "x"),
      C("writeScope", "project", DOT, "# dotfile project\n"),
      C("readAllScopes", NULC),
      C("readScope", "user", NULC),
      C("readScope", "project", NULC),
      C("writeScope", "project", NULC, "x"),
      C("writeScope", "local", NULC, "x"),
      S(WB("project/CLAUDE.local.md", BAD_UTF8)),
      C("readScope", "local", P),
      S(RM("home/.claude/CLAUDE.md"), MK("home/.claude/CLAUDE.md")),
      C("readAllScopes", NULC),
      C("resolveHierarchy", NULC),
      C("readAllScopes", P),
    ],
  },
  {
    name: "claudemd imports",
    steps: [
      S(
        W("home/.claude/CLAUDE.md", "# user\n@inc/a.md\nafter a\n  @inc/b.md  \n@missing.md\n@~/x.md\n@inc\ntext @inc/a.md\n@\n@inc/a.md extra\n\t@inc/c.md\r\n@$ROOT/outside/secret.md\n@../../outside/secret.md\n"),
        W("home/.claude/inc/a.md", "a line\n@b.md\na end"),
        W("home/.claude/inc/b.md", `b ${U(0x1f600)}\n@a.md\n`),
        W("home/.claude/inc/c.md", "c\n@c.md\n"),
        W("project/CLAUDE.md", "@d1.md\n"),
        ...[1, 2, 3, 4, 5, 6, 7].map((i) => W(`project/d${i}.md`, `depth ${i}\n@d${i + 1}.md\n`)),
        W("project/d8.md", "depth 8\n"),
        W("project/.claude/CLAUDE.md", "@../CLAUDE.local.md\n@sib.md\n@sib.md\n"),
        W("project/.claude/sib.md", "sibling\n"),
        WB("project/CLAUDE.local.md", BAD_UTF8),
        W("project/self.md", "@self.md\n"),
        W("project/nul.md", `@a${U(0)}b\n`),
      ),
      C("resolveHierarchy", P),
      C("resolveContent", "@self.md\n", P),
      C("resolveContent", "@nul.md", P),
      C("resolveContent", "", P),
      C("resolveContent", "\n", P),
      C("resolveContent", `${U(0xfeff)}@d7.md${U(0xa0)}\n${U(0x2028)}@d8.md`, P),
      C("resolveContent", "@d1.md\n@d1.md", P),
      C("resolveContent", "@/", P),
      C("resolveContent", "@.", "$ROOT/project/sub"),
      C("resolveContent", "@d8.md", "relative/base"),
      C("resolveHierarchy", WSC),
      C("resolveHierarchy", NULC),
      C("resolveHierarchy", DOT),
    ],
  },
  {
    name: "claudemd permissions",
    needs: ["perm"],
    steps: [
      S(W("project/CLAUDE.md", "x"), CH("project/CLAUDE.md", 0o000), W("home/.claude/CLAUDE.md", "@inc.md\n"), W("home/.claude/inc.md", "inc"), CH("home/.claude/inc.md", 0o000)),
      C("readScope", "project", P),
      C("readAllScopes", P),
      C("resolveHierarchy", P),
      C("writeScope", "project", P, "y"),
      S(CH("project/CLAUDE.md", 0o644), CH("home/.claude/inc.md", 0o644), MK("project/.claude"), CH("project/.claude", 0o555)),
      C("writeScope", "project-claude", P, "x"),
      C("readScope", "project-claude", P),
      S(CH("project/.claude", 0o000)),
      C("readScope", "project-claude", P),
      C("writeScope", "project-claude", P, "x"),
      S(CH("project/.claude", 0o755), CH("project", 0o555)),
      C("writeScope", "local", P, "x"),
      C("writeScope", "project", P, "z"),
      S(CH("project", 0o755)),
    ],
  },
];

async function runScenario(sc) {
  buildWorld();
  const steps = [];
  for (const step of sc.steps) {
    if (step.setup) {
      steps.push({ setup: step.setup.map(apply) });
      continue;
    }
    const before = snapshot();
    const args = JSON.parse(toAbs(step.args));
    let rec;
    try {
      rec = { result: resultText(await MOD[step.call](...args)) };
    } catch (e) {
      rec = { threw: threwOf(e) };
    }
    steps.push({ call: step.call, args: step.args, ...rec, changes: changes(before, snapshot()) });
  }
  return { name: sc.name, needs: sc.needs ?? [], steps, final: snapshot() };
}

const modules = [];
for (const sc of MODULES) {
  if ((sc.needs ?? []).includes("perm") && !PERM) {
    modules.push({ name: sc.name, needs: sc.needs, skipped: true });
    continue;
  }
  modules.push(await runScenario(sc));
}

// --------------------------------- routes ---------------------------------

async function request(req) {
  if (!/^[\x21-\x7e]+$/.test(req.url) || req.url.includes("#")) throw new Error(`url must be plain ASCII: ${req.url}`);
  const url = toAbs(req.url);
  const init = { method: req.method };
  if (req.body !== undefined) init.body = toAbs(req.body);
  const r = new Request(`http://localhost${url}`, init);
  const path = url.split("?")[0];
  let mod;
  let ctx;
  if (path === "/api/skills") mod = R.skills;
  else if (path.startsWith("/api/skills/")) {
    mod = R.skill;
    ctx = { params: Promise.resolve({ name: decodeURIComponent(path.slice("/api/skills/".length)) }) };
  } else if (path === "/api/hooks") mod = R.hooks;
  else if (path === "/api/hooks/disabled") mod = R.hooksDisabled;
  else if (path === "/api/keybindings") mod = R.keybindings;
  else if (path === "/api/claudemd") mod = R.claudemd;
  else throw new Error(`no route for ${path}`);
  try {
    const res = await mod[req.method](r, ctx);
    return { status: res.status, type: res.headers.get("content-type"), body: toRel(await res.text()) };
  } catch (e) {
    return { threw: toRel(e instanceof Error ? `${e.name}: ${e.message}` : String(e)) };
  }
}

async function runGroup(group) {
  buildWorld();
  const steps = [];
  for (const step of group.steps) {
    if (step.setup) {
      steps.push({ setup: step.setup.map(apply) });
      continue;
    }
    const before = snapshot();
    const got = await request(step);
    steps.push({
      request: { method: step.method, url: step.url, ...(step.body !== undefined ? { body: step.body } : {}) },
      got,
      changes: changes(before, snapshot()),
    });
  }
  return { name: group.name, needs: group.needs ?? [], steps, final: snapshot() };
}

const Q = (query) => (query === undefined ? "" : `?${query}`);
const bodyOf = (body) => (body === undefined ? {} : { body: typeof body === "string" ? body : J(body) });
const REQ = (path) => (method, query, body) => ({ method, url: `${path}${Q(query)}`, ...bodyOf(body) });
const SKR = REQ("/api/skills");
const SKD = (name, query) => ({ method: "DELETE", url: `/api/skills/${name}${Q(query)}` });
const HK = REQ("/api/hooks");
const HKD = REQ("/api/hooks/disabled");
const KB = REQ("/api/keybindings");
const CM = REQ("/api/claudemd");
const enc = encodeURIComponent;
const CWD = (c) => `cwd=${enc(c).replaceAll("%24ROOT", "$ROOT")}`;
const UNTRUSTED = "$ROOT/untrusted";

/** A PUT /api/skills body with `name` spliced in as raw JSON text. */
const SKPUT = (nameJson, extra = "") => `{"scope":"user","name":${nameJson},"raw":"odd"${extra}}`;

const ROUTES = [
  {
    name: "skills validation",
    steps: [
      SKR("GET"),
      SKR("GET", CWD(UNTRUSTED)),
      SKR("GET", CWD(WSC)),
      SKR("GET", CWD(UNIC)),
      SKR("GET", "cwd=%20"),
      SKR("GET", `cwd=${enc(U(0xfeff))}`),
      SKR("GET", `${CWD(P)}/`),
      SKR("GET", "scope=bogus&name=a"),
      SKR("GET", "scope=user&name=missing"),
      SKR("GET", "scope=user&name=..%2Fx"),
      SKR("GET", "scope=user&name=.x"),
      SKR("GET", "scope=user&name="),
      SKR("GET", "scope=&name=a"),
      SKR("GET", "scope=user"),
      SKR("GET", "name=a"),
      SKR("GET", `scope=bogus&name=a&${CWD(UNTRUSTED)}`),
      SKR("PUT"),
      SKR("PUT", undefined, ""),
      SKR("PUT", undefined, "{"),
      SKR("PUT", undefined, "null"),
      SKR("PUT", undefined, "[]"),
      SKR("PUT", undefined, '"x"'),
      SKR("PUT", undefined, "5"),
      SKR("PUT", undefined, {}),
      SKR("PUT", undefined, { scope: "bogus" }),
      SKR("PUT", undefined, { scope: 1 }),
      SKR("PUT", undefined, { scope: "user" }),
      SKR("PUT", undefined, { scope: "user", name: "" }),
      SKR("PUT", undefined, { scope: "user", name: 0 }),
      SKR("PUT", undefined, { scope: "user", name: false }),
      SKR("PUT", undefined, { scope: "user", name: null }),
      SKR("PUT", undefined, { scope: "user", name: "a" }),
      SKR("PUT", undefined, { scope: "user", name: "a", raw: 5 }),
      SKR("PUT", undefined, { scope: "user", name: "a", raw: null }),
      SKR("PUT", undefined, { scope: "user", name: "a", raw: ["x"] }),
      SKR("PUT", undefined, { scope: "user", name: "../a", raw: "x", cwd: UNTRUSTED }),
      SKR("PUT", undefined, { scope: "user", name: "a", raw: "x", cwd: UNTRUSTED }),
      SKR("PUT", undefined, '{"scope":"user","name":"a","raw":1e400}'),
      ...[
        "5",
        "true",
        '["ab"]',
        "[]",
        "{}",
        '{"toString":"x"}',
        '{"valueOf":"x"}',
        "1e400",
        "-1e400",
        "1.5",
        "-0",
        "1e21",
        "123456789012345680000",
        "[null]",
        '[["x"]]',
        "[1e400]",
        "[1,2]",
        '[{"toString":1}]',
        '"a/b"',
        '".."',
        '".x"',
        '"a b"',
        '"a:b"',
        J(`deploy${U(0x3164)}`),
        J(`a${U(0xfe0f)}`),
        J(`${U(0x301)}a`),
        J(`a${U(0x200d)}b`),
        J(`a${U(0x301).repeat(9)}`),
        `"x${BS}ud800"`,
      ].map((n) => SKR("PUT", undefined, SKPUT(n))),
      SKR("PUT", undefined, SKPUT('"odd-cwd"', ',"cwd":5')),
      SKR("PUT", undefined, SKPUT('"inf-cwd"', ',"cwd":1e400')),
      SKR("PUT", undefined, { scope: "user", name: "alpha", raw: SKILL_MD("Alpha", "first", "Alpha body") }),
      SKR("PUT", undefined, { scope: "project", name: "beta", raw: "beta\n" }),
      SKR("PUT", undefined, { scope: "project", cwd: WSC, name: "gamma", raw: "g" }),
      SKR("PUT", undefined, { scope: "project", cwd: UNIC, name: `${U(0xe9)}t${U(0xe9)}`, raw: `unicode ${U(0x1f600)}` }),
      SKR("PUT", undefined, `{"scope":"user","name":"lone","raw":"a${BS}ud800b${BS}udc00"}`),
      SKR("PUT", undefined, { scope: "user", name: "bom", raw: `${U(0xfeff)}---\nname: bom\n---\n` }),
      SKR("PUT", undefined, `${U(0xfeff)}{"scope":"user","name":"bodybom","raw":"x"}`),
      SKR("PUT", undefined, { scope: "user", name: "cycle", raw: CYCLIC }),
      SKR("GET", "scope=user&name=cycle"),
      SKR("GET"),
      SKR("PUT", undefined, { scope: "user", name: "cycle", raw: "fixed\n" }),
      SKR("GET"),
      SKR("GET", "scope=user&name=alpha"),
      SKR("GET", "scope=project&name=beta"),
      SKR("GET", `${CWD(WSC)}&scope=project&name=gamma`),
      SKR("GET", `${CWD(UNIC)}&scope=project&name=${enc(`${U(0xe9)}t${U(0xe9)}`)}`),
      SKR("GET", "scope=user&name=lone"),
      SKD("alpha", "scope=user"),
      SKD("alpha", "scope=user"),
      SKD("alpha"),
      SKD("alpha", "scope="),
      SKD("alpha", "scope=bogus"),
      SKD("alpha", `scope=user&${CWD(UNTRUSTED)}`),
      SKD("alpha", `scope=bogus&${CWD(UNTRUSTED)}`),
      SKD("%2E%2E", "scope=user"),
      SKD("%2E", "scope=user"),
      SKD("a%2Fb", "scope=user"),
      SKD("a%20b", "scope=user"),
      SKD(enc(`deploy${U(0x3164)}`), "scope=user"),
      SKD(enc(`${U(0xe9)}t${U(0xe9)}`), `scope=project&${CWD(UNIC)}`),
      SKD("gamma", `scope=project&${CWD(WSC)}`),
      SKD("beta", "scope=project"),
      SKR("GET"),
    ],
  },
  {
    name: "skills on disk",
    steps: [
      S(
        ...["beta", "Alpha", "_x", "10", "9", `${U(0xe9)}t`, "et", U(0x4e2d), `deploy${U(0x3164)}`].map((n) =>
          W(`${SK}/${n}/SKILL.md`, SKILL_MD(n, `the ${n} skill`, "body")),
        ),
        W(`${SK}/.hidden/SKILL.md`, "hidden\n"),
        MK(`${SK}/noskill`),
        MK(`${SK}/isdir/SKILL.md`),
        WB(`${SK}/badutf8/SKILL.md`, BAD_UTF8),
        LN(`${SK}/linked`, "$ROOT/outside"),
        LN(`${SK}/linkfile/SKILL.md`, "$ROOT/outside/SKILL.md"),
        LN(`${SK}/dangling/SKILL.md`, "$ROOT/nowhere/SKILL.md"),
        W(`${PSK}/proj/SKILL.md`, SKILL_MD("proj", "project skill", "p")),
      ),
      SKR("GET"),
      SKR("GET", "scope=user&name=linked"),
      SKR("GET", "scope=user&name=dangling"),
      SKR("GET", "scope=user&name=isdir"),
      SKR("GET", "scope=user&name=badutf8"),
      SKR("GET", `scope=user&name=${enc(`deploy${U(0x3164)}`)}`),
      SKR("PUT", undefined, { scope: "user", name: "linked", raw: "through the link\n" }),
      SKR("PUT", undefined, { scope: "user", name: "dangling", raw: "through the dangling link\n" }),
      SKR("PUT", undefined, { scope: "user", name: "isdir", raw: "x" }),
      SKR("PUT", undefined, { scope: "user", name: `deploy${U(0x3164)}`, raw: "exists, so allowed\n" }),
      SKD("linked", "scope=user"),
      SKD("linkfile", "scope=user"),
      SKD("isdir", "scope=user"),
      SKR("GET"),
      S(RM(SK), W(SK, "skills is a file\n")),
      SKR("GET"),
      SKR("GET", "scope=user&name=a"),
      SKR("PUT", undefined, { scope: "user", name: "a", raw: "x" }),
      SKR("PUT", undefined, { scope: "user", name: `deploy${U(0x3164)}`, raw: "x" }),
      SKD("a", "scope=user"),
      S(RM(SK)),
      SKR("GET", CWD(DOT)),
      SKR("PUT", undefined, { scope: "project", cwd: DOT, name: "a", raw: "x" }),
      SKD("a", `scope=project&${CWD(DOT)}`),
      SKR("GET", CWD(NULC)),
      SKR("GET", `${CWD(NULC)}&scope=project&name=a`),
      SKR("GET", `${CWD(NULC)}&scope=user&name=beta`),
      SKR("PUT", undefined, { scope: "project", cwd: NULC, name: "a", raw: "x" }),
      SKR("PUT", undefined, { scope: "user", cwd: NULC, name: "from-nul", raw: "x" }),
      SKD("a", `scope=project&${CWD(NULC)}`),
      SKD("from-nul", `scope=user&${CWD(NULC)}`),
      // Both scopes fail: under Promise.all the NUL refusal (thrown before
      // any read) wins over the user scope's ENOTDIR.
      S(RM(SK), W(SK, "skills is a file again\n")),
      SKR("GET", CWD(NULC)),
    ],
  },
  {
    name: "skills permissions",
    needs: ["perm"],
    steps: [
      S(W(`${SK}/a/SKILL.md`, "a\n"), W(`${SK}/b/SKILL.md`, "b\n"), CH(`${SK}/b`, 0o000)),
      SKR("GET"),
      SKR("GET", "scope=user&name=b"),
      SKR("PUT", undefined, { scope: "user", name: "b", raw: "x" }),
      SKD("b", "scope=user"),
      S(CH(`${SK}/b`, 0o755), CH(SK, 0o555)),
      SKD("a", "scope=user"),
      SKR("PUT", undefined, { scope: "user", name: "c", raw: "x" }),
      S(CH(SK, 0o000)),
      SKR("GET"),
      SKR("PUT", undefined, { scope: "user", name: `deploy${U(0x3164)}`, raw: "x" }),
      SKD("a", "scope=user"),
      S(CH(SK, 0o755)),
    ],
  },
  {
    name: "hooks",
    steps: [
      HK("GET"),
      HK("GET", CWD(UNTRUSTED)),
      HK("GET", CWD(WSC)),
      HK("POST"),
      HK("POST", undefined, "{"),
      HK("POST", undefined, "null"),
      HK("POST", undefined, "[]"),
      HK("POST", undefined, { scope: "bogus" }),
      HK("POST", undefined, { scope: "user" }),
      HK("POST", undefined, { scope: "user", event: "Bogus" }),
      HK("POST", undefined, { scope: "user", event: "toString" }),
      HK("POST", undefined, { scope: "user", event: "Stop" }),
      HK("POST", undefined, { scope: "user", event: "Stop", group: null }),
      HK("POST", undefined, { scope: "user", event: "Stop", group: "x" }),
      HK("POST", undefined, { scope: "user", event: "Stop", group: [] }),
      HK("POST", undefined, { scope: "user", event: "Stop", group: {} }),
      HK("POST", undefined, { scope: "user", event: "Stop", group: { hooks: [] } }),
      HK("POST", undefined, { scope: "user", event: "Stop", group: { hooks: 5 } }),
      HK("POST", undefined, '{"scope":"user","event":"Stop","group":{"hooks":1e400}}'),
      HK("POST", undefined, { scope: "user", event: "Stop", group: { hooks: "" } }),
      HK("POST", undefined, { scope: "user", event: "Stop", group: { hooks: { length: 0 } } }),
      HK("POST", undefined, { scope: "user", event: "Stop", group: { hooks: {} } }),
      HK("POST", undefined, { scope: "user", event: "Stop", group: { hooks: [{ type: "command", command: "x" }] }, cwd: UNTRUSTED }),
      HK("POST", undefined, { scope: "bogus", event: "Bogus", cwd: UNTRUSTED }),
      HK("POST", undefined, { scope: "user", event: "PreToolUse", group: GROUP("echo user", "Bash") }),
      HK("POST", undefined, { scope: "user", event: "PreToolUse", group: GROUP("echo second") }),
      HK("POST", undefined, { scope: "user", event: "Stop", group: { hooks: "str" } }),
      HK("POST", undefined, { scope: "user", event: "Stop", group: { hooks: { length: 1 } } }),
      HK("POST", undefined, '{"scope":"user","event":"Stop","group":{"hooks":[{"type":"command","command":"inf","timeout":1e400}],"n":{"length":1e400}}}'),
      HK("POST", undefined, { scope: "project", event: "SessionStart", group: GROUP(`echo ${U(0x1f600)}`) }),
      HK("POST", undefined, { scope: "local", event: "Notification", group: GROUP("say hi"), cwd: P }),
      HK("POST", undefined, { scope: "project", event: "PostToolUse", group: GROUP("ws"), cwd: WSC }),
      HK("POST", undefined, { scope: "project", event: "MessageDisplay", group: GROUP("uni"), cwd: UNIC }),
      HK("POST", undefined, { scope: "user", event: "DirectoryAdded", group: GROUP("cwd 5"), cwd: 5 }),
      HK("GET"),
      HK("GET", CWD(WSC)),
      HK("GET", CWD(UNIC)),
      HK("DELETE"),
      HK("DELETE", undefined, "null"),
      HK("DELETE", undefined, { scope: "user" }),
      HK("DELETE", undefined, { scope: "user", event: "Bogus" }),
      HK("DELETE", undefined, { scope: "user", event: "PreToolUse" }),
      HK("DELETE", undefined, { scope: "user", event: "PreToolUse", index: "0" }),
      HK("DELETE", undefined, { scope: "user", event: "PreToolUse", index: null }),
      HK("DELETE", undefined, { scope: "user", event: "PreToolUse", index: 0, cwd: UNTRUSTED }),
      HK("DELETE", undefined, { scope: "user", event: "PreToolUse", index: 5 }),
      HK("DELETE", undefined, { scope: "user", event: "PreToolUse", index: -1 }),
      HK("DELETE", undefined, '{"scope":"user","event":"PreToolUse","index":1e400}'),
      HK("DELETE", undefined, '{"scope":"user","event":"PreToolUse","index":-1e400}'),
      HK("DELETE", undefined, { scope: "user", event: "PreToolUse", index: -0.5 }),
      HK("DELETE", undefined, { scope: "user", event: "PreToolUse", index: 1.5 }),
      HK("DELETE", undefined, { scope: "user", event: "PreToolUse", index: 0.5 }),
      HK("DELETE", undefined, { scope: "user", event: "PreToolUse", index: 0 }),
      HK("DELETE", undefined, { scope: "user", event: "PreToolUse", index: 0 }),
      HK("DELETE", undefined, '{"scope":"user","event":"Stop","index":-0}'),
      HK("DELETE", undefined, { scope: "local", event: "Notification", index: 0 }),
      HK("DELETE", undefined, { scope: "project", event: "Notification", index: 0 }),
      HKD("POST"),
      HKD("POST", undefined, "null"),
      HKD("POST", undefined, { scope: "bogus", disabled: true }),
      HKD("POST", undefined, { scope: "user", disabled: true, cwd: UNTRUSTED }),
      HKD("POST", undefined, { scope: "user", disabled: true }),
      HKD("POST", undefined, { scope: "project", disabled: "x" }),
      HKD("POST", undefined, '{"scope":"local","disabled":1e400}'),
      HK("GET"),
      HKD("POST", undefined, { scope: "user", disabled: 0 }),
      HKD("POST", undefined, { scope: "project" }),
      HKD("POST", undefined, { scope: "local", disabled: "" }),
      HKD("POST", undefined, { scope: "project", disabled: [], cwd: WSC }),
      HK("GET"),
    ],
  },
  {
    name: "hooks settings files",
    steps: [
      S(W("home/.claude/settings.json", '{"a":1,"hooks":{"Stop":[{"hooks":[]}]},"disableAllHooks":"yes","z":2,"__proto__":{"x":1}}\n')),
      HK("GET"),
      HK("POST", undefined, { scope: "user", event: "Stop", group: GROUP("kept in place") }),
      HKD("POST", undefined, { scope: "user", disabled: false }),
      HKD("POST", undefined, { scope: "user", disabled: true }),
      S(W("home/.claude/settings.json", '{"hooks":[1,2],"disableAllHooks":0}\n')),
      HK("GET"),
      HK("POST", undefined, { scope: "user", event: "Stop", group: GROUP("array hooks") }),
      S(W("home/.claude/settings.json", '{"hooks":{"PreToolUse":"ab","Stop":5,"Setup":{},"Elicitation":null}}\n')),
      HK("GET"),
      HK("POST", undefined, { scope: "user", event: "PreToolUse", group: GROUP("x") }),
      HK("DELETE", undefined, { scope: "user", event: "PreToolUse", index: 0 }),
      HK("DELETE", undefined, { scope: "user", event: "PreToolUse", index: 2 }),
      HK("POST", undefined, { scope: "user", event: "Stop", group: GROUP("x") }),
      HK("DELETE", undefined, { scope: "user", event: "Stop", index: 0 }),
      HK("POST", undefined, { scope: "user", event: "Setup", group: GROUP("x") }),
      HK("POST", undefined, { scope: "user", event: "Elicitation", group: GROUP("x") }),
      S(W("home/.claude/settings.json", "null\n")),
      HK("GET"),
      HK("POST", undefined, { scope: "user", event: "Stop", group: GROUP("x") }),
      HK("DELETE", undefined, { scope: "user", event: "Stop", index: 0 }),
      HKD("POST", undefined, { scope: "user", disabled: true }),
      S(W("home/.claude/settings.json", '"ab"\n')),
      HK("GET"),
      HK("POST", undefined, { scope: "user", event: "Stop", group: GROUP("x") }),
      S(W("home/.claude/settings.json", "{\n")),
      HK("GET"),
      HK("POST", undefined, { scope: "user", event: "Stop", group: GROUP("x") }),
      HK("DELETE", undefined, { scope: "user", event: "Stop", index: 0 }),
      HKD("POST", undefined, { scope: "user", disabled: true }),
      S(W("home/.claude/settings.json", "{}\n"), W("project/.claude/settings.local.json", '{"hooks":{"Stop":[]}} trailing')),
      HK("GET"),
      HK("POST", undefined, { scope: "local", event: "Stop", group: GROUP("x") }),
      S(RM("project/.claude/settings.local.json"), W("project/.claude/settings.json", `{"s":"${BS}ud800","hooks":{}}\n`)),
      HK("POST", undefined, { scope: "project", event: "Stop", group: GROUP("lone in the file") }),
      S(W("project/.claude/settings.json", '{"disableAllHooks":1e400}\n')),
      HK("GET", CWD(P)),
      HK("POST", undefined, `{"scope":"local","event":"Stop","group":{"hooks":[{"type":"command","command":"x${BS}udc00"}]}}`),
      S(RM("home/.claude/settings.json"), W("outside/settings.json", '{"theme":"dark"}\n'), LN("home/.claude/settings.json", "$ROOT/outside/settings.json")),
      HK("POST", undefined, { scope: "user", event: "Stop", group: GROUP("through the link") }),
      HK("GET", CWD(DOT)),
      HK("POST", undefined, { scope: "project", event: "Stop", group: GROUP("x"), cwd: DOT }),
      HKD("POST", undefined, { scope: "local", disabled: true, cwd: DOT }),
      HK("POST", undefined, { scope: "user", event: "Stop", group: GROUP("user with dotfile cwd"), cwd: DOT }),
      HK("GET", CWD(NULC)),
      HK("POST", undefined, { scope: "project", event: "Stop", group: GROUP("x"), cwd: NULC }),
      HK("DELETE", undefined, { scope: "local", event: "Stop", index: 0, cwd: NULC }),
      HKD("POST", undefined, { scope: "local", disabled: true, cwd: NULC }),
      HKD("POST", undefined, { scope: "user", disabled: true, cwd: NULC }),
    ],
  },
  {
    name: "hooks permissions",
    needs: ["perm"],
    steps: [
      S(W("home/.claude/settings.json", "{}\n"), CH("home/.claude/settings.json", 0o600)),
      HK("POST", undefined, { scope: "user", event: "Stop", group: GROUP("mode kept") }),
      S(CH("home/.claude/settings.json", 0o000)),
      HK("GET"),
      HKD("POST", undefined, { scope: "user", disabled: true }),
      S(CH("home/.claude/settings.json", 0o644), CH("home/.claude", 0o555)),
      HK("POST", undefined, { scope: "user", event: "Stop", group: GROUP("x") }),
      S(CH("home/.claude", 0o755)),
    ],
  },
  {
    name: "keybindings",
    steps: [
      KB("GET"),
      KB("PUT"),
      KB("PUT", undefined, "{"),
      KB("PUT", undefined, "null"),
      KB("PUT", undefined, "[]"),
      KB("PUT", undefined, {}),
      KB("PUT", undefined, { data: null }),
      KB("PUT", undefined, { data: "x" }),
      KB("PUT", undefined, { data: 5 }),
      KB("PUT", undefined, { data: false }),
      KB("PUT", undefined, '{"data":1e400}'),
      KB("PUT", undefined, { data: { bindings: [{ key: "ctrl+k", command: "palette" }], extra: { "10": 1, "2": 2, b: 3, a: 4 } } }),
      KB("GET"),
      KB("PUT", undefined, { data: [] }),
      KB("GET"),
      KB("PUT", undefined, `{"data":{"s":"a${BS}ud800b","n":1e400,"u":"${BS}ud83d${BS}ude00","__proto__":{"p":1}}}`),
      KB("GET"),
      S(W("home/.claude/keybindings.json", `{"s":"${BS}udfff","e":"${BS}u00e9"}`)),
      KB("GET"),
      S(W("home/.claude/keybindings.json", "null")),
      KB("GET"),
      S(W("home/.claude/keybindings.json", "{")),
      KB("GET"),
      S(W("home/.claude/keybindings.json", `${U(0xfeff)}{}`)),
      KB("GET"),
      S(WB("home/.claude/keybindings.json", [0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d])),
      KB("GET"),
      S(RM("home/.claude/keybindings.json"), MK("home/.claude/keybindings.json")),
      KB("GET"),
      KB("PUT", undefined, { data: {} }),
      S(RM("home/.claude/keybindings.json"), LN("home/.claude/keybindings.json", "$ROOT/outside/kb.json")),
      KB("GET"),
      KB("PUT", undefined, { data: { through: "the link" } }),
      KB("GET"),
      S(RM("home/.claude/keybindings.json"), RM("home/.claude/skills")),
      KB("PUT", undefined, { data: { fresh: true } }),
    ],
  },
  {
    name: "keybindings permissions",
    needs: ["perm"],
    steps: [
      S(W("home/.claude/keybindings.json", "{}"), CH("home/.claude/keybindings.json", 0o000)),
      KB("GET"),
      KB("PUT", undefined, { data: {} }),
      S(CH("home/.claude/keybindings.json", 0o644), RM("home/.claude/keybindings.json"), CH("home/.claude", 0o555)),
      KB("PUT", undefined, { data: {} }),
      S(CH("home/.claude", 0o755)),
    ],
  },
  {
    name: "claudemd",
    steps: [
      CM("GET"),
      CM("GET", CWD(UNTRUSTED)),
      CM("GET", "scope=bogus"),
      CM("GET", "scope="),
      CM("GET", "scope=user"),
      CM("GET", "scope=project-claude"),
      CM("GET", "resolved=1&scope=bogus"),
      CM("GET", "resolved=true"),
      CM("GET", `resolved=1&${CWD(UNTRUSTED)}`),
      CM("PUT"),
      CM("PUT", undefined, "{"),
      CM("PUT", undefined, "null"),
      CM("PUT", undefined, { scope: "bogus", content: "x" }),
      CM("PUT", undefined, { scope: "user" }),
      CM("PUT", undefined, { scope: "user", content: 5 }),
      CM("PUT", undefined, { scope: "user", content: null }),
      CM("PUT", undefined, '{"scope":"user","content":1e400}'),
      CM("PUT", undefined, { scope: "user", content: "x", cwd: UNTRUSTED }),
      CM("PUT", undefined, { scope: "user", content: "# user\n" }),
      CM("PUT", undefined, { scope: "project", content: "# project\n" }),
      CM("PUT", undefined, { scope: "project-claude", content: "# project claude\n" }),
      CM("PUT", undefined, { scope: "local", content: "" }),
      CM("PUT", undefined, { scope: "project", content: `ws ${U(0x1f600)}`, cwd: WSC }),
      CM("PUT", undefined, { scope: "local", content: "uni", cwd: UNIC }),
      CM("PUT", undefined, `{"scope":"user","content":"lone ${BS}udc00 end"}`),
      CM("PUT", undefined, { scope: "local", content: "cwd 5", cwd: 5 }),
      CM("GET"),
      CM("GET", CWD(WSC)),
      CM("GET", CWD(UNIC)),
      CM("GET", "scope=project"),
      S(RM("project/CLAUDE.md"), W("project/AGENTS.md", "# agents\n")),
      CM("GET", "scope=project"),
      CM("GET"),
      CM("PUT", undefined, { scope: "project", content: "# agents rewritten\n" }),
      S(W("project/CLAUDE.md", "# claude again\n")),
      CM("GET", "scope=project"),
      CM("PUT", undefined, { scope: "project", content: "# claude rewritten\n" }),
      S(RM("project/CLAUDE.md"), LN("project/CLAUDE.md", "$ROOT/nowhere/CLAUDE.md")),
      CM("GET", "scope=project"),
      CM("PUT", undefined, { scope: "project", content: "# dangling claude, agents present\n" }),
      S(RM("project/AGENTS.md")),
      CM("PUT", undefined, { scope: "project", content: "# through the dangling link\n" }),
      S(RM("project/CLAUDE.md"), RM("outside/CLAUDE.md"), MK("project/CLAUDE.md")),
      CM("GET", "scope=project"),
      CM("GET"),
      CM("GET", "resolved=1"),
      CM("PUT", undefined, { scope: "project", content: "x" }),
      S(RM("project/CLAUDE.md"), MK("project/AGENTS.md")),
      CM("GET", "scope=project"),
      S(RM("project/AGENTS.md"), LN("project/CLAUDE.md", "$ROOT/outside/secret.md")),
      CM("GET", "scope=project"),
      CM("PUT", undefined, { scope: "project", content: "# through the link\n" }),
      CM("GET", CWD(DOT)),
      CM("GET", `scope=project-claude&${CWD(DOT)}`),
      CM("PUT", undefined, { scope: "project-claude", content: "x", cwd: DOT }),
      CM("PUT", undefined, { scope: "project", content: "# dotfile\n", cwd: DOT }),
      CM("GET", CWD(NULC)),
      CM("GET", `scope=user&${CWD(NULC)}`),
      CM("GET", `scope=local&${CWD(NULC)}`),
      CM("GET", `resolved=1&${CWD(NULC)}`),
      CM("PUT", undefined, { scope: "project", content: "x", cwd: NULC }),
      CM("PUT", undefined, { scope: "user", content: "# user from nul\n", cwd: NULC }),
      // The user scope fails too: all four scopes under Promise.all (the NUL
      // refusal wins), the hierarchy one at a time (the user read fails first).
      S(RM("home/.claude/CLAUDE.md"), MK("home/.claude/CLAUDE.md")),
      CM("GET", CWD(NULC)),
      CM("GET", `resolved=1&${CWD(NULC)}`),
    ],
  },
  {
    name: "claudemd imports",
    steps: [
      S(
        W("home/.claude/CLAUDE.md", "# user\n@inc/a.md\nafter a\n  @inc/b.md  \n@missing.md\n@~/x.md\n@inc\ntext @inc/a.md\n@\n@inc/a.md extra\n\t@inc/c.md\r\n@$ROOT/outside/secret.md\n@../../outside/secret.md\n"),
        W("home/.claude/inc/a.md", "a line\n@b.md\na end"),
        W("home/.claude/inc/b.md", `b ${U(0x1f600)}\n@a.md\n`),
        W("home/.claude/inc/c.md", "c\n@c.md\n"),
        W("project/CLAUDE.md", "@d1.md\n"),
        ...[1, 2, 3, 4, 5, 6, 7].map((i) => W(`project/d${i}.md`, `depth ${i}\n@d${i + 1}.md\n`)),
        W("project/d8.md", "depth 8\n"),
        W("project/.claude/CLAUDE.md", "@../CLAUDE.local.md\n@sib.md\n@sib.md\n"),
        W("project/.claude/sib.md", "sibling\n"),
        WB("project/CLAUDE.local.md", BAD_UTF8),
        W("ws/AGENTS.md", "@nul.md\n"),
        W("ws/nul.md", `@a${U(0)}b\n@${U(0x1f600)}.md\n`),
        W(`ws/${U(0x1f600)}.md`, `emoji ${U(0x1f600)}`),
      ),
      CM("GET", "resolved=1"),
      CM("GET", `resolved=1&${CWD(WSC)}`),
      CM("GET", `resolved=1&${CWD(DOT)}`),
      CM("GET", `resolved=1&scope=user&${CWD(WSC)}`),
    ],
  },
  {
    name: "claudemd permissions",
    needs: ["perm"],
    steps: [
      S(W("project/CLAUDE.md", "x"), CH("project/CLAUDE.md", 0o000), W("home/.claude/CLAUDE.md", "@inc.md\n"), W("home/.claude/inc.md", "inc"), CH("home/.claude/inc.md", 0o000)),
      CM("GET", "scope=project"),
      CM("GET"),
      CM("GET", "resolved=1"),
      CM("PUT", undefined, { scope: "project", content: "y" }),
      S(CH("project/CLAUDE.md", 0o644), CH("home/.claude/inc.md", 0o644), MK("project/.claude"), CH("project/.claude", 0o555)),
      CM("GET", "resolved=1"),
      CM("PUT", undefined, { scope: "project-claude", content: "x" }),
      S(CH("project/.claude", 0o000)),
      CM("GET", "scope=project-claude"),
      S(CH("project/.claude", 0o755), CH("project", 0o555)),
      CM("PUT", undefined, { scope: "local", content: "x" }),
      S(CH("project", 0o755)),
    ],
  },
];

const routes = [];
for (const g of ROUTES) {
  if ((g.needs ?? []).includes("perm") && !PERM) {
    routes.push({ name: g.name, needs: g.needs, skipped: true });
    continue;
  }
  routes.push(await runGroup(g));
}

const fixture = {
  node: process.version,
  platform: process.platform,
  unicode: process.versions.unicode,
  perm: PERM,
  world: WORLD,
  props: runs.join(","),
  names,
  modules,
  routes,
};
writeFileSync(join(ROOT, "out.json"), JSON.stringify(fixture));
