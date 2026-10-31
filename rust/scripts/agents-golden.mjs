#!/usr/bin/env node
// Golden fixture for the agents port (G05), recorded from the TS sources:
//
//   node rust/scripts/agents-golden.mjs     (node@22: db.ts needs
//                                            better-sqlite3, which bun can't
//                                            load; builds claudius-fake-claude)
//
// Re-runs itself under `--experimental-transform-types`, in TZ=UTC, with
// HOME and CLAUDE_CONFIG_DIR in a temp root and its cwd (the one trusted
// root) at `<root>/project`, and a resolve hook for the extensionless / `@/`
// imports, twice (two temp roots); both recordings must agree byte for byte.
// The hook also maps session.ts's SDK import to a shim that calls the real
// `query()` with `pathToClaudeCodeExecutable` set to the fake CLI. Paths are
// written with placeholders: `$HOME`, `$PROJECT` (the trusted root) and
// `$CWD` (the module cases' project dir). `Date.now()` is pinned while the
// DB code runs and its value written `"$NOW"`. Records:
//
// - `yaml`: the `yaml` package (what `parseFrontmatter` parses with) on a
//   hand corpus and two seeded fuzz corpora: `[src, errors, warnings,
//   multipleDocs, result]`, `result` being `{json: JSON.stringify(parse)}`,
//   "throws", "undefined" or "circular". Errors and warnings are null for a
//   multi-document source (only the first document is composed) and for the
//   nesting cases (`src` then `{deep, n}`; node runs out of stack at a depth
//   that varies run to run). Sources whose result holds a lone surrogate are
//   left out.
// - `collation`: `localeCompare` on generated names (ASCII, controls, the
//   precomposed Latin letters, combining marks): the stable sort's order,
//   and the sign for sampled pairs.
// - `frontmatter`: `parseFrontmatter(raw)`: the frontmatter as
//   `JSON.stringify` writes it ("circular" when it throws), `name` when it
//   is a string, and the body.
// - `files`: the real `agentsDir` / `agentPath` / `writeAgent` / `readAgent`
//   / `listAgents` / `deleteAgent` in order, between filesystem setups
//   (`fs`: mkdir, write bytes, chmod, symlink, rm), each call's outcome
//   (`threw` holds the message where a route shows it), then every file
//   under the two scopes' `.claude` dirs (`tree`).
// - `db`: `isValidAgentName` / `assertValidAgentName` and
//   `coerceAgentDefinition` on JSON inputs, then `listDbAgents` /
//   `loadDbAgentsForOptions` / `upsertDbAgent` / `deleteDbAgent` in order,
//   with raw SQL (`sql`, run on the cwd's `.claudius.db`) adding rows of
//   every SQLite type, a foreign-schema table and a DB without the table;
//   the table's rows after (`quote()` of each column, by rowid).
// - `routes`: the real handlers of `/api/agents` (GET, PUT),
//   `/api/agents/[name]` (DELETE) and `/api/agents/db` (GET, PUT, DELETE),
//   in order in one world without live sessions, between `fs` / `sql` setups:
//   the request (`request`, or `requestHex` for raw bytes; neither for no
//   body) and the response (`status`, `body` as sent; an uncaught throw is
//   Next's empty 500); then the tree and the DB rows.
// - `reload`: the same handlers with two live sessions in the trusted root
//   (bare `Session`s whose `query` is a real SDK `query()` against the fake
//   CLI, in `sessionManager`): each call's response and the
//   `reload_plugins` control requests the sessions' CLIs got (ids `$ID`).
// - `start`: the real `new Session({cwd}).start()` against the fake CLI in
//   a cwd set up by `db` (its DB opened, so migrated), `upserts` and `sql`:
//   the `agents` of the `initialize` request it wrote (`JSON.stringify`'d;
//   null when absent).
//
// Written to rust/crates/claudius-core/tests/fixtures/agents_golden.json and
// replayed by crates/claudius-core/tests/agents_golden.rs (yaml, collation,
// frontmatter, files, db, start) and crates/claudius-server/tests/
// agents_routes.rs (routes, reload).
import { execFileSync, spawnSync } from "node:child_process";
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
import { createRequire, register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "crates/claudius-core/tests/fixtures/agents_golden.json");

/** Restore write/read permission under `dir` so it can be removed. */
function unlock(dir) {
  try {
    const st = lstatSync(dir);
    if (st.isSymbolicLink()) return;
    chmodSync(dir, 0o755);
    if (st.isDirectory()) for (const e of readdirSync(dir)) unlock(join(dir, e));
  } catch {
    // gone already
  }
}

// ------------------------------- recording -------------------------------

if (!process.env.AGENTS_GOLDEN_CHILD) {
  execFileSync("cargo", ["build", "-q", "-p", "claudius-agent", "--bin", "claudius-fake-claude"], {
    cwd: rustDir,
    stdio: "inherit",
    env: { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` },
  });
  const fake = join(rustDir, "target/debug/claudius-fake-claude");
  const runs = [0, 1].map(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "agents-golden-")));
    try {
      for (const d of ["home", "config", "project"]) mkdirSync(join(root, d));
      // db.ts reads its migrations from `<cwd>/lib/server/db-migrations`.
      mkdirSync(join(root, "project/lib/server"), { recursive: true });
      symlinkSync(join(repo, "lib/server/db-migrations"), join(root, "project/lib/server/db-migrations"));
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
            TZ: "UTC",
            AGENTS_GOLDEN_CHILD: root,
            AGENTS_GOLDEN_FAKE: fake,
          },
        },
      );
      if (r.status !== 0) {
        process.stderr.write(r.stderr);
        process.exit(r.status ?? 1);
      }
      return readFileSync(join(root, "out.json"), "utf8");
    } finally {
      unlock(root);
      rmSync(root, { recursive: true, force: true });
    }
  });
  if (runs[0] !== runs[1]) throw new Error("the two recordings differ");
  const fixture = JSON.parse(runs[0]);
  // One line per yaml case, collation pair and file step; the rest indented.
  const lines = (xs) => `[\n${xs.map((x) => `  ${JSON.stringify(x)}`).join(",\n")}\n ]`;
  const parts = Object.entries(fixture).map(([k, v]) => {
    if (k === "yaml") return ` ${JSON.stringify(k)}: ${lines(v)}`;
    if (k === "collation") {
      return ` "collation": {"names": ${lines(v.names)}, "order": ${JSON.stringify(v.order)}, "pairs": ${lines(v.pairs)}}`;
    }
    if (Array.isArray(v)) return ` ${JSON.stringify(k)}: ${lines(v)}`;
    if (v && typeof v === "object") {
      const inner = Object.entries(v).map(([k2, v2]) =>
        Array.isArray(v2) ? `  ${JSON.stringify(k2)}: ${lines(v2)}` : `  ${JSON.stringify(k2)}: ${JSON.stringify(v2)}`,
      );
      return ` ${JSON.stringify(k)}: {\n${inner.join(",\n")}\n }`;
    }
    return ` ${JSON.stringify(k)}: ${JSON.stringify(v)}`;
  });
  const text = `{\n${parts.join(",\n")}\n}\n`;
  if (JSON.stringify(JSON.parse(text)) !== JSON.stringify(fixture)) throw new Error("layout changed the fixture");
  writeFileSync(out, text);
  console.log(
    `wrote ${out.slice(repo.length + 1)}: ${fixture.yaml.length} yaml, ${fixture.collation.names.length} names / ${fixture.collation.pairs.length} pairs, ${fixture.frontmatter.length} frontmatter, ${fixture.files.steps.length} file steps, ${fixture.db.steps.length} db steps, ${fixture.routes.steps.length} route steps, ${fixture.reload.steps.length} reload steps, ${fixture.start.length} starts (SDK ${fixture.sdkVersion}, yaml ${fixture.yamlVersion})`,
  );
  process.exit(0);
}

// --------------------------------- child ---------------------------------

const ROOT_DIR = process.env.AGENTS_GOLDEN_CHILD;
const FAKE = process.env.AGENTS_GOLDEN_FAKE;
const SDK = "@anthropic-ai/claude-agent-sdk";
const realSdk = import.meta.resolve(SDK);
const shim = join(ROOT_DIR, "sdk-shim.mjs");
writeFileSync(
  shim,
  `import * as real from ${JSON.stringify(realSdk)};
export * from ${JSON.stringify(realSdk)};
export function query(args) {
  return real.query({ ...args, options: { ...args.options, pathToClaudeCodeExecutable: process.env.AGENTS_GOLDEN_FAKE } });
}
`,
);

const hook = `
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
const ROOT = ${JSON.stringify(pathToFileURL(repo + "/").href)};
const SHIM = ${JSON.stringify(pathToFileURL(shim).href)};
export async function resolve(spec, ctx, next) {
  if (spec === ${JSON.stringify(SDK)} && ctx.parentURL && ctx.parentURL.endsWith("/lib/server/session.ts")) {
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

const agents = await import(join(repo, "lib/server/agents.ts"));
const dbAgents = await import(join(repo, "lib/server/db-agents.ts"));
const agentsRoute = await import(join(repo, "app/api/agents/route.ts"));
const nameRoute = await import(join(repo, "app/api/agents/[name]/route.ts"));
const dbRoute = await import(join(repo, "app/api/agents/db/route.ts"));
const { Session } = await import(join(repo, "lib/server/session.ts"));
const { openDb } = await import(join(repo, "lib/server/db.ts"));
const { sessionManager } = await import(join(repo, "lib/server/session-manager.ts"));
const { query } = await import(SDK);
const require = createRequire(join(repo, "package.json"));
const YAML = require("yaml");
const Database = require("better-sqlite3");
const sdkVersion = JSON.parse(readFileSync(join(dirname(fileURLToPath(realSdk)), "package.json"), "utf8")).version;
const yamlVersion = JSON.parse(readFileSync(require.resolve("yaml/package.json"), "utf8")).version;

const HOME = process.env.HOME;
const PROJECT = process.cwd();
const CWD = join(ROOT_DIR, "fproj");
mkdirSync(CWD);
const PLACES = [
  ["$PROJECT", PROJECT],
  ["$CWD", CWD],
  ["$HOME", HOME],
];
const place = (s) => PLACES.reduce((t, [k, v]) => t.split(v).join(k), s);
const unplace = (s) => PLACES.reduce((t, [k, v]) => t.split(k).join(v), s);
const cp = (n) => String.fromCodePoint(n);
const J = (v) => JSON.stringify(v);

/** mulberry32: the fuzz corpora are generated, not stored in this file. */
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
const pick = (r, xs) => xs[Math.floor(r() * xs.length)];
const int = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));

// ---------------------------------- yaml ----------------------------------

const DEEP = {
  flow: (n) => `a: ${"[".repeat(n)}x${"]".repeat(n)}`,
  blockMap: (n) =>
    Array.from({ length: n }, (_, i) => `${"  ".repeat(i)}k${i}:${i === n - 1 ? " x" : ""}`).join("\n"),
  blockSeq: (n) => Array.from({ length: n }, (_, i) => `${"  ".repeat(i)}- ${i === n - 1 ? "x" : ""}`).join("\n"),
};

// The hand corpus: scalars, collections, anchors and merges, tags,
// directives, broken structure, unicode and object keys, and keys that are
// collections (which yaml stringifies to name them).
const HAND = [
  "name: foo",
  "a: 1",
  "a: -0",
  "a: +12",
  "a: 0o17",
  "a: 0x1F",
  "a: 0xffffffffffffffffffff",
  "a: 12345678901234567890",
  "a: 9007199254740993",
  "a: 1.5",
  "a: 1.",
  "a: .5",
  "a: -.5",
  "a: 1e3",
  "a: 1.5E-7",
  "a: 1e400",
  "a: -1e400",
  "a: .inf",
  "a: -.Inf",
  "a: +.INF",
  "a: .nan",
  "a: .NaN",
  "a: 0b101",
  "a: 012",
  "a: 1_000",
  "a: 1:30",
  "a: 0x_1",
  "a: 08",
  "a: true",
  "a: True",
  "a: TRUE",
  "a: tRue",
  "a: yes",
  "a: no",
  "a: on",
  "a: off",
  "a: y",
  "a: null",
  "a: Null",
  "a: NULL",
  "a: ~",
  "a:",
  "a: nUll",
  "a: 2001-12-14",
  "a: 2001-12-14t21:59:43.10-05:00",
  "a: foo bar",
  "a: foo: bar",
  "a: foo:bar",
  "a: foo #comment",
  "a: foo#notcomment",
  "a: 'it''s'",
  "a: \"x\\ty\"",
  "a: \"\\x41\\u00e9\\U0001F600\"",
  "a: \"\\uD800\"",
  "a: \"\\q\"",
  "a: \"\\x4\"",
  "a: \"\\U00110000\"",
  "a: \"\\0\\a\\b\\e\\f\\n\\r\\t\\v\\N\\_\\L\\P\\ \\\"\\/\\\\\"",
  "a: \"line1\nline2\"",
  "a: \"line1\n\n  line2\"",
  "a: \"a \\\n   b\"",
  "a: \"trail   \n  x\"",
  "a: 'one\n  two\n\n  three'",
  "a: plain\n  continued\n  more",
  "a: plain\n\n  para",
  "a: x\n\n\n  y",
  "a: @foo",
  "a: `foo",
  "a: %foo",
  "a: |x",
  "a: ,x",
  "a: -",
  "a: - x",
  "a: ? x",
  "a: :x",
  "a: x:",
  "a: |\n  literal\n  text\n",
  "a: >\n  folded\n  text\n\n  para\n",
  "a: |-\n  strip\n\n",
  "a: |+\n  keep\n\n\n",
  "a: >-\n  a\n   b\n  c\n",
  "a: |2\n    two\n   one\n",
  "a: >\n\n  lead\n",
  "a: |\n\n\n",
  "a: |+\n\n",
  "a: >\n  a\n\n    more\n  b\n",
  "a: |\n\ttab\n",
  "a: |\n  x\n y\n",
  "a: |#c\n  x\n",
  "a: | #c\n  x\n",
  "a: |-+\n  x\n",
  "a: |0\n  x\n",
  "a: |10\n  x\n",
  "a: >\n  x\n  \ty\n",
  "- |\n  in seq\n- >\n  folded\n",
  "|\n top\n",
  "- |\nnot indented\n",
  "[a, b]",
  "{a: 1, b: 2}",
  "a: [1, 2, [3, 4]]",
  "a: {b: {c: d}}",
  "a: [a, ]",
  "a: [a,,b]",
  "a: [a b]",
  "a: [a, b",
  "a: {a: 1",
  "a: [a: 1, b]",
  "a: {a, b}",
  "a: [? x : y]",
  "a: {? x : y}",
  "a: [ : x]",
  "a: {:x}",
  "a: { a:1 }",
  "a: [a:1]",
  "a: {\"a\":1}",
  "a: [\"a\":1]",
  "a: [,a]",
  "a: {,a}",
  "a: []",
  "a: {}",
  "a: [\n  1,\n  2\n]",
  "a: {\n  x: 1,\n  y: 2\n}",
  "a: [\n1]",
  "x:\n  a: [\n  1]\n",
  "a: [1, 2] # c",
  "a: [1 # c\n, 2]",
  "a: [a: 1, b: 2]",
  "a: [a: 1\n, b]",
  "- a\n- b\n- - c\n  - d",
  "- a: 1\n  b: 2\n- c: 3",
  "a:\n- 1\n- 2",
  "a:\n  - 1\n  - 2",
  "a:\n  b:\n    c: 1\n  d: 2",
  "? a\n: b",
  "? a\n? b\n: c",
  "? - a\n  - b\n: c",
  "? |\n  block key\n: v",
  "? a: 1\n: b",
  "? a",
  "a: 1\n? b",
  "? \n: x",
  "[a, b]: c",
  "{x: 1}: y",
  "? [a, b]\n: c",
  "[1, true, null, ~]: x",
  "[ \"q\", 'r' ]: y",
  "[]: x",
  "{}: y",
  "[&x a, *x]: z",
  "[a, [b, c]]: d",
  "{a: [b]}: c",
  "[2001-12-14]: x",
  "[-1, 0.5, 1e3, .inf]: x",
  "[a: 1]: b",
  "{a, b}: c",
  "[\"a,b\", 'c d', \"x:y\"]: z",
  "[\"\"]: x",
  "[\"1\"]: x",
  "[\"true\"]: x",
  "[\"a\\nb\"]: x",
  "[\"tab\\tx\"]: y",
  "[\"#x\"]: y",
  "[\" x\"]: y",
  "[\"x \"]: y",
  "[\"-\"]: y",
  "[\"? \"]: y",
  "[\"it's\"]: y",
  "['say \"hi\"']: y",
  "[\"both ' and \\\"\"]: y",
  "a: &x 1\nb: *x",
  "a: *x\nb: &x 1",
  "a: &x [1, 2]\nb: *x\nc: *x",
  "a: &x\n  b: 1\nc: *x",
  "&a [*a]",
  "&a {b: *a}",
  "a: &x {y: *x}",
  "a: &a\n  - *a",
  "a: &x 1\n*x : 2",
  "a: &x [1]\n*x : 2",
  "a: &x {k: v}\n? *x\n: 3",
  "a: &x\nb: *x",
  "a: & x",
  "a: *",
  "a: &x: 1",
  "a: *x:",
  "&x a: 1",
  "a: &x &y 1",
  "a: !!str &x 1\nb: *x",
  "a: &x !!str 1\nb: *x",
  "a: &x b\nc: &x d\ne: *x",
  "base: &b {x: 1, y: 2}\nm:\n  <<: *b\n  z: 3",
  "base: &b {x: 1}\nm:\n  !!merge <<: *b\n  x: 2\n  z: 3",
  "base: &b {x: 1}\nm:\n  x: 2\n  !!merge <<: *b",
  "a: &a {x: 1}\nb: &b {y: 2}\nm:\n  !!merge <<: [*a, *b]",
  "m:\n  !!merge <<: 1",
  "m:\n  !!merge <<: [1]",
  "m:\n  !!merge <<: {a: 1}",
  "m:\n  !!merge <<:",
  "m: {!!merge <<}",
  "m:\n  !!merge foo: {a: 1}",
  "%YAML 1.1\n---\nbase: &b {x: 1}\nm:\n  <<: *b\n  y: 2",
  "%YAML 1.1\n---\nm:\n  \"<<\": {a: 1}",
  "%YAML 1.1\n---\nm:\n  !!str <<: {a: 1}",
  "%YAML 1.1\n---\nm:\n  <<: [{a: 1}, {a: 2, b: 3}]",
  "%YAML 1.1\n---\na: yes\nb: NO\nc: on\nd: 012\ne: 0b11\nf: 1_000\ng: 1:30\nh: 1:30.5\ni: 2001-12-14\nj: .\nk: 0_\nl: 1.5_0\nm: 1e3\nn: ~\no: y\np: -0x1F\nq: +0b1\nr: 0o17",
  "%YAML 1.1\n---\na: 2001-12-14 21:59:43.10 -5\nb: 2001-12-14T21:59:43Z\nc: 0050-01-01\nd: 2001-13-45\ne: 2001-12-14t21:59:43.1234+05:30",
  "%YAML 1.1\n---\n!!set {a, b}: x",
  "%YAML 1.1\n---\n[2001-12-14]: x",
  "a0: &a0 [x, x, x, x, x, x, x, x, x, x]\na1: &a1 [*a0, *a0, *a0, *a0, *a0, *a0, *a0, *a0, *a0, *a0]\na2: &a2 [*a1, *a1, *a1, *a1, *a1, *a1, *a1, *a1, *a1, *a1]\na3: &a3 [*a2, *a2, *a2, *a2, *a2, *a2, *a2, *a2, *a2, *a2]\na4: &a4 [*a3, *a3, *a3, *a3, *a3, *a3, *a3, *a3, *a3, *a3]",
  "a: &a x\nb0: *a\nb1: *a\nb2: *a\nb3: *a\nb4: *a\nb5: *a\nb6: *a\nb7: *a\nb8: *a\nb9: *a\nb10: *a\nb11: *a\nb12: *a\nb13: *a\nb14: *a\nb15: *a\nb16: *a\nb17: *a\nb18: *a\nb19: *a\nb20: *a\nb21: *a\nb22: *a\nb23: *a\nb24: *a\nb25: *a\nb26: *a\nb27: *a\nb28: *a\nb29: *a\nb30: *a\nb31: *a\nb32: *a\nb33: *a\nb34: *a\nb35: *a\nb36: *a\nb37: *a\nb38: *a\nb39: *a\nb40: *a\nb41: *a\nb42: *a\nb43: *a\nb44: *a\nb45: *a\nb46: *a\nb47: *a\nb48: *a\nb49: *a\nb50: *a\nb51: *a\nb52: *a\nb53: *a\nb54: *a\nb55: *a\nb56: *a\nb57: *a\nb58: *a\nb59: *a\nb60: *a\nb61: *a\nb62: *a\nb63: *a\nb64: *a\nb65: *a\nb66: *a\nb67: *a\nb68: *a\nb69: *a\nb70: *a\nb71: *a\nb72: *a\nb73: *a\nb74: *a\nb75: *a\nb76: *a\nb77: *a\nb78: *a\nb79: *a\nb80: *a\nb81: *a\nb82: *a\nb83: *a\nb84: *a\nb85: *a\nb86: *a\nb87: *a\nb88: *a\nb89: *a\nb90: *a\nb91: *a\nb92: *a\nb93: *a\nb94: *a\nb95: *a\nb96: *a\nb97: *a\nb98: *a",
  "a: &a x\nb0: *a\nb1: *a\nb2: *a\nb3: *a\nb4: *a\nb5: *a\nb6: *a\nb7: *a\nb8: *a\nb9: *a\nb10: *a\nb11: *a\nb12: *a\nb13: *a\nb14: *a\nb15: *a\nb16: *a\nb17: *a\nb18: *a\nb19: *a\nb20: *a\nb21: *a\nb22: *a\nb23: *a\nb24: *a\nb25: *a\nb26: *a\nb27: *a\nb28: *a\nb29: *a\nb30: *a\nb31: *a\nb32: *a\nb33: *a\nb34: *a\nb35: *a\nb36: *a\nb37: *a\nb38: *a\nb39: *a\nb40: *a\nb41: *a\nb42: *a\nb43: *a\nb44: *a\nb45: *a\nb46: *a\nb47: *a\nb48: *a\nb49: *a\nb50: *a\nb51: *a\nb52: *a\nb53: *a\nb54: *a\nb55: *a\nb56: *a\nb57: *a\nb58: *a\nb59: *a\nb60: *a\nb61: *a\nb62: *a\nb63: *a\nb64: *a\nb65: *a\nb66: *a\nb67: *a\nb68: *a\nb69: *a\nb70: *a\nb71: *a\nb72: *a\nb73: *a\nb74: *a\nb75: *a\nb76: *a\nb77: *a\nb78: *a\nb79: *a\nb80: *a\nb81: *a\nb82: *a\nb83: *a\nb84: *a\nb85: *a\nb86: *a\nb87: *a\nb88: *a\nb89: *a\nb90: *a\nb91: *a\nb92: *a\nb93: *a\nb94: *a\nb95: *a\nb96: *a\nb97: *a\nb98: *a\nb99: *a",
  null, // #211: generated below
  "a0: &a0 []\na1: &a1 [*a0]\na2: &a2 [*a1]\na3: &a3 [*a2]\na4: &a4 [*a3]\na5: &a5 [*a4]\na6: &a6 [*a5]\na7: &a7 [*a6]\na8: &a8 [*a7]\na9: &a9 [*a8]\na10: &a10 [*a9]\na11: &a11 [*a10]\na12: &a12 [*a11]\na13: &a13 [*a12]\na14: &a14 [*a13]\na15: &a15 [*a14]\na16: &a16 [*a15]\na17: &a17 [*a16]\na18: &a18 [*a17]\na19: &a19 [*a18]\na20: &a20 [*a19]\na21: &a21 [*a20]\na22: &a22 [*a21]\na23: &a23 [*a22]\na24: &a24 [*a23]\na25: &a25 [*a24]\na26: &a26 [*a25]\na27: &a27 [*a26]\na28: &a28 [*a27]\na29: &a29 [*a28]\na30: &a30 [*a29]\na31: &a31 [*a30]\na32: &a32 [*a31]\na33: &a33 [*a32]\na34: &a34 [*a33]\na35: &a35 [*a34]\na36: &a36 [*a35]\na37: &a37 [*a36]\na38: &a38 [*a37]\na39: &a39 [*a38]\na40: &a40 [*a39]\na41: &a41 [*a40]\na42: &a42 [*a41]\na43: &a43 [*a42]\na44: &a44 [*a43]\na45: &a45 [*a44]\na46: &a46 [*a45]\na47: &a47 [*a46]\na48: &a48 [*a47]\na49: &a49 [*a48]\na50: &a50 [*a49]\na51: &a51 [*a50]\na52: &a52 [*a51]\na53: &a53 [*a52]\na54: &a54 [*a53]\na55: &a55 [*a54]\na56: &a56 [*a55]\na57: &a57 [*a56]\na58: &a58 [*a57]\na59: &a59 [*a58]",
  "a: !!str 123",
  "a: !!int \"12\"",
  "a: !!int abc",
  "a: !!float 1",
  "a: !!float 1.5",
  "a: !!bool yes",
  "a: !!bool true",
  "a: !!null \"\"",
  "a: !!null x",
  "a: !foo bar",
  "a: !<tag:yaml.org,2002:int> 5",
  "a: !<!> 5",
  "a: !<tag:x",
  "a: !e!foo bar",
  "a: !! bar",
  "a: !!%69nt 5",
  "a: !!%E9 x",
  "a: !!%ZZ x",
  "a: !!%C3 x",
  "%TAG !e! tag:example.com,2000:\n---\na: !e!foo bar",
  "%TAG !e! tag:yaml.org,2002:\n---\na: !e!int 5",
  "%TAG ! tag:yaml.org,2002:\n---\na: !int 5",
  "%TAG !e!\n---\na: 1",
  "%TAG !e! a b\n---\nx: 1",
  "a: ! 12",
  "a: ! [1]",
  "a: !!map [a]",
  "a: !!seq {a: 1}",
  "a: !!map {a: 1}",
  "a: !!seq [1]",
  "a: !!str [a]",
  "a: !!int {a: 1}",
  "a: !!set [a]",
  "a: !!binary [a]",
  "a: !!map x",
  "a: !!set x",
  "a: !!binary aGVsbG8=",
  "a: !!binary |\n  aGVs\n  bG8=\n",
  "a: !!binary \"aGV*sbG8\"",
  "a: !!binary \"aGVsbG8=QUFB\"",
  "a: !!binary \"\"",
  "a: !!binary Q",
  "a: !!binary QQ",
  "a: !!binary -_-_",
  "a: !!binary \"\u0141\u0141\u0141\u0141\"",
  "a: !!timestamp 2001-12-14t21:59:43.10-05:00",
  "a: !!timestamp 2001-12-14",
  "a: !!timestamp nope",
  "a: !!timestamp 0001-01-01",
  "a: !!timestamp 9999-12-31t23:59:59.999Z",
  "a: !!timestamp 9999-13-31",
  "a: !!timestamp 2001-02-30 01:02:03 +5",
  "a: !!set {a, b}",
  "a: !!set {a: 1}",
  "a: !!set\n  ? x\n  ? y\n",
  "a: !!set {a: ~}",
  "a: !!set {a: !!null}",
  "a: !!set {a # c\n}",
  "a: !!omap [a: 1, b: 2]",
  "a: !!omap [a: 1, a: 2]",
  "a: !!omap\n  - a: 1\n  - b: 2\n",
  "a: !!omap [{a: 1, b: 2}]",
  "a: !!omap [x, y]",
  "a: !!omap [{}]",
  "a: !!omap [.nan: 1, .NaN: 2]",
  "a: !!pairs [a: 1, a: 2]",
  "a: !!pairs\n  - a: 1\n  - a: 2\n",
  "a: !!pairs [x]",
  "a: !!str\n  - x",
  "- !!str\n- x",
  "a: &x !!set {k}\nb: *x",
  "!!timestamp 2001-12-14",
  "!!binary aGk=",
  "!!set {a}",
  "!!omap [a: 1]",
  "!!str x",
  "!!int 5",
  "[1, 2]",
  "- a",
  "'x'",
  "123",
  "~",
  "",
  "%YAML 1.2\n---\na: 1",
  "%YAML 1.3\n---\na: 1",
  "%YAML 2\n---\na: 1",
  "%YAML\n---\na: 1",
  "%YAML 1.1 1.2\n---\na: 1",
  "%FOO bar\n---\na: 1",
  "%YAML 1.2\na: 1",
  "%YAML 1.2",
  "---\na: 1",
  "--- \na: 1",
  "--- a: 1",
  "--- [a]",
  "--- |\n  text",
  "--- >\n  folded",
  "---a: 1",
  "a: 1\n...\n",
  "a: 1\n...",
  "a: 1\n... # c\n",
  "a: 1\n... x",
  "a: 1\n---\nb: 2",
  "a: 1\n---\n",
  "---\n---\n",
  "...\na: 1",
  "a: 1\n...\n---\nb: 2",
  "# only comment",
  "\n\n",
  "   ",
  "---",
  "...",
  "--- # c\na: 1",
  "%YAML 1.1\n---\na: 1\n...\n%YAML 1.2\n---\nb: 2",
  "\ufeffa: 1",
  "a: \ufeffb",
  "a: 1\n\ufeff",
  "a: 1\na: 2",
  "a: 1\n\"a\": 2",
  "1: a\n1.0: b",
  "1: a\n\"1\": b",
  "null: a\n~: b",
  "true: a\nTrue: b",
  ".nan: a\n.nan: b",
  "0: a\n-0: b",
  "a:\n\tb: 1",
  "a: 1\n\tb: 2",
  "\ta: 1",
  "a:\n  b: 1\n c: 2",
  "a:\n    b: 1\n  c: 2",
  "- a\nb: c",
  "a: b: c",
  "a:\n  - b\n  c: d",
  "a: - b",
  "a\nb: c",
  "\"a\nb\": c",
  "a: 'unclosed",
  "a: \"unclosed",
  "a: [unclosed",
  "a: {unclosed: 1",
  "a: ]",
  "a: }",
  "]",
  "}",
  "a: b\n]",
  "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx: y",
  "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx: y",
  "a: 'b'c",
  "a: \"b\"c",
  "a:b",
  "a :b",
  "- -x",
  "-x",
  "--x: 1",
  "? ? x",
  "a: !!str",
  "a: &x",
  "&x",
  "!!str",
  "*x",
  "a: b #c\n#d\nc: e",
  "#c\na: 1 # c2\n# c3",
  "a: # c\n  b",
  "a: [ # c\n 1 ]",
  "a: { # c\n b: 1 }",
  "a:   \n  b",
  "- # c\n  a",
  "a: 1 #c\n  #d\n",
  "a:\n  - b\n  -\n  - c",
  "- \n- a",
  "-\n-\n",
  "a:\n  -\n    b: 1",
  "a: |\nb: 1",
  "a: >-\n\nb: c",
  "key with spaces: v",
  "\"quoted key\": v",
  "'single': v",
  "a: 1\r\nb: 2\r\n",
  "a: |\r\n  x\r\n  y\r\n",
  "a: \"x\r\n  y\"",
  "a: [1,\r\n 2]",
  "a: b\r\n  c\r\n",
  "a: 1\rb: 2",
  "\u00e9: \u00fc",
  "\u65e5\u672c: \u8a9e",
  "emoji: \ud83d\ude00",
  "\ud83d\ude00: x",
  "a: \u2028b",
  "a: \u0085b",
  "a: \u200bzw",
  "a: \"\\u2028\"",
  "a: caf\u00e9 au lait",
  "b: 1\n2: x\n1: y\na: z",
  "__proto__: x",
  "toString: x\nconstructor: y\nhasOwnProperty: z",
  "__proto__: {a: 1}",
  "\"__proto__\": [1]",
  "1: a\ntrue: b\nnull: c\n~: d\n: e\n1.5: f\n1e3: g\n.inf: h\n.nan: i\n-0: j\n0x10: k\n0o10: l\n\"\": m",
  "name: \"a:b\"",
  "name: nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn",
  "name: nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn",
  "name: 123",
  "name: [a]",
  "name:\n  x: 1",
  "name: !!str 5",
  "name: \"\ud83d\ude00\"",
  "a: [[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[x]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]",
  "a: [[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[x]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]",
  null, // #421: generated below
  null, // #422: generated below
  null, // #423: generated below
  null, // #424: generated below
  "a: {a: {a: {a: {a: {a: {a: {a: {a: {a: {a: {a: {a: {a: {a: {a: {a: {a: {a: {a: {a: {a: {a: {a: {a: {a: {a: {a: {a: {a: {a: {a: {a: {a: {a: {a: {a: {a: {a: {a: {a: {a: {a: {a: {a: {a: {a: {a: {a: {a: {a: {a: {a: {a: {a: {a: {a: {a: {a: {a: {a: {a: {a: {a: {a: {a: {a: {a: {a: {a: {a: {a: {a: {a: {a: {a: {a: {a: {a: {a: {a: x}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}",
  "[0x1F, 0o17, 1e3, 1.50, -1.0, 1.0, -0.0, .5e-7, 1e400, 0x0, 0o0]: x",
  "[!!float 1.50, !!int 0x10, !foo 1.50, 12e+2]: x",
  "%YAML 1.1\n---\n[0b101, -0b11, 017, -017, 0x1F, -0x1F, 1:30, 1:30:15, -1:30.5, 190:20:30.15, 1_000.500, 1.5e+3, .inf]: x",
  "%YAML 1.1\n---\n[1_0.0_0, !!int 1:30, !!float 1:30.0, 0b0, 123456789012345678901234567890]: x",
  "[0x123456789ABCDEF0123, 123456789012345678901234567890, 1e21, 1.5e300]: x",
  "[{[a]: b}]: x",
  "[{[a]: [c, d]}]: x",
  "[{[a]}]: x",
  "{[a]: b}: x",
  "[[aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa, bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb], c]: x",
  "[{a: b, c: {d: e}}]: x",
  "[a, # c1\n b]: x",
  "[a #c\n, b]: x",
  "{a: 1, # c\n b: 2}: x",
  "[\n  a,\n\n  b\n]: x",
  "{a: #c\n  b}: x",
  "{? a #k\n : b}: x",
  "[a, b] #after\n: x",
  "? [a, #x\n  b]\n: y",
  "? {a: [1, 2], b: {c: d}} #z\n: y",
  "[\"word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word \"]: x",
  "[word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word ]: x",
  "['w'd w'd w'd w'd w'd w'd w'd w'd w'd w'd w'd w'd w'd w'd w'd w'd w'd w'd w'd w'd w'd w'd w'd w'd w'd w'd w'd w'd w'd w'd ']: x",
  "[\"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\\nyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy\"]: x",
  "[\"a\\nb\"]: x",
  "[\"ppppppppppppppppppppppppp\\n\\nqqqqqqqqqqqqqqqqqqqqqqqqq\"]: x",
  "[\"ppppppppppppppppppppppppp\\n qqqqqqqqqqqqqqqqqqqqqqqqq\"]: x",
  "[\"ppppppppppppppppppppppppp \\nqqqqqqqqqqqqqqqqqqqqqqqqq\"]: x",
  "[\"\\x01\\x01\\x01\\x01\\x01\\x01\\x01\\x01\\x01\\x01\\x01\\x01\\x01\\x01\\x01\\x01\\x01\\x01\\x01\\x01\\x01\\x01\\x01\\x01\\x01\\x01\\x01\\x01\\x01\\x01\\x01\\x01\\x01\\x01\\x01\\x01\\x01\\x01\\x01\\x01\"]: x",
  "[\"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\"]: x",
  "[yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy]: x",
  "[a\n\n  b]: x",
  "[|\n  lit\n  two\n]: x",
  "[>\n  fold\n]: x",
  "['a\n\n  b']: x",
  "[!foo 5, !!str 5, ! 5, !!null 5, !!bool 5, !!int 1.5, !!float 5, !!int abc, !!map 5, !!seq x, !<tag:x> y]: x",
  "%TAG !e! tag:example.com,2000:\n---\n[!e!foo 1, !e!b%21r x, !<tag:example.com,2000:z> q, !!str s]: x",
  "%TAG !! tag:other:\n---\n[!!str x]: y",
  "[! [a], !!seq [b], !!map {c: d}, !!seq {e: f}, !foo [g], !!int [h], !!str {i: j}, !!null [k], !!bool [l]]: x",
  "[!!binary aGVsbG8=, !!binary \"aGk=\", !!binary |\n  aGk=\n]: x",
  "[!!binary QUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJD]: x",
  "[!!timestamp 2001-12-14, !!timestamp 2001-12-14t21:59:43.10-05:00]: x",
  "[!!set {a, b}, !!omap [{a: 1}], !!pairs [{a: 1}, {a: 2}], !!omap [{}]]: x",
  "[!!binary x, !!binary {a: 1}, !!timestamp 2001-01-01, !!timestamp [a], !!merge <<, !!merge {b}]: x",
  "[!!set x]: y\n!!set {a}: z",
  "- !!set {a}\n- [!!set x]: y",
  "[&a x, *a, &b [y], *b]: x",
  "[&a1 x, &a2 {k: v}]: x",
  "{&k a: &v b}: x",
  "%YAML 1.1\n---\n[<<, !!merge <<, yes, No, ~, 1:30, 0x1F]: x",
  "%YAML 1.1\n---\nbase: &b {k: v}\n[{<<: *b}]: x",
  "{<<: &a {b: 1}, [{<<: *a}]: x}",
  "%YAML 1.1\n---\n{<<: &a {b: 1}, [{<<: *a}]: x}",
  "%YAML 1.1\n---\n- &a {b: 1}\n- {[{<<: *a}]: x}",
  "[\"--- a\", '... b', \"%c\", --- d]: x",
  "[{\"--- a\": b}]: x",
  "[[\"--- a\"]]: x",
  "[\"a: b\", 'it''s', \"say \\\"hi\\\"\", \"both ' \\\"\", \"tab\\there\", \"\\u00a0\\u2028\\u0085\\u001b\"]: x",
  "[k0, k1, k2, k3, k4, k5, k6, k7, k8, k9, k10, k11, k12, k13, k14, k15, k16, k17, k18, k19, k20, k21, k22, k23, k24, k25, k26, k27, k28, k29]: x",
  "{k0: v0, k1: v1, k2: v2, k3: v3, k4: v4, k5: v5, k6: v6, k7: v7, k8: v8, k9: v9, k10: v10, k11: v11, k12: v12, k13: v13, k14: v14}: x",
  "[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[word word word word word word word word word word word word word word word word word word word word ]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]: x",
  "[\"\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\"]: x",
  "[\"ab \\tab \\tab \\tab \\tab \\tab \\tab \\tab \\tab \\tab \\tab \\tab \\tab \\tab \\tab \\tab \\tab \\tab \\tab \\tab \\tab \\tab \\tab \\tab \\tab \\t\"]: x",
  "[\"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\\u2029yyyyyyyyyyyyyyyyyyyy\"]: x",
  "[{a: \"word word word word word word word word word word word word word word word word word word word word \"}]: x",
  "[{kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk: \"v v v v v v v v v v v v v v v v v v v v \"}]: x",
  "[{a: [\"z z z z z z z z z z z z z z z z z z z z z z z z z z z z z z z z z z z z z z z z z z z z z z z z z z \"]}]: x",
  "[&anchor !!str \"w w w w w w w w w w w w w w w w w w w w w w w w w w w w w w w w w w w w w w w w w w w w w \"]: x",
  "%YAML 1.1\n---\n[\"<<\", '<<', <<]: x",
  "[\"<<\", <<]: x",
  "[\"<<\", <<, !!merge <<]: x",
  "[\"<<\"]: x\n!!merge <<: {a: 1}",
  // A seq item whose value starts on a later line has no blank line before it.
  "? - a\n  -\n\n    b\n: 1\n",
  "? - a\n  -\n    b\n: 1\n",
  "? [a,\n\n  b]\n: 1\n",
  // After a `:` or `?` indicator, a blank line does count.
  "? a:\n\n    b\n: 1\n",
  "? ?\n\n    k\n  : v\n: 1\n",
  "? {a:\n\n  b}\n: 1\n",
  // CRLF blank lines ahead of a block scalar's first line.
  "a: |\r\n\r\n  x\r\n",
  "a: >\r\n  \r\n  x\r\n  y\r\n",
  "- |\r\n\r\n\r\n   z\r\n",
  "? |\r\n\r\n  k\r\n: v\r\n",
];
HAND[211] = `a: &a []\n${Array.from({ length: 300 }, (_, i) => `b${i}: *a`).join("\n")}`;
const HAND_DEEP = { 421: ["flow", 3000], 422: ["blockMap", 60], 423: ["blockMap", 3000], 424: ["blockSeq", 40] };
/** Past this depth node's stack, and so yaml's errors, vary run to run. */
const STABLE_DEPTH = 500;

const FRAGS = ["a", "b", "key", "1", "-1", "0x1F", "1.5", ".inf", "~", "null", "true", "yes", "x y", ":", " : ", ": ",
  "- ", "-", "? ", "?", "[", "]", "{", "}", ",", ", ", "#c", " #c", "\n", "\n  ", "\n    ", "\n- ", "\n  - ", "  ", "\t",
  "&a ", "*a", "&b ", "*b", "!!str ", "!!int ", "!foo ", "!!set ", "!!omap ", "!!merge ", "<<", "'q'", '"d"', "'it''s'",
  '"\\n"', "|", "|-", "|+", ">", ">-", "|2", "---", "...", "\n---\n", "\n...\n", "%YAML 1.1\n", "%TAG !e! tag:x:\n",
  "!e!t ", cp(0xe9), cp(0x1f600), "\r\n", '"\\x41"', "@", "`", "%", "!!binary ", "aGk=", "2001-12-14", "!!timestamp ",
  '"a b"', "'a\nb'", '"a\n  b"'];

function fuzzFragments(seed, n, structured) {
  const r = rng(seed);
  const outCases = [];
  for (let k = 0; k < n; k++) outCases.push(Array.from({ length: int(r, 1, 14) }, () => pick(r, FRAGS)).join(""));
  const gen = (d) => {
    const x = r();
    if (d > 3 || x < 0.4) {
      return pick(r, ["a", "1", "~", "true", "'s'", '"d"', "*a", "&a x", "!!str 5", "[a, b]", "{a: 1}", "|\n  t\n", "x: y"]);
    }
    if (x < 0.7) {
      const items = Array.from({ length: int(r, 0, 3) }, () => `${pick(r, ["k", "l", "1", "*a", "&a m", "? x"])}: ${gen(d + 1)}`);
      return `{${items.join(", ")}}`;
    }
    return `[${Array.from({ length: int(r, 0, 3) }, () => gen(d + 1)).join(", ")}]`;
  };
  for (let k = 0; k < structured; k++) {
    const ls = Array.from({ length: int(r, 1, 4) }, () => {
      const ind = "  ".repeat(int(r, 0, 2));
      return `${ind}${pick(r, ["k", "<<", "- ", "? ", "name", "1"])}${pick(r, [": ", ":", " : ", ""])}${gen(0)}`;
    });
    outCases.push(ls.join("\n"));
  }
  return outCases;
}

// Collection keys: what the stringifier has to name.
function fuzzKeys(seed, n) {
  const r = rng(seed);
  const atoms = ["a", "bb", "1", "-2", "0x1F", "1.50", "1e3", ".inf", "~", "null", "true", "yes", "<<", "'q'", '"d"',
    '"a\\nb"', "'it''s'", '"\\x01"', '"\\u2028"', "*a", "&a x", "&b y", "!!str 5", "!foo z", "! w", "!!binary aGk=",
    "!!timestamp 2001-12-14", "!!null", '"--- m"', "'%p'", "w".repeat(35), "word ".repeat(12), `"${"q ".repeat(30)}"`,
    "|\n    lit\n", cp(0xe9), cp(0x1f600), "x # c", ""];
  const gen = (d) => {
    const x = r();
    if (d > 3 || x < 0.45) return pick(r, atoms);
    const sep = pick(r, [", ", ",\n  ", ", # cm\n  ", ",\n\n  "]);
    const k = int(r, 0, 4);
    if (x < 0.75) {
      const keys = ["k", "? x", "[a]", "{b: c}", "*a", "&a m", '"q"', "w".repeat(30)];
      const items = Array.from({ length: k }, () => (r() < 0.8 ? `${pick(r, keys)}: ${gen(d + 1)}` : gen(d + 1)));
      return `{${items.join(sep)}}`;
    }
    return `[${Array.from({ length: k }, () => gen(d + 1)).join(sep)}]`;
  };
  const outCases = [];
  for (let c = 0; c < n; c++) {
    const head = pick(r, ["", "%YAML 1.1\n---\n", "%TAG !e! tag:e:\n---\n"]);
    const ls = Array.from({ length: int(r, 1, 3) }, () => {
      let k = r() < 0.7 ? gen(1) : pick(r, ["k", "<<", "&a base"]);
      if (!(k.startsWith("[") || k.startsWith("{"))) k = `[${k}]`;
      return r() < 0.3 ? `? ${k}\n: ${gen(2)}` : `${k}: ${gen(2)}`;
    });
    outCases.push(head + ls.join("\n"));
  }
  return outCases;
}

const LONE = /\\ud[89a-f][0-9a-f]{2}/;
function yamlCase(src, deep) {
  const doc = YAML.parseDocument(src);
  let result;
  try {
    const v = YAML.parse(src);
    try {
      const j = JSON.stringify(v);
      result = j === undefined ? "undefined" : { json: j };
    } catch {
      result = "circular";
    }
  } catch {
    result = "throws";
  }
  if (typeof result === "object" && LONE.test(result.json)) return null;
  const key = deep ? { deep: deep[0], n: deep[1] } : src;
  if (deep && deep[1] > STABLE_DEPTH) return [key, null, null, null, result];
  const multipleDocs = doc.errors.some((e) => e.code === "MULTIPLE_DOCS");
  if (multipleDocs) return [key, null, null, true, result];
  return [key, doc.errors.map((e) => e.code), doc.warnings.map((e) => e.code), false, result];
}

const warn = console.warn;
console.warn = () => {};
const yaml = [];
HAND.forEach((src, i) => {
  const deep = HAND_DEEP[i];
  const c = yamlCase(deep ? DEEP[deep[0]](deep[1]) : src, deep);
  if (c) yaml.push(c);
});
for (const src of [...fuzzFragments(1, 700, 300), ...fuzzKeys(2, 600)]) {
  const c = yamlCase(src, null);
  if (c) yaml.push(c);
}
console.warn = warn;

// -------------------------------- collation --------------------------------

const LATIN = [];
for (let c = 0xc0; c <= 0x24f; c++) {
  if (/^[A-Za-z][\u0300-\u036f]+$/.test(cp(c).normalize("NFD"))) LATIN.push(cp(c));
}
const PRINTABLE = Array.from({ length: 0x5f }, (_, i) => cp(0x20 + i));
const CONTROLS = ["\t", "\n", "\r", "\u000b", "\u000c", "\u0001", "\u001f", "\u007f", "\u0000"];
const MARKS = Array.from({ length: 0x70 }, (_, i) => cp(0x300 + i));
const LETTERS = [..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"];
const names = [
  "", "a", "A", "ab", "aB", "Ab", "a-b", "ab-", "a_b", "a.b", "a1", "a10", "a2", cp(0xe9), "e", "E", "f", cp(0xc9), "ea",
  `${cp(0xe9)}a`, "eb", "-a", "_a", ".a", "a-", "A-", `e${cp(0x301)}`, `a${cp(0x301)}${cp(0x327)}`, `a${cp(0x327)}${cp(0x301)}`,
  `${cp(0xe9)}${cp(0x327)}`, `e${cp(0x327)}${cp(0x301)}`, `a${cp(0x344)}`, `a${cp(0x308)}${cp(0x301)}`,
  `a${cp(0x301)}${cp(0x34f)}${cp(0x327)}`, `a${cp(0x327)}${cp(0x34f)}${cp(0x301)}`, "a\u0001", "a\u0000b", "ab\u007f",
  ...PRINTABLE, ...CONTROLS, ...LATIN, ...MARKS.map((m) => `a${m}`),
];
{
  const r = rng(3);
  for (let k = 0; k < 500; k++) {
    let s = "";
    for (let n = int(r, 0, 6); n > 0; n--) {
      const x = r();
      s += pick(r, x < 0.45 ? LETTERS : x < 0.6 ? PRINTABLE : x < 0.68 ? CONTROLS : x < 0.84 ? LATIN : MARKS);
    }
    names.push(s);
  }
}
const order = names.map((_, i) => i).sort((a, b) => names[a].localeCompare(names[b]));
const pairs = [];
{
  const r = rng(4);
  for (let k = 0; k < 2500; k++) {
    const i = int(r, 0, names.length - 1);
    const j = int(r, 0, names.length - 1);
    pairs.push([i, j, Math.sign(names[i].localeCompare(names[j]))]);
  }
}

// ------------------------------- frontmatter -------------------------------

const BOM = cp(0xfeff);
const FRONTMATTER = [
  "", "no frontmatter", "---", "---\n", "---\n---", "---\n---\n", "---\n\n---\n", "---\n\n---", "---\nname: a\n---\nbody",
  "---\r\nname: a\r\n---\r\nbody\r\n", `${BOM}---\nname: a\n---\nb`, `${BOM}${BOM}---\nname: a\n---\nb`, "---\nname: a\n---",
  "---\nname: a\n---x\ny", "---\nname: a\n--- \ny", "---\nname: a\n---\r\r\nz", "---\nname: a\n---\n\nbody",
  "---\na: 1\n---\nb: 2\n---\nbody", "--- \nname: a\n---\n", "---\n- a\n- b\n---\nbody", "---\n5\n---\n", "---\n'str'\n---\n",
  "---\nnull\n---\n", "---\n: bad: yaml: [\n---\nbody", "---\nname: x:y\n---\n", "---\nname: [a]\n---\n", "---\nname: 5\n---\n",
  "---\nname: !!str 5\n---\n", `---\nname: ${"n".repeat(300)}\n---\n`, '---\nname: "\\U0001F600"\n---\n',
  "---\na: &x [*x]\n---\nbody", "---\na: !!binary aGk=\n---\n", "---\na: 2001-12-14\n---\n", "---\n%YAML 1.1\n---\na: 1\n---\n",
  "---\nmcpServers:\n  srv:\n    command: x\n---\nbody", "---\ntools: [Read, Grep]\ndescription: >\n  folded\n  text\n---\n",
  "---\nb: 1\n2: x\n1: y\n---\n", "---\n__proto__: x\n---\n", "---\nname: a\n...\n---\n", "---\nname: a\n---\n---\nmore",
  "x\n---\nname: a\n---\n", "---\r\nname: a\n---\n", "---\nname: a\r\n---\r\nbody", "\n---\nname: a\n---\n",
  `---\ndescription: caf${cp(0xe9)} ${cp(0x2603)}\n---\n${cp(0xfc)}ber`, "---\nname: a\n---\n\r\n", "---\r\n---\r\n\r\n",
  "---\nname: 'it''s'\nmodel: opus\nmaxTurns: 1.0\neffort: 1e3\n---\nprompt", "---\nname: a\nname: b\n---\n",
  "---\n? [a, b]\n: c\n---\n", "---\n{a: 1}\n---\n", "---\n!!set {a}\n---\n", "---\n!!omap [a: 1]\n---\n",
  "---\nname: ~\n---\n", "---\n\tname: a\n---\n", "---\nname: a # c\n---\n#body", "---\n---\n---\n",
];
const frontmatter = FRONTMATTER.map((raw) => {
  const p = agents.parseFrontmatter(raw);
  let fm;
  try {
    fm = JSON.stringify(p.frontmatter);
  } catch {
    fm = "circular";
  }
  const name = p.frontmatter && typeof p.frontmatter.name === "string" ? p.frontmatter.name : null;
  return { raw, frontmatter: fm, name, body: p.body };
});

// ------------------------------- shared steps -------------------------------

const hex = (s) => Buffer.from(s, "utf8").toString("hex");

/** One filesystem setup, as the Rust tests run it too. */
function fsAction([op, a, b]) {
  if (op === "mkdir") mkdirSync(unplace(a), { recursive: true });
  else if (op === "write") writeFileSync(unplace(a), Buffer.from(b, "hex"));
  else if (op === "chmod") chmodSync(unplace(a), b);
  else if (op === "symlink") symlinkSync(unplace(b), unplace(a));
  else if (op === "rm") rmSync(unplace(a), { recursive: true, force: true });
  else throw new Error(`fs op ${op}`);
}

/** Every entry under `dir` (a placeholder path): `["d", path]`,
 * `["l", path, target]`, `["f", path, hex]`, in `sort()` order. */
function tree(dir) {
  const outEntries = [];
  const walk = (d, rel) => {
    let entries;
    try {
      entries = readdirSync(d).sort();
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e);
      const r = `${rel}/${e}`;
      const st = lstatSync(p);
      if (st.isSymbolicLink()) outEntries.push(["l", r, place(readlinkSync(p))]);
      else if (st.isDirectory()) {
        outEntries.push(["d", r]);
        walk(p, r);
      } else outEntries.push(["f", r, readFileSync(p).toString("hex")]);
    }
  };
  walk(unplace(dir), dir);
  return outEntries;
}

const NOW = 1234567890123;
const realNow = Date.now;
async function pinned(fn) {
  Date.now = () => NOW;
  try {
    return await fn();
  } finally {
    Date.now = realNow;
  }
}
const nowed = (s) => s.split(`"updatedAt":${NOW}`).join('"updatedAt":"$NOW"');

const dbFile = (cwd) => join(HOME, ".claude", "projects", unplace(cwd).replace(/[^A-Za-z0-9]/g, "-"), ".claudius.db");
function runSql(cwd, sql) {
  const p = dbFile(cwd);
  mkdirSync(dirname(p), { recursive: true });
  const d = new Database(p);
  try {
    d.exec(sql);
  } finally {
    d.close();
  }
}
function dbRows(cwd) {
  const d = new Database(dbFile(cwd), { readonly: true });
  try {
    return d
      .prepare("SELECT quote(name) AS n, quote(definition_json) AS d, quote(updated_at) AS u FROM db_agents ORDER BY rowid")
      .all()
      .map((r) => [r.n, r.d, r.u === String(NOW) ? "$NOW" : r.u]);
  } finally {
    d.close();
  }
}

function jsonOrCircular(v) {
  try {
    return place(JSON.stringify(v));
  } catch {
    return "circular";
  }
}

// ---------------------------------- files ----------------------------------

const N = (n) => "n".repeat(n);
const X = (n) => "x".repeat(n);
const fm = (name) => `---\nname: ${name}\ndescription: d\n---\nbody\n`;
const W = (scope, cwd, name, raw) => ({ op: "write", scope, cwd, name, raw });
const R = (scope, cwd, name) => ({ op: "read", scope, cwd, name });
const L = (scope, cwd) => ({ op: "list", scope, cwd });
const D = (scope, cwd, name) => ({ op: "delete", scope, cwd, name });
const F = (...actions) => ({ op: "fs", actions });
const EMOJI = cp(0x1f600);

const FILE_STEPS = [
  F(["rm", "$HOME/.claude"]),
  { op: "dir", scope: "user", cwd: "$CWD" },
  { op: "dir", scope: "project", cwd: "$CWD" },
  { op: "dir", scope: "project", cwd: "$CWD/x/../y/./" },
  { op: "path", scope: "user", cwd: "$CWD", name: "a" },
  { op: "path", scope: "project", cwd: "$CWD", name: "..." },
  { op: "path", scope: "project", cwd: "$CWD", name: ".." },
  { op: "path", scope: "project", cwd: "$CWD", name: "a b" },
  { op: "path", scope: "project", cwd: "$CWD", name: "" },
  L("user", "$CWD"),
  L("project", "$CWD"),
  W("project", "$CWD", J("a"), fm("a")),
  W("user", "$CWD", J("u1"), "user agent"),
  ...[
    J("b.x"), J("-dash"), J(".."), J("."), J("..."), J("_"), "5", "1.5", "true", "false", "null", "-5", "0.000001", "1e-7",
    J(["arr"]), J([["deep"]]), J(["a", "b"]), "{}", "[]", "[null]", "[1,[2]]", J("a b"), J("a/b"), J("../x"), J(cp(0xe9)),
    J("a:b"), J(""), "1e21", "123456789012345678901234", J(X(252)), J(X(253)), J(X(256)), J(X(257)), J([X(300)]),
    J(cp(0xe9).repeat(300)), "1e400", "-1e400", "[1e400]",
  ].map((name) => W("project", "$CWD", name, "raw\n")),
  W("project", "$CWD", J("colon"), fm("x:y")),
  W("project", "$CWD", J("a b"), fm("x:y")),
  W("project", "$CWD", J(X(257)), fm("x:y")),
  W("project", "$CWD", J(X(257)), fm(N(257))),
  W("project", "$CWD", J("fm257"), fm(N(257))),
  W("project", "$CWD", J("fm256"), fm(N(256))),
  W("project", "$CWD", J("emoji129"), fm(EMOJI.repeat(129))),
  W("project", "$CWD", J("emoji128"), fm(EMOJI.repeat(128))),
  W("project", "$CWD", J("fmnum"), "---\nname: 5\n---\n"),
  W("project", "$CWD", J("fmlist"), "---\nname: [a:b]\n---\n"),
  W("project", "$CWD", J("fmbad"), "---\nname: [\n---\n"),
  W("project", "$CWD", J("fmquoted"), '---\nname: "a\\x3ab"\n---\n'),
  W("project", "$CWD", J("a"), `${BOM}---\r\nname: a\r\ndescription: again\r\n---\r\nnew body ${EMOJI}\r\n`),
  R("project", "$CWD", "a"),
  R("project", "$CWD", "missing"),
  R("project", "$CWD", "a b"),
  R("project", "$CWD", ".."),
  R("user", "$CWD", "u1"),
  L("user", "$CWD"),
  L("project", "$CWD"),
  // ENOTDIR: a file where `.claude` should be.
  F(["mkdir", "$CWD/e1"], ["write", "$CWD/e1/.claude", hex("x")]),
  W("project", "$CWD/e1", J("x"), "raw"),
  L("project", "$CWD/e1"),
  R("project", "$CWD/e1", "x"),
  D("project", "$CWD/e1", "x"),
  // EEXIST: a file where `agents` should be.
  F(["mkdir", "$CWD/e2/.claude"], ["write", "$CWD/e2/.claude/agents", hex("x")]),
  W("project", "$CWD/e2", J("x"), "raw"),
  L("project", "$CWD/e2"),
  // EISDIR: a directory where the file should be.
  F(["mkdir", "$CWD/e3/.claude/agents/x.md"]),
  W("project", "$CWD/e3", J("x"), "raw"),
  R("project", "$CWD/e3", "x"),
  D("project", "$CWD/e3", "x"),
  L("project", "$CWD/e3"),
  // EACCES: a read-only agents dir.
  F(["mkdir", "$CWD/e4/.claude/agents"], ["write", "$CWD/e4/.claude/agents/z.md", hex("old")], ["chmod", "$CWD/e4/.claude/agents", 0o555]),
  W("project", "$CWD/e4", J("y"), "raw"),
  W("project", "$CWD/e4", J("z"), "overwritten"),
  D("project", "$CWD/e4", "z"),
  L("project", "$CWD/e4"),
  F(["chmod", "$CWD/e4/.claude/agents", 0o755]),
  // An unreadable file.
  F(["mkdir", "$CWD/e5/.claude/agents"], ["write", "$CWD/e5/.claude/agents/r.md", hex("secret")], ["write", "$CWD/e5/.claude/agents/s.md", hex("ok")], ["chmod", "$CWD/e5/.claude/agents/r.md", 0]),
  L("project", "$CWD/e5"),
  R("project", "$CWD/e5", "r"),
  W("project", "$CWD/e5", J("r"), "raw"),
  F(["chmod", "$CWD/e5/.claude/agents/r.md", 0o644]),
  // A dangling symlink for the agents dir, then one to a real dir.
  F(["mkdir", "$CWD/e6/.claude"], ["symlink", "$CWD/e6/.claude/agents", "$CWD/e6/missing"]),
  W("project", "$CWD/e6", J("x"), "raw"),
  L("project", "$CWD/e6"),
  R("project", "$CWD/e6", "x"),
  F(["mkdir", "$CWD/e7/.claude"], ["mkdir", "$CWD/e7target"], ["symlink", "$CWD/e7/.claude/agents", "$CWD/e7target"]),
  W("project", "$CWD/e7", J("x"), "through a link"),
  L("project", "$CWD/e7"),
  // A dangling symlink for `.claude`: mkdir finds it and can't go through.
  F(["mkdir", "$CWD/e8"], ["symlink", "$CWD/e8/.claude", "$CWD/e8/missing"]),
  W("project", "$CWD/e8", J("x"), "raw"),
  F(["mkdir", "$CWD/e9"], ["write", "$CWD/e9/file", hex("x")], ["symlink", "$CWD/e9/.claude", "$CWD/e9/file"]),
  W("project", "$CWD/e9", J("x"), "raw"),
  // A missing project dir, and one under a read-only parent.
  W("project", "$CWD/missing/deeper", J("x"), "raw"),
  F(["mkdir", "$CWD/ro"], ["chmod", "$CWD/ro", 0o555]),
  W("project", "$CWD/ro/p", J("x"), "raw"),
  F(["chmod", "$CWD/ro", 0o755]),
  // What a listing picks and how it sorts.
  F(
    ["mkdir", "$CWD/l/.claude/agents/dir.md"],
    ...[".md", "a.md", "b.MD", "Zed.md", "zed2.md", "_x.md", "-x.md", "x-.md", "a\u0001.md", "a b.md", `${cp(0xe9)}t${cp(0xe9)}.md`,
      "ete.md", `e${cp(0x301)}x.md`, "10.md", "9.md", "a.md.md", "noext", "new\nline.md", `${cp(0xc9)}cole.md`, "ecole.md"].map(
      (n) => ["write", `$CWD/l/.claude/agents/${n}`, hex(`---\nname: ${J(n)}\n---\n${n}`)],
    ),
    ["write", "$CWD/l/.claude/agents/bad-utf8.md", "2d2d2d0a6e616d653a2078ff0a2d2d2d0a62c3"],
    ["write", "$CWD/l/.claude/agents/bom.md", hex(`${BOM}---\nname: bom\n---\nb`)],
    ["symlink", "$CWD/l/.claude/agents/link.md", "$CWD/l/.claude/agents/a.md"],
    ["symlink", "$CWD/l/.claude/agents/dangling.md", "$CWD/l/.claude/agents/none"],
  ),
  L("project", "$CWD/l"),
  // Names that collate equal (ignorable characters) keep scandir's strcmp
  // order: the sort is stable.
  F(
    ["mkdir", "$CWD/eq/.claude/agents"],
    ...["q", "q\u0001", "q\u0002", "q\u0003", "q\u0004", "q\u0005", "q\u0006", "q\u0007", "q\u0008", "\u0001q", "\u0002q",
      "\u0003q", `q${cp(0x34f)}`, `${cp(0x34f)}q`, "q\u007f", "\u007fq"].map(
      (n) => ["write", `$CWD/eq/.claude/agents/${n}.md`, hex("---\nname: x\n---\n")],
    ),
  ),
  L("project", "$CWD/eq"),
  R("project", "$CWD/l", "link"),
  R("project", "$CWD/l", "bad-utf8"),
  R("project", "$CWD/l", "dir"),
  // A frontmatter that JSON.stringify can't write.
  F(["mkdir", "$CWD/c/.claude/agents"], ["write", "$CWD/c/.claude/agents/cyc.md", hex("---\na: &x [*x]\n---\nbody")]),
  L("project", "$CWD/c"),
  R("project", "$CWD/c", "cyc"),
  D("project", "$CWD", "a"),
  D("project", "$CWD", "a"),
  D("project", "$CWD", "a b"),
  D("project", "$CWD", "..."),
  D("user", "$CWD", "u1"),
  D("project", "$CWD/l", "dir"),
  D("project", "$CWD/l", "link"),
  L("user", "$CWD"),
];

async function fileStep(step) {
  const cwd = step.cwd ? unplace(step.cwd) : undefined;
  try {
    switch (step.op) {
      case "fs":
        step.actions.forEach(fsAction);
        return null;
      case "dir":
        return place(agents.agentsDir(step.scope, cwd));
      case "path":
        return place(agents.agentPath(step.scope, cwd, step.name));
      case "write":
        await agents.writeAgent(step.scope, cwd, JSON.parse(step.name), step.raw);
        return "ok";
      case "read": {
        const f = await agents.readAgent(step.scope, cwd, step.name);
        return f === null ? null : jsonOrCircular(f);
      }
      case "list":
        return jsonOrCircular(await agents.listAgents(step.scope, cwd));
      case "delete":
        return await agents.deleteAgent(step.scope, cwd, step.name);
    }
  } catch (e) {
    // The message is what a route answers with (write) or Next's 500 hides.
    return { threw: step.op === "write" || step.op === "path" ? place(e.message) : true };
  }
  throw new Error(step.op);
}

const fileSteps = [];
for (const step of FILE_STEPS) fileSteps.push({ ...step, result: await fileStep(step) });
const files = { steps: fileSteps, tree: [...tree("$CWD"), ...tree("$HOME/.claude")] };
rmSync(join(HOME, ".claude"), { recursive: true, force: true });

// ----------------------------------- db -----------------------------------

const DEF = { description: "d", prompt: "p" };
const NAMES = [J("a"), J(""), J("a b"), J(N(256)), J(N(257)), J(cp(0xe9)), J(cp(0xe9).repeat(257)), J(EMOJI.repeat(128)),
  J(EMOJI.repeat(129)), J("a.b-c_d"), J(".."), "5", "null", "true", J(["a"]), "{}", "1e400", J("a:b")];
const nameChecks = NAMES.map((text) => {
  const v = JSON.parse(text);
  let asserted = null;
  try {
    dbAgents.assertValidAgentName(v);
  } catch (e) {
    asserted = e.message;
  }
  return { name: text, valid: dbAgents.isValidAgentName(v), asserted };
});

const FULL_DEF = J({
  prompt: "p", description: "d", tools: ["Read", 5, null, "Grep", ["x"]], disallowedTools: "Bash",
  skills: ["a", "b:c", "*", "a b", "a:b:c", "_x", "-x", "x.y-z", "k:", cp(0xe9), 5, ":s", "a::b", "p.q:r-s", "A9_"],
  model: "opus", initialPrompt: "go", maxTurns: 3, autoCompactWindow: 1000, background: true, omitClaudeMd: false,
  memory: "user", effort: "high", permissionMode: "plan", extra: 1,
});
const COERCE = [
  "null", "5", J("s"), "[]", J([DEF]), "{}", "true", J({ description: "d" }), J({ prompt: "p" }),
  J({ description: "", prompt: "p" }), J({ description: "  ", prompt: "p" }), J({ description: "d", prompt: "  \n" }),
  J({ description: "\u00a0d\ufeff", prompt: "p" }), J({ description: "\u0085d", prompt: "p" }),
  J({ description: "\u200bd", prompt: "p" }), J({ description: "\u2028d\u3000", prompt: "\t" }),
  J({ description: 5, prompt: "p" }), J({ description: "d", prompt: 5 }), J({ description: "d", prompt: ["p"] }),
  J({ description: " d ", prompt: " p " }),
  '{"description":1e400,"prompt":"p"}',
  '{"description":"say \\"1e400\\" -1e400 \\\\","prompt":"p","model":"\\\\\\"1e999"}',
  '{"description":"d","prompt":-1e400}',
  '{"description":"d","prompt":"p","model":1e400,"initialPrompt":1e400,"memory":1e400,"permissionMode":1e400}',
  FULL_DEF,
  ...["0", "-1", "1.5", "1.0", "1e21", "1e400", "-1e400", '"3"', "null", "true", "-0", "1e-7"].map(
    (v) => `{"description":"d","prompt":"p","maxTurns":${v}}`,
  ),
  ...["0", "-5", "1e400", "0.5", '"100"', "1e21", "-0", "1.0"].map(
    (v) => `{"description":"d","prompt":"p","autoCompactWindow":${v}}`,
  ),
  ...['"true"', "1", "false", "null"].map((v) => `{"description":"d","prompt":"p","background":${v},"omitClaudeMd":${v}}`),
  ...['"global"', '"local"', '"project"', "null", '"User"'].map((v) => `{"description":"d","prompt":"p","memory":${v}}`),
  ...['"XHIGH"', '"max"', "2.5", "-0", "1e400", "true", '"low"', '"medium"', '"xhigh"', "0", '""'].map(
    (v) => `{"description":"d","prompt":"p","effort":${v}}`,
  ),
  ...['"auto"', '"dontAsk"', '"bogus"', '"bypassPermissions"', '"acceptEdits"', '"default"', '"plan"', "1"].map(
    (v) => `{"description":"d","prompt":"p","permissionMode":${v}}`,
  ),
  ...["[]", '"Read"', '{"0":"x"}', "[1e400]"].map((v) => `{"description":"d","prompt":"p","tools":${v},"skills":${v}}`),
  '{"description":"a","description":"b","prompt":"p"}',
  '{"__proto__":{"description":"d","prompt":"p"}}',
  '{"description":"d","prompt":"p","__proto__":{"model":"x"}}',
  J({ description: `caf${cp(0xe9)} ${EMOJI}`, prompt: "\u0000\u001f" }),
  '{"description":"d","prompt":"p","model":"","initialPrompt":""}',
  '{"description":"d","prompt":"p","maxTurns":123456789012345678901,"effort":0.1}',
];
const coerce = COERCE.map((input) => {
  const def = dbAgents.coerceAgentDefinition(JSON.parse(input));
  return { input, output: def === null ? null : JSON.stringify(def) };
});

const DB_CWD = "$CWD/db";
const FOREIGN_ROWS = `
  INSERT INTO db_agents VALUES ('f-real', '{"description":"d","prompt":"p"}', 1.5);
  INSERT INTO db_agents VALUES ('f-text', '{"description":"d","prompt":"p"}', 'later');
  INSERT INTO db_agents VALUES ('f-blob', CAST('{"description":"blob","prompt":"p","maxTurns":1e400}' AS BLOB), x'0102ff');
  INSERT INTO db_agents VALUES ('f-big', '{"description":"d","prompt":"p","maxTurns":1.0,"effort":-0.0}', 9007199254740993);
  INSERT INTO db_agents VALUES ('f-inf', '{"description":"d","prompt":"p","effort":-1e999}', 1e999);
  INSERT INTO db_agents VALUES ('f-bad-json', '{"description":', 1);
  INSERT INTO db_agents VALUES ('f-no-prompt', '{"description":"d"}', 1);
  INSERT INTO db_agents VALUES ('f-array', '[{"description":"d","prompt":"p"}]', 1);
  INSERT INTO db_agents VALUES ('f bad name', '{"description":"d","prompt":"p"}', 1);
  INSERT INTO db_agents VALUES ('${N(257)}', '{"description":"d","prompt":"p"}', 1);
  INSERT INTO db_agents VALUES ('${N(256)}', '{"description":"long","prompt":"p"}', 1);
  INSERT INTO db_agents VALUES (x'6162', '{"description":"d","prompt":"p"}', 1);
  INSERT INTO db_agents VALUES (NULL, '{"description":"d","prompt":"p"}', 1);
  INSERT INTO db_agents VALUES (12, '{"description":"twelve","prompt":"p"}', 1);
  INSERT INTO db_agents VALUES ('f-num-def', 5, 1);
  INSERT INTO db_agents VALUES ('f-bom', char(65279) || '{"description":"d","prompt":"p"}', 1);
  INSERT INTO db_agents VALUES ('f-badutf8', CAST(x'7b226465736372697074696f6e223a2264ff222c2270726f6d7074223a2270227d' AS TEXT), 1);
  INSERT INTO db_agents VALUES ('f-badutf8-blob', x'7b226465736372697074696f6e223a2264c3222c2270726f6d7074223a2270227d', 1);
  INSERT INTO db_agents VALUES ('2', '{"description":"two","prompt":"p"}', 1);
  INSERT INTO db_agents VALUES ('10', '{"description":"ten","prompt":"p"}', 1);
  INSERT INTO db_agents VALUES ('f-ws', ' {"description":"d","prompt":"p"} ', '7');
  INSERT INTO db_agents VALUES ('f-extra', '{"description":"d","prompt":"p","extra":{"deep":[1e400]}}', '1.50');
`;
const DB_STEPS = [
  { op: "list", cwd: DB_CWD },
  { op: "load", cwd: DB_CWD },
  { op: "upsert", cwd: DB_CWD, name: J("a"), definition: J(DEF) },
  { op: "upsert", cwd: DB_CWD, name: J("a b"), definition: J(DEF) },
  { op: "upsert", cwd: DB_CWD, name: J("a b"), definition: null },
  { op: "upsert", cwd: DB_CWD, name: J(N(257)), definition: J(DEF) },
  { op: "upsert", cwd: DB_CWD, name: "5", definition: J(DEF) },
  { op: "upsert", cwd: DB_CWD, name: J("b"), definition: null },
  { op: "upsert", cwd: DB_CWD, name: J("b"), definition: J({ description: "d" }) },
  { op: "upsert", cwd: DB_CWD, name: J("b"), definition: FULL_DEF },
  { op: "upsert", cwd: DB_CWD, name: J("inf"), definition: '{"description":"d","prompt":"p","maxTurns":1e400,"effort":-1e400}' },
  { op: "upsert", cwd: DB_CWD, name: J("m".repeat(256)), definition: J({ description: `caf${cp(0xe9)}`, prompt: EMOJI }) },
  { op: "upsert", cwd: DB_CWD, name: J("a"), definition: J({ description: "updated", prompt: "p2", model: "haiku" }) },
  { op: "list", cwd: DB_CWD },
  { op: "sql", cwd: DB_CWD, sql: FOREIGN_ROWS },
  { op: "list", cwd: DB_CWD },
  { op: "load", cwd: DB_CWD },
  { op: "delete", cwd: DB_CWD, name: "a" },
  { op: "delete", cwd: DB_CWD, name: "a" },
  { op: "delete", cwd: DB_CWD, name: "a b" },
  { op: "delete", cwd: DB_CWD, name: N(257) },
  { op: "delete", cwd: DB_CWD, name: "" },
  { op: "delete", cwd: DB_CWD, name: "f-real" },
  { op: "list", cwd: DB_CWD },
  // A table some other version made: no types, no key.
  {
    op: "sql",
    cwd: "$CWD/foreign",
    sql: `CREATE TABLE db_agents(name, definition_json, updated_at);
      INSERT INTO db_agents VALUES (7, '{"description":"d","prompt":"p"}', 1);
      INSERT INTO db_agents VALUES ('ok', '{"description":"d","prompt":"p"}', NULL);
      INSERT INTO db_agents VALUES ('int-def', 5, 1);
      INSERT INTO db_agents VALUES ('null-def', NULL, 1);
      INSERT INTO db_agents VALUES ('real-def', 1.5, 1);
      INSERT INTO db_agents VALUES ('blob-def', x'7b226465736372697074696f6e223a2264222c2270726f6d7074223a2270227d', 2.0);
      INSERT INTO db_agents VALUES ('dup', '{"description":"first","prompt":"p"}', 1);
      INSERT INTO db_agents VALUES ('dup', '{"description":"second","prompt":"p"}', 2);
      INSERT INTO db_agents VALUES (1.5, '{"description":"d","prompt":"p"}', 1);`,
  },
  { op: "list", cwd: "$CWD/foreign" },
  { op: "load", cwd: "$CWD/foreign" },
  { op: "upsert", cwd: "$CWD/foreign", name: J("new"), definition: J(DEF) },
  { op: "delete", cwd: "$CWD/foreign", name: "dup" },
  { op: "list", cwd: "$CWD/foreign" },
  // A DB without the table.
  { op: "sql", cwd: "$CWD/notable", sql: "CREATE TABLE other(x); INSERT INTO other VALUES (1);" },
  { op: "list", cwd: "$CWD/notable" },
  { op: "load", cwd: "$CWD/notable" },
];

async function dbStep(step) {
  const cwd = unplace(step.cwd);
  if (step.op === "sql") {
    runSql(step.cwd, step.sql);
    return null;
  }
  try {
    switch (step.op) {
      case "list":
        return nowed(place(JSON.stringify(await dbAgents.listDbAgents(cwd))));
      case "load": {
        const m = await dbAgents.loadDbAgentsForOptions(cwd);
        return m === undefined ? null : JSON.stringify(m);
      }
      case "upsert": {
        const def = step.definition === null ? undefined : JSON.parse(step.definition);
        return nowed(JSON.stringify(await pinned(() => dbAgents.upsertDbAgent(cwd, JSON.parse(step.name), def))));
      }
      case "delete":
        return await dbAgents.deleteDbAgent(cwd, step.name);
    }
  } catch (e) {
    return { threw: place(e.message) };
  }
  throw new Error(step.op);
}

const dbSteps = [];
for (const step of DB_STEPS) dbSteps.push({ ...step, result: await dbStep(step) });
const db = { names: nameChecks, coerce, steps: dbSteps, rows: dbRows(DB_CWD), foreignRows: dbRows("$CWD/foreign") };

// --------------------------------- routes ---------------------------------

const HANDLERS = {
  "/api/agents": agentsRoute,
  "/api/agents/db": dbRoute,
};

async function routeCall(method, url, body) {
  const full = new URL(`http://localhost${unplace(url)}`);
  const bytes = body === undefined ? null : typeof body === "string" ? Buffer.from(unplace(body), "utf8") : Buffer.from(body.hex, "hex");
  const req = new Request(full, { method, ...(bytes ? { body: bytes } : {}) });
  const path = full.pathname;
  let handler;
  let ctx;
  if (HANDLERS[path]) handler = HANDLERS[path][method];
  else {
    handler = nameRoute[method];
    ctx = { params: Promise.resolve({ name: decodeURIComponent(path.slice("/api/agents/".length)) }) };
  }
  try {
    const res = await pinned(() => handler(req, ctx));
    return { status: res.status, body: nowed(place(await res.text())) };
  } catch {
    return { status: 500, body: "" };
  }
}

const Q = (o) =>
  Object.entries(o)
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
const A = (q) => `/api/agents${q ? `?${q}` : ""}`;
const DBR = (q) => `/api/agents/db${q ? `?${q}` : ""}`;
const DEL = (name, q) => `/api/agents/${name}?${q}`;
const put = (o) => J({ scope: "project", ...o });

const ROUTE_STEPS = [
  ["GET", A("")],
  ["GET", A(Q({ cwd: "$PROJECT" }))],
  ["GET", A(Q({ cwd: "/nonexistent" }))],
  ["GET", A(Q({ cwd: "%20" }))],
  ["GET", A(Q({ cwd: "%EF%BB%BF" }))],
  ["GET", A(Q({ cwd: "%C2%85" }))],
  ["GET", A(Q({ cwd: "." }))],
  ["GET", A(Q({ cwd: "$PROJECT/" }))],
  ["GET", A(Q({ cwd: "$PROJECT/../project" }))],
  ["GET", A(Q({ cwd: "$PROJECT", cwd2: "x" }))],
  ["GET", A("cwd=%2Fnonexistent&cwd=$PROJECT")],
  ["GET", A(Q({ scope: "user", name: "x" }))],
  ["GET", A(Q({ scope: "bogus", name: "x" }))],
  ["GET", A(Q({ scope: "user" }))],
  ["GET", A(Q({ scope: "", name: "x" }))],
  ["GET", A(Q({ scope: "bogus" }))],
  ["GET", A(Q({ scope: "user", name: "a%2Fb" }))],
  ["GET", A(Q({ scope: "project", name: "..." }))],
  ["GET", A(Q({ scope: "project", name: "x", cwd: "/nonexistent" }))],
  // PUT: the body checks, in order.
  ["PUT", A(""), "{"],
  ["PUT", A(""), ""],
  ["PUT", A("")],
  ["PUT", A(""), "null"],
  ["PUT", A(""), "[]"],
  ["PUT", A(""), '"x"'],
  ["PUT", A(""), J({ scope: "x" })],
  ["PUT", A(""), J({ scope: "User" })],
  ["PUT", A(""), J({ scope: ["user"] })],
  ["PUT", A(""), J({ scope: "user" })],
  ...['""', "0", "-0", "false", "null"].map((n) => ["PUT", A(""), `{"scope":"user","name":${n},"raw":"r"}`]),
  ["PUT", A(""), J({ scope: "user", name: "a" })],
  ["PUT", A(""), J({ scope: "user", name: "a", raw: 5 })],
  ["PUT", A(""), J({ scope: "user", name: "a", raw: null })],
  ["PUT", A(""), J({ scope: "user", name: "a", raw: "r", cwd: "/nonexistent" })],
  ["PUT", A(""), J({ scope: "user", name: "a b", raw: "r", cwd: "/nonexistent" })],
  ["PUT", A(""), J({ scope: "user", name: "a", cwd: "/nonexistent" })],
  ["PUT", A(""), '{"scope":"project","name":"rawinf","raw":1e400}'],
  ["PUT", A(""), '{"scope":1e400,"name":"scopeinf","raw":"x"}'],
  ["PUT", A(""), '{"scope":"project","name":"cwdinf","raw":"x","cwd":1e400}'],
  ["PUT", A(""), J({ name: "a", raw: "r" })],
  // Saves, and what they refuse.
  ["PUT", A(""), J({ scope: "user", name: "u1", raw: fm("u1") })],
  ["PUT", A(""), put({ name: "p1", raw: fm("p1"), cwd: "$PROJECT" })],
  ["PUT", A(""), put({ name: "p2", raw: "", cwd: "." })],
  ["PUT", A(""), put({ name: "p3", raw: "x", cwd: "$PROJECT/" })],
  ["PUT", A(""), put({ name: "p4", raw: "x", cwd: 5 })],
  ["PUT", A(""), put({ name: "p5", raw: "x", cwd: " \t" })],
  ["PUT", A(""), put({ name: "p6", raw: "x", cwd: "\ufeff" })],
  ["PUT", A(""), put({ name: "p7", raw: "x", cwd: "\u0085" })],
  ["PUT", A(""), put({ name: "p8", raw: "x", cwd: "" })],
  ...["a b", "a/b", "../x", cp(0xe9), "a:b", X(257), X(256), X(252)].map((name) => ["PUT", A(""), put({ name, raw: "x" })]),
  ...["5", "1.5", "true", '["arr"]', '[["deep"]]', '["a","b"]', "{}", "[]", "[null]", "1e21", "1e400", "-1e400", "[1e400]",
    `["${X(300)}"]`].map((n) => ["PUT", A(""), `{"scope":"project","name":${n},"raw":"x"}`]),
  ["PUT", A(""), put({ name: "colon", raw: fm("x:y") })],
  ["PUT", A(""), put({ name: "fm257", raw: fm(N(257)) })],
  ["PUT", A(""), put({ name: "fm256", raw: fm(N(256)) })],
  ["PUT", A(""), put({ name: "emoji", raw: fm(EMOJI.repeat(129)) })],
  ["PUT", A(""), put({ name: "rich", raw: `${BOM}---\r\nname: rich\r\ndescription: caf${cp(0xe9)}\r\ntools: [Read, Grep]\r\nmaxTurns: 1.0\r\n---\r\nbody ${EMOJI}\r\n` })],
  ["PUT", A(""), put({ name: "p1", raw: "---\nname: p1\ndescription: overwritten\n---\n" })],
  ["PUT", A(""), `${BOM}{"scope":"project","name":"bom1","raw":"x"}`],
  ["PUT", A(""), `${BOM}${BOM}{"scope":"project","name":"bom2","raw":"x"}`],
  ["PUT", A(""), `${BOM}${BOM}${BOM}{"scope":"project","name":"bom3","raw":"x"}`],
  ["PUT", A(""), { hex: hex('{"scope":"project","name":"utf8","raw":"a') + "ff" + hex('b"}') }],
  ["PUT", A(""), '{"scope":"project","name":"dup","name":"dup2","raw":"x","raw":"y"}'],
  ["PUT", A(""), `{"scope":"project","name":"deep","raw":"x","extra":${"[".repeat(100)}${"]".repeat(100)}}`],
  ["GET", A("")],
  ["GET", A(Q({ scope: "project", name: "rich" }))],
  ["GET", A(Q({ scope: "project", name: "Infinity" }))],
  ["GET", A(Q({ scope: "user", name: "u1", cwd: "$PROJECT" }))],
  ["GET", A(Q({ scope: "project", name: "u1" }))],
  // An unreadable entry and a circular frontmatter.
  { fs: [["mkdir", "$PROJECT/.claude/agents/zdir.md"]] },
  ["GET", A("")],
  ["PUT", A(""), put({ name: "cyc", raw: "---\na: &x [*x]\n---\nbody" })],
  ["GET", A("")],
  ["GET", A(Q({ scope: "project", name: "cyc" }))],
  ["DELETE", DEL("cyc", Q({ scope: "project" }))],
  ["GET", A(Q({ cwd: "$PROJECT" }))],
  // DELETE
  ["DELETE", DEL("p2", Q({ scope: "project" }))],
  ["DELETE", DEL("p2", Q({ scope: "project" }))],
  ["DELETE", DEL("p3", "")],
  ["DELETE", DEL("p3", Q({ scope: "bogus" }))],
  ["DELETE", DEL("p3", Q({ cwd: "/nonexistent" }))],
  ["DELETE", DEL("p3", Q({ scope: "project", cwd: "/nonexistent" }))],
  ["DELETE", DEL("a%20b", Q({ scope: "project" }))],
  ["DELETE", DEL("%C3%A9", Q({ scope: "project" }))],
  ["DELETE", DEL("Infinity", Q({ scope: "project", cwd: "$PROJECT" }))],
  ["DELETE", DEL("u1", Q({ scope: "user" }))],
  ["DELETE", DEL("zdir", Q({ scope: "project" }))],
  ["DELETE", DEL("...", Q({ scope: "project" }))],
  // /api/agents/db
  ["GET", DBR("")],
  ["GET", DBR(Q({ cwd: "/nonexistent" }))],
  ["PUT", DBR(""), "{"],
  ["PUT", DBR(""), ""],
  ["PUT", DBR("")],
  ["PUT", DBR(""), "null"],
  ["PUT", DBR(""), "[]"],
  ["PUT", DBR(""), J({ name: "" })],
  ["PUT", DBR(""), '{"name":-0}'],
  ["PUT", DBR(""), J({ name: "a" })],
  ["PUT", DBR(""), J({ name: "a", definition: { description: "d" } })],
  ["PUT", DBR(""), J({ name: "a b", definition: DEF })],
  ["PUT", DBR(""), J({ name: N(257), definition: DEF })],
  ["PUT", DBR(""), J({ name: 5, definition: DEF })],
  ["PUT", DBR(""), '{"name":1e400,"definition":{"description":"d","prompt":"p"}}'],
  ["PUT", DBR(""), J({ name: "a", definition: DEF, cwd: "/nonexistent" })],
  ["PUT", DBR(""), '{"name":"cwdinf","definition":{"description":"d","prompt":"p"},"cwd":-1e400}'],
  ["PUT", DBR(""), J({ name: "a", definition: DEF })],
  ["PUT", DBR(""), J({ name: "b", definition: JSON.parse(FULL_DEF), cwd: "$PROJECT" })],
  ["PUT", DBR(""), '{"name":"inf","definition":{"description":"d","prompt":"p","maxTurns":1e400,"effort":1e400,"autoCompactWindow":1e400}}'],
  ["PUT", DBR(""), '{"name":"nums","definition":{"description":"d","prompt":"p","maxTurns":1.0,"effort":2.50,"autoCompactWindow":1e3}}'],
  ["PUT", DBR(""), `${BOM}{"name":"bom","definition":{"description":"d","prompt":"p"}}`],
  ["PUT", DBR(""), { hex: hex('{"name":"utf8","definition":{"description":"d') + "ff" + hex('","prompt":"p"}}') }],
  ["PUT", DBR(""), J({ name: "a", definition: { description: "again", prompt: "p" } })],
  ["GET", DBR(Q({ cwd: "$PROJECT" }))],
  { sql: FOREIGN_ROWS },
  ["GET", DBR("")],
  ["DELETE", DBR("")],
  ["DELETE", DBR(Q({ name: "" }))],
  ["DELETE", DBR(Q({ name: "a%20b" }))],
  ["DELETE", DBR(Q({ name: N(257) }))],
  ["DELETE", DBR(Q({ name: "missing" }))],
  ["DELETE", DBR(Q({ name: "a" }))],
  ["DELETE", DBR(Q({ name: "a", cwd: "/nonexistent" }))],
  ["DELETE", DBR(Q({ name: "f-real", cwd: "$PROJECT" }))],
  ["GET", DBR("")],
];

async function runRoutes(steps) {
  const outSteps = [];
  for (const s of steps) {
    if (!Array.isArray(s)) {
      if (s.fs) s.fs.forEach(fsAction);
      if (s.sql) runSql("$PROJECT", s.sql);
      outSteps.push(s);
      continue;
    }
    const [method, url, body] = s;
    const call = { method, url };
    if (typeof body === "string") call.request = body;
    else if (body) call.requestHex = body.hex;
    outSteps.push({ ...call, ...(await routeCall(method, url, body)) });
  }
  return outSteps;
}

const routeSteps = await runRoutes(ROUTE_STEPS);
const routes = {
  steps: routeSteps,
  tree: [...tree("$PROJECT/.claude"), ...tree("$HOME/.claude/agents")],
  rows: dbRows("$PROJECT"),
};

// --------------------------------- reload ---------------------------------

let dirs = 0;
/** A real SDK query against the fake CLI, as a bare session's `query`. */
async function openQuery() {
  const dir = join(ROOT_DIR, `q${dirs++}`);
  mkdirSync(join(dir, "home"), { recursive: true });
  const log = join(dir, "stdin.log");
  let finish;
  const done = new Promise((r) => (finish = r));
  async function* prompt() {
    await done;
  }
  const ctrl = new AbortController();
  const q = query({
    prompt: prompt(),
    options: {
      cwd: dir,
      pathToClaudeCodeExecutable: FAKE,
      abortController: ctrl,
      env: { PATH: "/usr/bin:/bin", HOME: join(dir, "home"), FAKE_CLAUDE_LOG: log },
    },
  });
  const drained = (async () => {
    try {
      for await (const m of q) void m;
    } catch {
      // aborted
    }
  })();
  await q.initializationResult();
  const close = async () => {
    finish();
    ctrl.abort();
    await drained;
  };
  return { q, log, close };
}
const readLines = (f) => {
  try {
    return readFileSync(f, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
};
const reloadWire = (log, from) =>
  readLines(log)
    .slice(from)
    .filter((l) => {
      const m = JSON.parse(l);
      return m.type === "control_request" && m.request?.subtype === "reload_plugins";
    })
    .map((l) => l.replace(JSON.stringify(JSON.parse(l).request_id), '"$ID"'));

rmSync(join(PROJECT, ".claude"), { recursive: true, force: true });
const live = [];
for (let i = 0; i < 2; i++) {
  const q = await openQuery();
  const host = Object.create(Session.prototype);
  host.id = `golden-reload-${i}`;
  host.cwd = PROJECT;
  host.query = q.q;
  sessionManager.sessions.set(host.id, host);
  live.push(q);
}
const RELOAD_STEPS = [
  ["PUT", A(""), put({ name: "r1", raw: fm("r1") })],
  ["PUT", A(""), J({ scope: "user", name: "r2", raw: "x", cwd: "$PROJECT" })],
  ["PUT", A(""), put({ name: "a b", raw: "x" })],
  ["PUT", A(""), put({ name: "r3", raw: "x", cwd: "/nonexistent" })],
  ["DELETE", DEL("r1", Q({ scope: "project" }))],
  ["DELETE", DEL("r1", Q({ scope: "project" }))],
  ["DELETE", DEL("r2", Q({ scope: "user", cwd: "$PROJECT" }))],
  ["PUT", DBR(""), J({ name: "r4", definition: DEF })],
  ["DELETE", DBR(Q({ name: "r4" }))],
  ["GET", A("")],
];
const reloadSteps = [];
for (const [method, url, body] of RELOAD_STEPS) {
  const from = live.map((q) => readLines(q.log).length);
  const call = { method, url, ...(body === undefined ? {} : { request: body }) };
  const res = await routeCall(method, url, body);
  reloadSteps.push({ ...call, ...res, wire: live.flatMap((q, i) => reloadWire(q.log, from[i])).sort() });
}
for (const q of live) await q.close();
sessionManager.sessions.clear();
const reload = { sessions: live.length, steps: reloadSteps };

// ---------------------------------- start ----------------------------------

const START = [
  { name: "no db", db: false, upserts: [], sql: null },
  {
    name: "rows",
    db: true,
    upserts: [
      [J("b"), FULL_DEF],
      [J("a"), J({ description: `caf${cp(0xe9)}`, prompt: `p ${EMOJI}`, maxTurns: 2, effort: "max" })],
      [J("10"), J(DEF)],
      [J("2"), J({ description: "two", prompt: "p", autoCompactWindow: 50000 })],
      [J("inf"), '{"description":"d","prompt":"p","maxTurns":1e400}'],
    ],
    sql: `INSERT INTO db_agents VALUES ('f-raw', '{"description":"d","prompt":"p","maxTurns":1e400,"effort":-0.0,"tools":["x"],"extra":1}', 1);
      INSERT INTO db_agents VALUES ('f bad', '{"description":"d","prompt":"p"}', 1);
      INSERT INTO db_agents VALUES ('f-nums', '{"description":"d","prompt":"p","maxTurns":1e21,"effort":0.5}', 1);`,
  },
  { name: "only invalid rows", db: true, upserts: [], sql: FOREIGN_ROWS.split("\n").filter((l) => /f-bad-json|f-no-prompt|f bad name/.test(l)).join("\n") },
  { name: "empty table", db: true, upserts: [[J("gone"), J(DEF)]], sql: "DELETE FROM db_agents;" },
];

async function waitFor(file, pred) {
  for (let i = 0; i < 500; i++) {
    const hit = readLines(file).find(pred);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`nothing in ${file}`);
}

const start = [];
for (const [i, c] of START.entries()) {
  const cwd = join(ROOT_DIR, `start${i}`);
  mkdirSync(cwd);
  if (c.db) await openDb(cwd);
  for (const [name, def] of c.upserts) await dbAgents.upsertDbAgent(cwd, JSON.parse(name), JSON.parse(def));
  if (c.sql) runSql(cwd, c.sql);
  const log = join(ROOT_DIR, `start${i}.log`);
  process.env.FAKE_CLAUDE_LOG = log;
  const s = new Session({ cwd });
  await s.start();
  const line = await waitFor(log, (l) => JSON.parse(l).request?.subtype === "initialize");
  const agentsOpt = JSON.parse(line).request.agents;
  await s.end();
  start.push({ ...c, agents: agentsOpt === undefined ? null : JSON.stringify(agentsOpt) });
}
delete process.env.FAKE_CLAUDE_LOG;

// A file, not stdout: `process.exit` would cut a piped stdout short.
writeFileSync(
  join(ROOT_DIR, "out.json"),
  JSON.stringify({
    sdkVersion,
    yamlVersion,
    yaml,
    collation: { names, order, pairs },
    frontmatter,
    files,
    db,
    routes,
    reload,
    start,
  }),
);
process.exit(0);
