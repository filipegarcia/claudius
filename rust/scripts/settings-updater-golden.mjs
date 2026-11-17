#!/usr/bin/env node
// Golden fixture for the updater half of the settings backup (D27c): the
// export's `system.updaterSettings` and the import's `patchUpdaterSettings`
// call, recorded from the TS sources:
//
//   node rust/scripts/settings-updater-golden.mjs     (node@22)
//
// Re-runs itself under `--experimental-transform-types` with a resolve hook
// for the extensionless / `@/` imports, twice (two temp roots, both through
// realpath); both recordings must agree byte for byte. The child runs with
// its cwd at `<root>/project`, HOME at `<root>/home`, CLAUDE_CONFIG_DIR at
// `<root>/config` and umask 022. Every case starts from a fresh world: an
// empty workspace store, an `extra/` dir, and `updater.json` set up by the
// case's `setup` ops (`write` text or `bytes`, `mkdir`, `symlink`, `chmod`).
//
// * `files`: one `updater.json` per case. `export` is
//   `JSON.stringify(bundle.system.updaterSettings)` of `buildExportBundle()`;
//   then, from the same file each time, `startImport(JSON.parse(bundle))`
//   for each of `IMPORTS`.
// * `bundles`: `startImport(JSON.parse(bundle))` over `BASELINE`, one bundle
//   per odd `system.updaterSettings`.
//
// An import records `got` (`JSON.stringify` of the progress, or `threw`) and
// `after`, `updater.json` afterwards: `null` when missing, else its `kind`
// (`file` with `mode` and `text` or `bytes`, `dir`, `symlink` with `target`
// and the `text` read through it). `$ROOT` stands for the temp root and
// `$IMP` for the generated import id.
//
// Written to rust/crates/claudius-core/tests/fixtures/settings_updater_golden.json
// and replayed by crates/claudius-core/tests/settings_updater_golden.rs.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
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
const out = join(rustDir, "crates/claudius-core/tests/fixtures/settings_updater_golden.json");

// ------------------------------- recording -------------------------------

if (!process.env.SETTINGS_UPDATER_GOLDEN_ROOT) {
  const runs = [0, 1].map(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "settings-updater-golden-")));
    try {
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
            SETTINGS_UPDATER_GOLDEN_ROOT: root,
          },
        },
      );
      if (r.status !== 0) {
        process.stderr.write(r.stderr);
        process.exit(r.status ?? 1);
      }
      return readFileSync(join(root, "out.json"), "utf8");
    } finally {
      spawnSync("chmod", ["-R", "u+rwx", root]);
      rmSync(root, { recursive: true, force: true });
    }
  });
  if (runs[0] !== runs[1]) throw new Error("the two recordings differ");
  const fixture = JSON.parse(runs[0]);
  writeFileSync(out, `${JSON.stringify(fixture, null, 1)}\n`);
  const imports = fixture.files.reduce((n, f) => n + f.imports.length, 0) + fixture.bundles.length;
  console.log(
    `wrote ${out.slice(repo.length + 1)}: ${fixture.files.length} files, ${imports} imports (node ${fixture.node})`,
  );
  process.exit(0);
}

// --------------------------------- child ---------------------------------

const ROOT = process.env.SETTINGS_UPDATER_GOLDEN_ROOT;
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

// The unreadable-file warning goes to stderr, which only a failing run shows.
console.warn = () => {};

const { buildExportBundle } = await import(join(repo, "lib/server/settings-export.ts"));
const { startImport, validateBundle } = await import(join(repo, "lib/server/settings-import.ts"));

/** Characters by code point, and `\uXXXX` escape text, so this file stays ASCII. */
const ch = (...cps) => String.fromCodePoint(...cps);
const BS = String.fromCharCode(92);
const esc = (hex) => `${BS}u${hex}`;

const toAbsRoot = (s) => s.replaceAll("$ROOT", ROOT);
const normalize = (s) => s.replaceAll(ROOT, "$ROOT").replace(/imp_[0-9a-f]{16}/g, "$IMP");

// --------------------------------- worlds ---------------------------------

const P = "home/.claude/.claudius/updater.json";
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function buildWorld() {
  spawnSync("chmod", ["-R", "u+rwx", ROOT]);
  for (const d of ["home", "extra", "config", "nowhere"]) rmSync(join(ROOT, d), { recursive: true, force: true });
  mkdirSync(join(ROOT, "home/.claude/.claudius"), { recursive: true });
  mkdirSync(join(ROOT, "extra"));
  mkdirSync(join(ROOT, "config"));
  writeFileSync(join(ROOT, "home/.claude/.claudius/workspaces.json"), '{"version":1,"workspaces":[]}\n');
}

function apply([op, path, arg]) {
  const p = join(ROOT, path);
  switch (op) {
    case "write":
      writeFileSync(p, toAbsRoot(arg));
      break;
    case "bytes":
      writeFileSync(p, Buffer.from(arg));
      break;
    case "mkdir":
      mkdirSync(p);
      break;
    case "symlink":
      symlinkSync(toAbsRoot(arg), p);
      break;
    case "chmod":
      chmodSync(p, arg);
      break;
    default:
      throw new Error(`unknown op ${op}`);
  }
}

function setUp(ops) {
  buildWorld();
  for (const op of ops) apply(op);
}

/** `updater.json` as it is now. */
function entry() {
  const abs = join(ROOT, P);
  let st;
  try {
    st = lstatSync(abs);
  } catch {
    return null;
  }
  const content = (out) => {
    let buf;
    try {
      buf = readFileSync(abs);
    } catch {
      return out;
    }
    try {
      out.text = normalize(utf8.decode(buf));
    } catch {
      out.bytes = [...buf];
    }
    return out;
  };
  if (st.isSymbolicLink()) return content({ kind: "symlink", target: normalize(readlinkSync(abs)) });
  if (st.isDirectory()) return { kind: "dir" };
  return content({ kind: "file", mode: st.mode & 0o777 });
}

const thrown = (e) => ({ threw: normalize(e instanceof Error ? `${e.name}: ${e.message}` : String(e)) });

async function exported() {
  try {
    const bundle = await buildExportBundle();
    return JSON.stringify(bundle.system.updaterSettings);
  } catch (e) {
    return thrown(e);
  }
}

async function imported(bundle) {
  const parsed = JSON.parse(bundle);
  if (!validateBundle(parsed)) throw new Error(`not a valid bundle: ${bundle}`);
  let got;
  try {
    got = normalize(JSON.stringify(await startImport(parsed)));
  } catch (e) {
    got = thrown(e);
  }
  return { bundle, got, after: entry() };
}

// ---------------------------------- cases ----------------------------------

/** A bundle whose `system.updaterSettings` is the JSON text `u` (`system: {}` for `undefined`). */
const bundleWith = (u) =>
  `{"version":1,"exportedAt":1,"exportedFrom":{"hostname":"h","platform":"darwin"},"system":${
    u === undefined ? "{}" : `{"updaterSettings":${u}}`
  },"workspaces":[]}`;

const file = (text) => [["write", P, text]];
const BASELINE =
  '{"mode":"ff-only","remote":"up","branch":"dev","intervalHours":6,"state":{"lastCheckAt":5,"lastError":"boom","pending":{"remoteSha":"abc","behind":2},"status":{"kind":"checking","startedAt":1}},"extra":1}';

const FILES = [
  ["missing", []],
  ["an empty object", file("{}")],
  ["every field", file(BASELINE)],
  ["odd types", file('{"mode":"nope","remote":"  ","branch":7,"intervalHours":-1,"state":null}')],
  ["prototype names", file('{"mode":"constructor","remote":"toString","branch":"__proto__"}')],
  ["not JSON", file("not json")],
  ["truncated", file("[")],
  ["empty", file("")],
  ["a BOM", file(ch(0xfeff) + '{"mode":"ff-only"}')],
  ["null", file("null")],
  ["an array", file('["ff-only"]')],
  ["a string", file('"ff-only"')],
  ["number text", file('{"intervalHours":2.50,"state":{"lastCheckAt":1.50,"pending":{"n":[1.0,1e2,1e21,-0,0.000001,1e-7,123456789012345678]}}}')],
  ["a big interval", file('{"intervalHours":1e308}')],
  ["a tiny interval", file('{"intervalHours":5e-324}')],
  ["a long integer interval", file('{"intervalHours":12345678901234567890}')],
  ["an overflowing interval", file('{"intervalHours":1e400,"mode":"notify-only"}')],
  ["infinite stamps", file('{"state":{"lastCheckAt":1e400,"lastUpdateAt":-1e400,"pending":{"n":1e400}}}')],
  ["lone surrogates in the knobs", file(`{"remote":"${esc("dc00")}","branch":"a${esc("d800")}"}`)],
  [
    "lone surrogates in the state",
    file(`{"mode":"ff-only","state":{"lastError":"${esc("d83d")}","pending":{"remoteSha":"${esc("d800")}x"}}}`),
  ],
  ["nested 140 deep", file(`{"mode":"disabled","state":{"pending":{"a":${"[".repeat(137)}${"]".repeat(137)}}}}`)],
  ["index keys", file('{"state":{"pending":{"b":1,"2":2,"1":1,"a":0,"10":3,"01":4,"4294967295":5,"4294967294":6}}}')],
  ["__proto__ keys", file('{"__proto__":{"mode":"ff-only"},"state":{"pending":{"__proto__":{"a":1},"remoteSha":"x"}}}')],
  ["duplicate keys", file('{"mode":"ff-only","mode":"disabled","state":{"lastError":"a","lastError":"b"}}')],
  ["unicode", file(JSON.stringify({ remote: ch(0x1f600), branch: ch(0x4e2d, 0x6587), state: { lastError: ch(0x2028) + "x" + ch(0x85) } }))],
  [
    "invalid UTF-8",
    [
      [
        "bytes",
        P,
        [...Buffer.concat([Buffer.from('{"remote":"o'), Buffer.from([0xff]), Buffer.from('k","branch":"'), Buffer.from([0xe2, 0x82]), Buffer.from('"}')])],
      ],
    ],
  ],
  ["mode 0600", [["write", P, '{"mode":"ff-only"}'], ["chmod", P, 0o600]]],
  ["read-only", [["write", P, '{"mode":"ff-only"}'], ["chmod", P, 0o444]]],
  ["a directory", [["mkdir", P]]],
  ["a dangling symlink into a missing dir", [["symlink", P, "$ROOT/nowhere/target.json"]]],
  ["a dangling symlink into a dir", [["symlink", P, "$ROOT/extra/target.json"]]],
  ["a symlink to a file", [["write", "extra/linked.json", '{"branch":"linked"}'], ["symlink", P, "$ROOT/extra/linked.json"]]],
  ["a symlink loop", [["symlink", P, `$ROOT/${P}`]]],
  ["a symlink to a directory", [["symlink", P, "$ROOT/extra"]]],
];

/** Imported over each file: every knob, and nothing. */
const IMPORTS = [bundleWith('{"mode":"notify-only","remote":"fork","branch":"next","intervalHours":2}'), bundleWith("{}")];

const BUNDLES = [
  ["every knob", '{"mode":"notify-only","remote":"fork","branch":"next","intervalHours":2}'],
  ["mode cc-merge", '{"mode":"cc-merge"}'],
  ["mode ff-only", '{"mode":"ff-only"}'],
  ["mode notify-only", '{"mode":"notify-only"}'],
  ["mode disabled", '{"mode":"disabled"}'],
  ["mode upper-case", '{"mode":"DISABLED"}'],
  ["mode a prototype name", '{"mode":"constructor"}'],
  ["mode a number", '{"mode":5}'],
  ["mode null", '{"mode":null}'],
  ["mode an array", '{"mode":["disabled"]}'],
  ["mode an object", '{"mode":{"toString":"disabled"}}'],
  ["a bad mode with good knobs", '{"mode":"x","remote":"kept","intervalHours":3}'],
  ["remote blank", '{"remote":"   "}'],
  ["remote empty", '{"remote":""}'],
  ["remote JS whitespace", JSON.stringify({ remote: ch(0xa0, 0x2028, 0xfeff, 0x3000, 0x1680) })],
  ["remote NEL (not JS whitespace)", JSON.stringify({ remote: ch(0x85) })],
  ["remote U+180E (not JS whitespace)", JSON.stringify({ remote: ch(0x180e) })],
  ["spaced knobs (kept as they are)", '{"remote":" spaced ","branch":"\\tmain\\t"}'],
  ["remote a number", '{"remote":5}'],
  ["remote true", '{"remote":true}'],
  ["remote an array", '{"remote":["x"]}'],
  ["branch null", '{"branch":null}'],
  ["branch an object", '{"branch":{}}'],
  ["interval 0", '{"intervalHours":0}'],
  ["interval -1", '{"intervalHours":-1}'],
  ["interval -0", '{"intervalHours":-0}'],
  ["interval 1e400", '{"intervalHours":1e400}'],
  ["interval -1e400", '{"intervalHours":-1e400}'],
  ["interval a string", '{"intervalHours":"3"}'],
  ["interval true", '{"intervalHours":true}'],
  ["interval an array", '{"intervalHours":[6]}'],
  ["interval 0.5", '{"intervalHours":0.5}'],
  ["interval 1.0", '{"intervalHours":1.0}'],
  ["interval 1e21", '{"intervalHours":1e21}'],
  ["interval 5e-324", '{"intervalHours":5e-324}'],
  ["interval 1e-7", '{"intervalHours":1e-7}'],
  ["interval 12345678901234567890", '{"intervalHours":12345678901234567890}'],
  ["interval 1e308", '{"intervalHours":1e308}'],
  ["updaterSettings a number", "5"],
  ["updaterSettings a string", '"disabled"'],
  ["updaterSettings true", "true"],
  ["updaterSettings an empty array", "[]"],
  ["updaterSettings an array of a patch", '[{"mode":"disabled","remote":"arr"}]'],
  ["updaterSettings an empty object", "{}"],
  ["updaterSettings 0", "0"],
  ["updaterSettings false", "false"],
  ["updaterSettings null", "null"],
  ["updaterSettings an empty string", '""'],
  ["updaterSettings missing", undefined],
  ["extra keys and a state (ignored)", '{"mode":"notify-only","state":{"lastError":"x","status":{"kind":"applying"}},"extra":1}'],
  ["duplicate keys (last wins)", '{"mode":"bogus","mode":"disabled","remote":"a","remote":"b"}'],
  ["a __proto__ key", '{"__proto__":{"mode":"disabled","branch":"proto"},"remote":"r"}'],
  ["lone surrogates", `{"remote":"${esc("d800")}x","branch":"b${esc("dfff")}"}`],
  ["unicode", JSON.stringify({ remote: ch(0x1f600), branch: "ma" + ch(0xef) + "n" })],
  ["control characters", `{"remote":"a${esc("0000")}b","branch":"${esc("001f")}"}`],
];

// --------------------------------- output ---------------------------------

const files = [];
for (const [label, setup] of FILES) {
  setUp(setup);
  const exportText = await exported();
  const imports = [];
  for (const bundle of IMPORTS) {
    setUp(setup);
    imports.push(await imported(bundle));
  }
  files.push({ label, setup, export: exportText, imports });
}

const bundles = [];
for (const [label, u] of BUNDLES) {
  setUp(file(BASELINE));
  bundles.push({ label, ...(await imported(bundleWith(u))) });
}

writeFileSync(join(ROOT, "out.json"), JSON.stringify({ node: process.version, baseline: BASELINE, files, bundles }));
process.exit(0);
