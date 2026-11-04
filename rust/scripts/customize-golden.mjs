#!/usr/bin/env node
// Golden fixture for the Customize-wide routes (D16):
// `app/api/customize-settings/route.ts` (GET/PUT) with
// `lib/server/customize-settings.ts`, and `app/api/customize/runtime/route.ts`
// with the one `lib/server/customizations-startup.ts` export it calls
// (`isRunningInsideCustomizationMirror`), recorded from the real TS:
//
//   node rust/scripts/customize-golden.mjs     (node@22)
//
// Re-runs itself under `--experimental-transform-types` (with a resolve hook
// for the `@/` and extensionless imports), once per group and twice over,
// each group in a fresh world; both recordings must agree byte for byte. A
// world is `$ROOT` (a temp dir through realpath); the child runs with its cwd
// at `$ROOT/project`, HOME and CLAUDE_CONFIG_DIR at `$ROOT/home` and
// `$ROOT/config`, and umask 022.
//
// Records `groups`, one world each. `steps` are fs setup ops (`fs`: `mkdir`,
// `write` text / hex, `symlink`, `chmod`, `rm`), live-source changes
// (`live`: `$CLAUDIUS_LIVE_SOURCE`, `null` for unset, which
// `resetLiveSourceDirForTests` makes the next read see) and requests (`req`:
// `url`, `method`, `body` text or `bodyHex`). A request records `got`:
// `status`, `type`, `body` (the default prompt's JSON text written
// `$DEFAULT`) and the names of any other headers, or `threw` (what the TS
// let throw: Next's empty 500, and the message the Rust port logs). After
// every step, `file` is the settings file's text when it changed (`null`:
// gone) and `tree` the `.claude` listing when that changed (a dir as an
// object, a file as `<mode>:<hex>`, a link as `l><target>`, an unreadable
// one as `d!` / `f!`). `perms` marks a group that needs permissions
// enforced (not root).
//
// Placeholders: `$ROOT` in paths, texts, link targets and messages,
// `$DEFAULT` in bodies. Strings stay ASCII here: non-ASCII text is built
// with String.fromCodePoint and lone surrogates with String.fromCharCode.
//
// Written to rust/crates/claudius-server/tests/fixtures/customize_golden.json;
// replayed by crates/claudius-server/tests/customize.rs on the real binary.
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
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "crates/claudius-server/tests/fixtures/customize_golden.json");

const GROUPS = ["settings", "perms", "runtime"];

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

if (!process.env.CS_GOLDEN_ROOT) {
  const child = (group) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "cs-")));
    try {
      if (!/^[A-Za-z0-9_./-]+$/.test(root)) throw new Error(`bad root: ${root}`);
      for (const d of ["home", "config", "project"]) mkdirSync(join(root, d), { recursive: true });
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
            CS_GOLDEN_ROOT: root,
            CS_GOLDEN_GROUP: group,
            CS_GOLDEN_OUT: join(root, "out.json"),
          },
        },
      );
      if (r.status !== 0) {
        process.stdout.write(r.stdout);
        process.stderr.write(r.stderr);
        process.exit(r.status ?? 1);
      }
      return JSON.parse(readFileSync(join(root, "out.json"), "utf8"));
    } finally {
      openUp(root);
      rmSync(root, { recursive: true, force: true });
    }
  };
  const runs = [0, 1].map(() => JSON.stringify({ groups: GROUPS.map((g) => child(g)) }));
  if (runs[0] !== runs[1]) throw new Error("the two recordings differ");
  const fixture = JSON.parse(runs[0]);
  writeFileSync(out, `${JSON.stringify(fixture, null, 1)}\n`);
  const reqs = fixture.groups.reduce((n, g) => n + g.steps.filter((s) => s.op === "req").length, 0);
  console.log(
    `wrote ${out.slice(repo.length + 1)}: ${fixture.groups.length} groups, ${reqs} requests (stable)`,
  );
  process.exit(0);
}

// --------------------------------- child ---------------------------------

const ROOT = process.env.CS_GOLDEN_ROOT;
const GROUP = process.env.CS_GOLDEN_GROUP;
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

const settingsRoute = await import(join(repo, "app/api/customize-settings/route.ts"));
const runtimeRoute = await import(join(repo, "app/api/customize/runtime/route.ts"));
const settingsLib = await import(join(repo, "lib/server/customize-settings.ts"));
const runtimeDir = await import(join(repo, "lib/server/runtime-dir.ts"));

const SETTINGS_URL = "/api/customize-settings";
const RUNTIME_URL = "/api/customize/runtime";
const CLAUDE = `${ROOT}/home/.claude`;
const FILE = `${CLAUDE}/.claudius/customize-settings.json`;
const CUST = `${CLAUDE}/.claudius/customizations`;
const DEFAULT_TEXT = JSON.stringify(settingsLib.DEFAULT_AUTO_FIX_PROMPT).slice(1, -1);

const cp = (...cps) => String.fromCodePoint(...cps);
const unit = (...units) => String.fromCharCode(...units);
const real = (s) => s.replaceAll("$ROOT", ROOT);
const fake = (s) => s.replaceAll(ROOT, "$ROOT");

const F = {
  mkdir: (path) => ({ op: "fs", act: "mkdir", path }),
  write: (path, text) => ({ op: "fs", act: "write", path, text }),
  hex: (path, hex) => ({ op: "fs", act: "write", path, hex }),
  link: (path, target) => ({ op: "fs", act: "symlink", path, target }),
  chmod: (path, mode) => ({ op: "fs", act: "chmod", path, mode }),
  rm: (path) => ({ op: "fs", act: "rm", path }),
};
/** The settings file, holding `autoFixPrompt`. */
const held = (prompt) => F.write("$FILE", JSON.stringify({ autoFixPrompt: prompt }, null, 2));
const GET = () => ({ op: "req", url: SETTINGS_URL, method: "GET" });
const PUT = (body) => ({ op: "req", url: SETTINGS_URL, method: "PUT", body });
const PUTHEX = (hex) => ({ op: "req", url: SETTINGS_URL, method: "PUT", bodyHex: hex });
const putPrompt = (prompt) => PUT(JSON.stringify({ autoFixPrompt: prompt }));
const RUNTIME = () => ({ op: "req", url: RUNTIME_URL, method: "GET" });
const LIVE = (value) => ({ op: "live", value });
/** The customizations index. */
const index = (customizations) =>
  F.write("$CUST/index.json", JSON.stringify({ version: 1, customizations, publishes: [] }));

const E = cp(0xe9);
const EMOJI = cp(0x1f600);
const LONE = unit(0xd800);

function groupSettings() {
  return [
    // No file at all.
    GET(),
    // A stored prompt, and the blank ones that fall back to the default.
    held("mine"),
    GET(),
    held(""),
    GET(),
    held("   "),
    GET(),
    held(`\t\n ${cp(0x3000)}${cp(0xfeff)}`),
    GET(),
    held(cp(0x85)),
    GET(),
    held(`  kept  `),
    GET(),
    // What the file can hold.
    F.write("$FILE", "null"),
    GET(),
    F.write("$FILE", "[]"),
    GET(),
    F.write("$FILE", '"str"'),
    GET(),
    F.write("$FILE", "1"),
    GET(),
    F.write("$FILE", "true"),
    GET(),
    F.write("$FILE", "{}"),
    GET(),
    F.write("$FILE", '{"autoFixPrompt": 5}'),
    GET(),
    F.write("$FILE", '{"autoFixPrompt": null}'),
    GET(),
    F.write("$FILE", '{"autoFixPrompt": ["a"]}'),
    GET(),
    F.write("$FILE", '{"autoFixPrompt": "a", "extra": 1, "__proto__": {"x": 1}}'),
    GET(),
    F.write("$FILE", '{"autoFixPrompt": "first", "autoFixPrompt": "second"}'),
    GET(),
    F.write("$FILE", '{"autoFixPrompt": "\\ud800 lone"}'),
    GET(),
    F.write("$FILE", `{"autoFixPrompt": "caf${E} ${EMOJI}"}`),
    GET(),
    F.write("$FILE", "{"),
    GET(),
    F.write("$FILE", ""),
    GET(),
    F.write("$FILE", `${cp(0xfeff)}{"autoFixPrompt": "bom"}`),
    GET(),
    // Invalid UTF-8 (read as U+FFFD), then a number past the f64 range.
    F.hex("$FILE", "7b226175746f46697850726f6d7074223a2022ff227d"),
    GET(),
    F.write("$FILE", '{"autoFixPrompt": "x", "n": 1e400}'),
    GET(),
    // A directory where the file goes, then a file where `.claudius` goes.
    F.rm("$FILE"),
    F.mkdir("$FILE"),
    GET(),
    PUT('{"autoFixPrompt": "x"}'),
    F.rm("$FILE"),
    F.rm("$CLAUDIUS"),
    F.write("$CLAUDIUS", "not a folder\n"),
    GET(),
    PUT('{"autoFixPrompt": "x"}'),
    F.rm("$CLAUDIUS"),
    // PUT: the body.
    GET(),
    putPrompt("saved"),
    GET(),
    putPrompt(""),
    GET(),
    putPrompt("  "),
    GET(),
    putPrompt(`caf${E} ${EMOJI} ${LONE} lone`),
    GET(),
    putPrompt("x".repeat(200)),
    PUT('{"autoFixPrompt": "x", "extra": 1}'),
    GET(),
    PUT('{"autoFixPrompt": 5}'),
    PUT('{"autoFixPrompt": null}'),
    PUT("{}"),
    PUT('{"other": "x"}'),
    PUT("null"),
    PUT("[]"),
    PUT('["x"]'),
    PUT('"str"'),
    PUT("1"),
    PUT("true"),
    PUT(""),
    PUT("{"),
    PUT('{"autoFixPrompt": "x"'),
    PUT(`${cp(0xfeff)}{"autoFixPrompt": "bom"}`),
    GET(),
    PUT(`${cp(0xfeff)}${cp(0xfeff)}{"autoFixPrompt": "bom2"}`),
    GET(),
    // Invalid UTF-8 in the body, and a lone-surrogate escape.
    PUTHEX("7b226175746f46697850726f6d7074223a2022ff227d"),
    GET(),
    PUT('{"autoFixPrompt": "\\ud800\\ud800"}'),
    GET(),
    PUT('{"autoFixPrompt": "\\ud83d\\ude00"}'),
    GET(),
    PUT('{"autoFixPrompt": "x", "autoFixPrompt": "y"}'),
    GET(),
    // What the write keeps: an existing mode, a symlink, a dangling one.
    F.chmod("$FILE", 0o600),
    putPrompt("kept 600"),
    F.rm("$FILE"),
    F.write("$ROOT/elsewhere.json", '{"autoFixPrompt": "through the link"}'),
    F.link("$FILE", "$ROOT/elsewhere.json"),
    GET(),
    putPrompt("written through"),
    GET(),
    F.rm("$FILE"),
    F.rm("$ROOT/elsewhere.json"),
    F.link("$FILE", "$ROOT/nowhere.json"),
    GET(),
    putPrompt("dangling"),
    GET(),
    // The folders the write creates (umask 022).
    F.rm("$CLAUDE"),
    GET(),
    putPrompt("fresh"),
    GET(),
  ];
}

function groupPerms() {
  return [
    held("mine"),
    GET(),
    F.chmod("$FILE", 0o000),
    GET(),
    putPrompt("x"),
    F.chmod("$FILE", 0o400),
    GET(),
    putPrompt("read-only file"),
    F.chmod("$FILE", 0o644),
    F.chmod("$CLAUDIUS", 0o500),
    GET(),
    putPrompt("read-only folder"),
    F.chmod("$CLAUDIUS", 0o000),
    GET(),
    putPrompt("shut folder"),
    F.chmod("$CLAUDIUS", 0o755),
    F.rm("$CLAUDIUS"),
    F.chmod("$CLAUDE", 0o500),
    GET(),
    putPrompt("unwritable parent"),
    F.chmod("$CLAUDE", 0o755),
    GET(),
    putPrompt("open again"),
    GET(),
  ];
}

function groupRuntime() {
  const named = [{ id: "cust_aaaaaaaaaaaa", name: "A" }];
  const live = (suffix) => LIVE(`$CUST${suffix}`);
  return [
    index(named),
    // The main install: the cwd, and the values that trim to nothing.
    RUNTIME(),
    LIVE(""),
    RUNTIME(),
    LIVE(` \t\n${cp(0x3000)}${cp(0xfeff)}`),
    RUNTIME(),
    // U+0085 (NEL) isn't JS whitespace: it stays the live dir.
    LIVE(cp(0x85)),
    RUNTIME(),
    LIVE("$ROOT/project"),
    RUNTIME(),
    // A preview: the root itself, and what sits under it.
    live(""),
    RUNTIME(),
    live("/"),
    RUNTIME(),
    live("/cust_aaaaaaaaaaaa"),
    RUNTIME(),
    live("/cust_aaaaaaaaaaaa/src"),
    RUNTIME(),
    live("/cust_aaaaaaaaaaaa/src/"),
    RUNTIME(),
    live("/cust_aaaaaaaaaaaa/src/deep/er"),
    RUNTIME(),
    live("/../outside/src"),
    RUNTIME(),
    live(`/cust_${E}/src`),
    RUNTIME(),
    // Not a preview: a sibling with the same prefix, a relative path, a
    // case variant (the compare is a string, the disk is not).
    LIVE("$CUSTx/cust_aaaaaaaaaaaa/src"),
    RUNTIME(),
    LIVE("customizations/cust_aaaaaaaaaaaa/src"),
    RUNTIME(),
    LIVE("$ROOT/HOME/.claude/.claudius/customizations/cust_aaaaaaaaaaaa/src"),
    RUNTIME(),
    // The name the store holds, under one live dir.
    live("/cust_aaaaaaaaaaaa/src"),
    index([{ id: "cust_aaaaaaaaaaaa" }]),
    RUNTIME(),
    index([{ id: "cust_aaaaaaaaaaaa", name: null }]),
    RUNTIME(),
    index([{ id: "cust_aaaaaaaaaaaa", name: 5 }]),
    RUNTIME(),
    index([{ id: "cust_aaaaaaaaaaaa", name: { x: 1 } }]),
    RUNTIME(),
    index([{ id: "cust_aaaaaaaaaaaa", name: "" }]),
    RUNTIME(),
    F.write("$CUST/index.json", `{"version": 1, "customizations": [{"id": "cust_aaaaaaaaaaaa", "name": "\\ud800"}], "publishes": []}`),
    RUNTIME(),
    index([{ id: "cust_aaaaaaaaaaaa", name: "first" }, { id: "cust_aaaaaaaaaaaa", name: "second" }]),
    RUNTIME(),
    index([null, { id: "cust_aaaaaaaaaaaa", name: "after a null" }]),
    RUNTIME(),
    F.write("$CUST/index.json", `{"version": 2, "customizations": ${JSON.stringify(named)}, "publishes": []}`),
    RUNTIME(),
    F.write("$CUST/index.json", "{"),
    RUNTIME(),
    F.rm("$CUST/index.json"),
    RUNTIME(),
    F.mkdir("$CUST/index.json"),
    RUNTIME(),
    F.rm("$CUST/index.json"),
    index(named),
    RUNTIME(),
  ];
}

// ------------------------------- the world -------------------------------

const PLACE = (p) =>
  real(
    p
      .replaceAll("$FILE", FILE)
      .replaceAll("$CLAUDIUS", `${CLAUDE}/.claudius`)
      .replaceAll("$CLAUDE", CLAUDE)
      .replaceAll("$CUSTx", `${CUST}x`)
      .replaceAll("$CUST", CUST),
  );

function applyFs(s) {
  const p = PLACE(s.path);
  switch (s.act) {
    case "mkdir":
      mkdirSync(p, { recursive: true });
      break;
    case "write":
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, s.hex !== undefined ? Buffer.from(s.hex, "hex") : Buffer.from(real(s.text)));
      break;
    case "symlink":
      mkdirSync(dirname(p), { recursive: true });
      symlinkSync(PLACE(s.target), p);
      break;
    case "chmod":
      chmodSync(p, s.mode);
      break;
    case "rm":
      openUp(p);
      rmSync(p, { recursive: true, force: true });
      break;
    default:
      throw new Error(`unknown fs op ${s.act}`);
  }
}

/**
 * `.claude` as nested names: an object (a dir), "d!" (an unreadable dir),
 * "l><target>", "f!" (an unreadable file), or "<mode>:<hex>".
 */
function tree(path) {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return null;
  }
  if (st.isSymbolicLink()) return `l>${fake(readlinkSync(path))}`;
  const mode = (st.mode & 0o7777).toString(8).padStart(3, "0");
  if (!st.isDirectory()) {
    let buf;
    try {
      buf = readFileSync(path);
    } catch {
      return "f!";
    }
    return `${mode}:${buf.toString("hex")}`;
  }
  let names;
  try {
    names = readdirSync(path).sort();
  } catch {
    return "d!";
  }
  const out = { "": mode };
  for (const n of names) out[fake(n)] = tree(join(path, n));
  return out;
}

const readFile = () => {
  try {
    return fake(readFileSync(FILE).toString("utf8"));
  } catch {
    return null;
  }
};
const snapshot = () => ({ file: readFile(), tree: JSON.stringify(tree(CLAUDE)) });

async function request(s) {
  const route = s.url === RUNTIME_URL ? runtimeRoute : settingsRoute;
  const init = { method: s.method };
  if (s.body !== undefined) init.body = Buffer.from(real(s.body));
  else if (s.bodyHex !== undefined) init.body = Buffer.from(s.bodyHex, "hex");
  const req = new Request(`http://localhost${s.url}`, init);
  let res;
  try {
    res = s.method === "PUT" ? await route.PUT(req) : await route.GET(req);
  } catch (e) {
    return { threw: fake(e instanceof Error ? e.message : String(e)) };
  }
  const got = { status: res.status, type: res.headers.get("content-type") };
  const others = [...res.headers.keys()].filter((k) => k !== "content-type");
  if (others.length) got.headers = others;
  got.body = fake(Buffer.from(await res.arrayBuffer()).toString("utf8")).replaceAll(
    DEFAULT_TEXT,
    "$DEFAULT",
  );
  return got;
}

const BUILD = { settings: groupSettings, perms: groupPerms, runtime: groupRuntime };
const META = { perms: { perms: true } };

const steps = [];
let last = snapshot();
for (const raw of BUILD[GROUP]()) {
  const s = { ...raw };
  if (s.op === "fs") applyFs(s);
  else if (s.op === "live") {
    if (s.value === null) delete process.env.CLAUDIUS_LIVE_SOURCE;
    else process.env.CLAUDIUS_LIVE_SOURCE = PLACE(s.value);
    runtimeDir.resetLiveSourceDirForTests();
  } else s.got = await request(s);
  const now = snapshot();
  if (now.file !== last.file) s.file = now.file;
  if (now.tree !== last.tree) s.tree = JSON.parse(now.tree);
  last = now;
  steps.push(s);
}
writeFileSync(process.env.CS_GOLDEN_OUT, JSON.stringify({ name: GROUP, ...(META[GROUP] ?? {}), steps }));
process.exit(0);
