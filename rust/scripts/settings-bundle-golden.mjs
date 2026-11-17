#!/usr/bin/env node
// Golden fixture for the backup routes (D11), recorded from the TS sources:
//
//   node rust/scripts/settings-bundle-golden.mjs     (node@22)
//
// Re-runs itself under `--experimental-transform-types` with a resolve hook
// for the extensionless / `@/` imports, twice (two temp roots, both through
// realpath); both recordings must agree byte for byte. The child runs with
// its cwd at `<root>/project`, HOME at `<root>/home`, CLAUDE_CONFIG_DIR at
// `<root>/config`, umask 022 and `Date.now()` pinned (BASE + 1000 per step).
//
// `platform` is `process.platform`; the export's `exportedFrom.hostname`
// (`os.hostname()`) reads as `host`, `$HOST`. The replay masks both (they
// differ between machines). Five sections:
// * `prompt`: `DEFAULT_AUTO_FIX_PROMPT`, so the Rust constant is checked.
// * `filenames`: `suggestedFilename(at)` over odd epoch values.
// * `merge`: `JSON.stringify(mergeDeep(target, source))` over pairs given as
//   JSON text (so `1e400`, duplicate keys and odd types survive).
// * `validate`: `validateBundle(JSON.parse(text))`.
// * `groups`: the real route handlers (`settings/export` GET,
//   `settings/import` POST, `settings/import/[id]` GET / DELETE,
//   `settings/import/[id]/resolve` POST), called with `Request` objects, in
//   order on one world per group. A step is either `setup` (file ops:
//   `write` text or `bytes`, `mkdir`, `rm`, `symlink`, `chmod`; a `label`
//   names the section) or a `request` (`method`, `url`, `type` for a
//   content-type header, `body` text or `bodyBytes`). Each request records
//   `got` (status, content type, content disposition, content length and
//   body text, or `threw`: Next's empty 500 with `<name>: <message>`) and
//   `changes` (every watched path whose entry differs). `final` is every
//   watched path at the end of the group.
//
// `$ROOT` stands for the temp root, `$IMP<n>` / `$WKS<n>` for the n-th
// generated import / workspace id (first seen in a response body, then in
// the changes) and `$COLOR` for a generated letter icon's palette colour.
// Backup and temp files (`*.bak.*`, `*.tmp`) are left out of snapshots.
//
// Written to rust/crates/claudius-server/tests/fixtures/settings_bundle_golden.json
// and replayed by crates/claudius-server/tests/settings_bundle.rs against
// the real binary.
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
import { hostname, platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "crates/claudius-server/tests/fixtures/settings_bundle_golden.json");

// ------------------------------- recording -------------------------------

if (!process.env.SETTINGS_BUNDLE_GOLDEN_ROOT) {
  const runs = [0, 1].map(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "settings-bundle-golden-")));
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
            SETTINGS_BUNDLE_GOLDEN_ROOT: root,
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
  if (runs[0] !== runs[1]) {
    if (process.env.SETTINGS_BUNDLE_GOLDEN_DEBUG) {
      writeFileSync("/tmp/sbg-a.json", `${JSON.stringify(JSON.parse(runs[0]), null, 1)}\n`);
      writeFileSync("/tmp/sbg-b.json", `${JSON.stringify(JSON.parse(runs[1]), null, 1)}\n`);
    }
    throw new Error("the two recordings differ");
  }
  const fixture = JSON.parse(runs[0]);
  writeFileSync(out, `${JSON.stringify(fixture, null, 1)}\n`);
  const steps = fixture.groups.reduce((n, g) => n + g.steps.filter((s) => s.request).length, 0);
  console.log(
    `wrote ${out.slice(repo.length + 1)}: ${fixture.groups.length} groups (${steps} requests), ` +
      `${fixture.merge.length} merges, ${fixture.validate.length} bundles, ${fixture.filenames.length} filenames (node ${fixture.node})`,
  );
  process.exit(0);
}

// --------------------------------- child ---------------------------------

const ROOT = process.env.SETTINGS_BUNDLE_GOLDEN_ROOT;
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

const BASE = 1_700_000_000_000;
let clock = BASE;
Date.now = () => clock;

const EXPORT = await import(join(repo, "app/api/settings/export/route.ts"));
const IMPORT = await import(join(repo, "app/api/settings/import/route.ts"));
const ONE = await import(join(repo, "app/api/settings/import/[id]/route.ts"));
const RESOLVE = await import(join(repo, "app/api/settings/import/[id]/resolve/route.ts"));
const { suggestedFilename } = await import(join(repo, "lib/server/settings-export.ts"));
const { mergeDeep, validateBundle } = await import(join(repo, "lib/server/settings-import.ts"));
const { DEFAULT_AUTO_FIX_PROMPT } = await import(join(repo, "lib/server/customize-settings.ts"));

/** Characters by code point, so this file stays ASCII. */
const U = (...cps) => String.fromCodePoint(...cps);
const BS = String.fromCharCode(92);

// ------------------------------ normalization ------------------------------

const PALETTE = ["#d97757", "#5588dd", "#9d6cdd", "#2e9d8f", "#dd8e44", "#cc5577", "#33aabb", "#7d8a4c"];
const toAbsRoot = (s) => s.replaceAll("$ROOT", ROOT);
const toRelRoot = (s) => s.replaceAll(ROOT, "$ROOT");

/** Generated ids, in the order they were first seen. */
const ids = { imp: [], wks: [] };
const place = (kind, id) => {
  const list = ids[kind];
  let at = list.indexOf(id);
  if (at < 0) {
    list.push(id);
    at = list.length - 1;
  }
  return `$${kind.toUpperCase()}${at + 1}`;
};
/** Replace every generated id and palette colour with its placeholder. */
function normalize(text) {
  let s = toRelRoot(text);
  s = s.replace(/imp_[0-9a-f]{16}/g, (m) => place("imp", m));
  s = s.replace(/wks_[0-9a-f]{12}/g, (m) => place("wks", m));
  for (const c of PALETTE) s = s.replaceAll(c, "$COLOR");
  return s;
}
/** `$IMP1` / `$WKS1` back to the real id (for request URLs and setup paths). */
function toReal(text) {
  return toAbsRoot(text).replace(/\$(IMP|WKS)(\d+)/g, (m, kind, n) => {
    const real = ids[kind.toLowerCase()][n - 1];
    if (real === undefined) throw new Error(`${m} is not allocated yet`);
    return real;
  });
}

// --------------------------------- worlds ---------------------------------

const WATCH = ["home", "project", "ws1", "ws2", "extra", "afile", "config"];
const SKIPPED = (rel) => /\.bak\.|\.tmp$|\.tmp-/.test(rel);
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function snapshot() {
  const snap = {};
  const visit = (rel) => {
    if (SKIPPED(rel)) return;
    const abs = join(ROOT, rel);
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      return;
    }
    if (st.isSymbolicLink()) {
      snap[rel] = { kind: "symlink", target: toRelRoot(readlinkSync(abs)) };
    } else if (st.isDirectory()) {
      snap[rel] = { kind: "dir", mode: st.mode & 0o777 };
      let names;
      try {
        names = readdirSync(abs).sort();
      } catch {
        return;
      }
      for (const e of names) visit(`${rel}/${e}`);
    } else {
      let buf;
      try {
        buf = readFileSync(abs);
      } catch {
        snap[rel] = { kind: "file", mode: st.mode & 0o777 };
        return;
      }
      let text = null;
      try {
        text = utf8.decode(buf);
      } catch {
        // not UTF-8: recorded as bytes
      }
      snap[rel] =
        text === null
          ? { kind: "file", mode: st.mode & 0o777, bytes: [...buf] }
          : { kind: "file", mode: st.mode & 0o777, text };
    }
  };
  for (const w of WATCH) visit(w);
  return snap;
}

/** The watched paths that differ, each with its new entry (`null` = gone). */
function changes(before, after) {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const diffs = keys
    .filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
    .map((k) => [normalize(k), after[k] === undefined ? null : JSON.parse(normalize(JSON.stringify(after[k])))]);
  // By the *normalized* path: a generated id makes the real order differ
  // between two recordings.
  diffs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return diffs;
}

const WS = (id, name, root, extra = {}) => ({
  id,
  name,
  rootPath: root,
  icon: { kind: "letter", letter: name.slice(0, 1).toUpperCase(), color: "#2e9d8f" },
  createdAt: 11,
  updatedAt: 12,
  ...extra,
});
const store = (...workspaces) => `${JSON.stringify({ version: 1, workspaces }, null, 2)}\n`;

const WORLD = {
  dirs: ["home/.claude/.claudius", "project", "ws1", "ws2", "extra", "config"],
  files: [
    ["home/.claude/.claudius/workspaces.json", store(WS("wks_seedaaaaaaa1", "One", "$ROOT/ws1"))],
    ["afile", "not a directory\n"],
    ["config/settings.json", '{"decoy":"config dir"}\n'],
  ],
};

function buildWorld() {
  spawnSync("chmod", ["-R", "u+rwx", ROOT]);
  for (const d of WATCH) {
    if (d === "project") {
      for (const e of readdirSync(join(ROOT, d))) rmSync(join(ROOT, d, e), { recursive: true, force: true });
    } else {
      rmSync(join(ROOT, d), { recursive: true, force: true });
    }
  }
  for (const d of WORLD.dirs) mkdirSync(join(ROOT, d), { recursive: true });
  for (const [p, text] of WORLD.files) {
    mkdirSync(dirname(join(ROOT, p)), { recursive: true });
    writeFileSync(join(ROOT, p), toAbsRoot(text));
  }
  ids.imp.length = 0;
  ids.wks.length = 0;
}

function apply(op) {
  const p = join(ROOT, toReal(op.path));
  switch (op.op) {
    case "write":
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, op.bytes ? Buffer.from(op.bytes) : toReal(op.text));
      break;
    case "mkdir":
      mkdirSync(p, { recursive: true });
      break;
    case "rm":
      rmSync(p, { recursive: true, force: true });
      break;
    case "symlink":
      symlinkSync(toReal(op.target), p);
      break;
    case "chmod":
      chmodSync(p, op.mode);
      break;
    default:
      throw new Error(`unknown op ${op.op}`);
  }
}

// --------------------------------- requests ---------------------------------

/** The export's `exportedFrom` as `JSON.stringify(bundle, null, 2)` prints it. */
const exportedFrom = (host) =>
  `"exportedFrom": {\n    "hostname": ${JSON.stringify(host)},\n    "platform": ${JSON.stringify(platform())}\n  }`;
/** What the machine's hostname reads as in the fixture. */
const HOST = "$HOST";

/** The dynamic segment of `/api/settings/import/<id>[/resolve]`. */
function routeOf(url) {
  const path = url.split("?")[0];
  if (path === "/api/settings/export") return { mod: EXPORT };
  if (path === "/api/settings/import") return { mod: IMPORT };
  const m = /^\/api\/settings\/import\/([^/]+)(\/resolve)?$/.exec(path);
  if (!m) throw new Error(`no handler for ${url}`);
  return { mod: m[2] ? RESOLVE : ONE, id: decodeURIComponent(m[1]) };
}

async function call(step) {
  const url = toReal(step.url);
  const { mod, id } = routeOf(url);
  const init = { method: step.method, headers: {} };
  if (step.type !== undefined) init.headers["content-type"] = step.type;
  if (step.body !== undefined) init.body = toReal(step.body);
  if (step.bodyBytes !== undefined) init.body = new Uint8Array(step.bodyBytes);
  const request = new Request(`http://localhost${url}`, init);
  const fn = mod[step.method];
  if (!fn) throw new Error(`no ${step.method} for ${url}`);
  try {
    const res = id === undefined ? await fn(request) : await fn(request, { params: Promise.resolve({ id }) });
    const text = await res.text();
    const body = normalize(text.replace(exportedFrom(hostname()), exportedFrom(HOST)));
    const got = { status: res.status, type: res.headers.get("content-type"), body };
    const cd = res.headers.get("content-disposition");
    if (cd !== null) got.disposition = cd;
    const cl = res.headers.get("content-length");
    if (cl !== null) got.length = cl;
    return got;
  } catch (e) {
    return { threw: normalize(e instanceof Error ? `${e.name}: ${e.message}` : String(e)) };
  }
}

async function runGroup(group) {
  buildWorld();
  const steps = [];
  for (const step of group.steps) {
    if (step.setup) {
      for (const op of step.setup) apply(op);
      steps.push(step);
      continue;
    }
    clock += 1000;
    const before = snapshot();
    const got = await call(step);
    const after = snapshot();
    const request = { method: step.method, url: step.url };
    for (const k of ["type", "body", "bodyBytes"]) if (step[k] !== undefined) request[k] = step[k];
    steps.push({ request, got, changes: changes(before, after) });
  }
  const snap = snapshot();
  const pairs = Object.keys(snap)
    .sort()
    .map((k) => [normalize(k), JSON.parse(normalize(JSON.stringify(snap[k])))]);
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return { name: group.name, steps, final: Object.fromEntries(pairs) };
}

// --------------------------------- step DSL ---------------------------------

const SL = (label, ...ops) => ({ setup: ops, label });
const W = (path, text) => ({ op: "write", path, text });
const WB = (path, bytes) => ({ op: "write", path, bytes });
const RM = (path) => ({ op: "rm", path });
const MK = (path) => ({ op: "mkdir", path });
const LN = (path, target) => ({ op: "symlink", path, target });

const GET_EXPORT = () => ({ method: "GET", url: "/api/settings/export" });
const POST_IMPORT = (body, type = "application/json") => ({ method: "POST", url: "/api/settings/import", type, body });
const RAW_IMPORT = (bodyBytes, type) => ({ method: "POST", url: "/api/settings/import", type, bodyBytes });
const JSON_IMPORT = (v) => POST_IMPORT(JSON.stringify(v));
const GET_ONE = (id) => ({ method: "GET", url: `/api/settings/import/${id}` });
const DEL_ONE = (id) => ({ method: "DELETE", url: `/api/settings/import/${id}` });
const RESOLVE_ONE = (id, body) => ({
  method: "POST",
  url: `/api/settings/import/${id}/resolve`,
  type: "application/json",
  body: typeof body === "string" ? body : JSON.stringify(body),
});

const USER = "home/.claude/settings.json";
const KEYS = "home/.claude/keybindings.json";
const CUSTOMIZE = "home/.claude/.claudius/customize-settings.json";
const UPDATER = "home/.claude/.claudius/updater.json";
const STORE = "home/.claude/.claudius/workspaces.json";
const ICONS = "home/.claude/.claudius/workspace-icons";
const CROOT = "home/.claude/.claudius/customizations";

/** A bundle with the required shape. */
const bundle = (over = {}) => ({ version: 1, exportedAt: 1, exportedFrom: { hostname: "h", platform: "darwin" }, system: {}, workspaces: [], ...over });
/** A bundled workspace entry. */
const bws = (id, name, root, over = {}) => ({
  meta: { id, name, rootPath: root, icon: { kind: "letter", letter: "B", color: "#cc5577" }, createdAt: 1, updatedAt: 2, ...(over.meta ?? {}) },
  ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== "meta")),
});

// ------------------------------ export group ------------------------------

const EXPORT_STEPS = [
  SL("empty"),
  GET_EXPORT(),
  SL("user settings", W(USER, '{"model":"opus","permissions":{"allow":["Bash"]}}\n')),
  GET_EXPORT(),
  SL("keybindings", W(KEYS, '{"bindings":[{"key":"ctrl+s","command":"save"}],"schema":1}\n')),
  GET_EXPORT(),
  SL("keybindings falsy", W(KEYS, "null\n")),
  GET_EXPORT(),
  SL("keybindings zero", W(KEYS, "0")),
  GET_EXPORT(),
  SL("keybindings array", W(KEYS, "[1,2]")),
  GET_EXPORT(),
  SL("keybindings malformed", W(KEYS, "{")),
  GET_EXPORT(),
  SL("keybindings gone", RM(KEYS)),
  SL("customize default", W(CUSTOMIZE, JSON.stringify({ autoFixPrompt: DEFAULT_AUTO_FIX_PROMPT }, null, 2))),
  GET_EXPORT(),
  SL("customize custom", W(CUSTOMIZE, '{"autoFixPrompt":"fix it"}')),
  GET_EXPORT(),
  SL("customize blank", W(CUSTOMIZE, '{"autoFixPrompt":"   "}')),
  GET_EXPORT(),
  SL("customize extra keys", W(CUSTOMIZE, '{"autoFixPrompt":"fix","extra":true}')),
  GET_EXPORT(),
  SL("customize malformed", W(CUSTOMIZE, "nope")),
  GET_EXPORT(),
  SL("customize null", W(CUSTOMIZE, "null")),
  GET_EXPORT(),
  SL("customize gone", RM(CUSTOMIZE)),
  SL("updater", W(UPDATER, JSON.stringify({ mode: "ff-only", remote: "up", branch: "dev", intervalHours: 6, state: { lastCheckAt: 5, status: { kind: "checking", startedAt: 1 } }, extra: 1 }, null, 2))),
  GET_EXPORT(),
  SL("updater odd types", W(UPDATER, '{"mode":"nope","remote":"  ","branch":7,"intervalHours":-1,"state":null}')),
  GET_EXPORT(),
  SL("updater malformed", W(UPDATER, "[")),
  GET_EXPORT(),
  SL("workspaces", W(STORE, store(WS("wks_seedaaaaaaa1", "One", "$ROOT/ws1"), WS("wks_seedaaaaaaa2", "Two", "$ROOT/ws2", { kind: "worktree", navOrder: ["a", "b"], commitPrefix: { mode: "off" } }), WS("wks_seedaaaaaaa3", "Cust", "$ROOT/extra", { kind: "customization" }), WS("wks_seedaaaaaaa4", "Gone", "$ROOT/missing"), WS("wks_seedaaaaaaa5", "File", "$ROOT/afile"))),
     W("ws1/.claude/settings.json", '{"env":{"A":"1"},"model":"sonnet"}\n'),
     W("ws1/.claude/settings.local.json", '{"permissions":{"deny":["Read"]}}\n'),
     W("ws2/.claude/settings.json", "{}\n")),
  GET_EXPORT(),
  SL("project settings odd", W("ws2/.claude/settings.json", "5"), W("ws2/.claude/settings.local.json", '"ab"')),
  GET_EXPORT(),
  SL("project settings null", W("ws2/.claude/settings.json", "null")),
  GET_EXPORT(),
  SL("project settings malformed", W("ws2/.claude/settings.json", "{oops")),
  GET_EXPORT(),
  SL("project settings gone", RM("ws2/.claude")),
  SL("icons", W(`${ICONS}/wks_seedaaaaaaa1.png`, "PNGBYTES"), W(`${ICONS}/wks_seedaaaaaaa2.`, "noext")),
  GET_EXPORT(),
  SL("user settings null", W(USER, "null")),
  GET_EXPORT(),
  SL("user settings number", W(USER, "7")),
  GET_EXPORT(),
  SL("user settings string", W(USER, '"ab"')),
  GET_EXPORT(),
  SL("user settings malformed", W(USER, "{,}")),
  GET_EXPORT(),
  SL("user settings object", W(USER, '{"model":"opus"}\n')),
  SL("store entry rootPath not a string", W(STORE, store({ id: "wks_seedaaaaaaa1", name: "One", rootPath: 5 }))),
  GET_EXPORT(),
  SL("store entry null", W(STORE, `${JSON.stringify({ version: 1, workspaces: [null] }, null, 2)}\n`)),
  GET_EXPORT(),
  SL("store entry empty rootPath", W(STORE, store({ id: "wks_seedaaaaaaa1", name: "One", rootPath: "" }))),
  GET_EXPORT(),
  SL("store entry unknown keys", W(STORE, store({ id: "wks_seedaaaaaaa1", rootPath: "$ROOT/ws1", zz: [1, { b: 2 }], defaults: { permissionMode: "auto" } }))),
  GET_EXPORT(),
  SL(
    "customizations",
    W(`${CROOT}/index.json`, `${JSON.stringify({
      version: 1,
      customizations: [
        { id: "cust_aaaaaaaaaaaa", name: "A", createdAt: 1 },
        { id: "cust_bbbbbbbbbbbb", name: "B", createdAt: 2 },
        { id: "cust_cccccccccccc", name: "NeverPublished", createdAt: 3 },
      ],
      publishes: [
        { id: "pub_1", customizationId: "cust_aaaaaaaaaaaa", publishedAt: 10, files: [{ path: "a.ts", sha1: "x" }] },
        { id: "pub_2", customizationId: "cust_aaaaaaaaaaaa", publishedAt: 20, files: [{ path: "a.ts" }, { path: "sub/b.ts" }, { path: "gone.ts" }] },
        { id: "pub_3", customizationId: "cust_bbbbbbbbbbbb", publishedAt: 5, revertedAt: 7, files: [] },
        { id: "pub_4", customizationId: "cust_zzzzzzzzzzzz", publishedAt: 9, files: [{ path: "x" }] },
      ],
    }, null, 2)}\n`),
    W(`${CROOT}/cust_aaaaaaaaaaaa/src/a.ts`, "export const a = 1;\n"),
    W(`${CROOT}/cust_aaaaaaaaaaaa/src/sub/b.ts`, "export const b = 2;\n"),
  ),
  GET_EXPORT(),
  SL(
    "customizations odd file paths",
    W(`${CROOT}/index.json`, `${JSON.stringify({
      version: 1,
      customizations: [{ id: "cust_aaaaaaaaaaaa", name: "A", createdAt: 1 }],
      publishes: [
        {
          id: "pub_1",
          customizationId: "cust_aaaaaaaaaaaa",
          publishedAt: 10,
          files: [{ path: 5 }, {}, { path: "/a.ts" }, { path: "sub/../a.ts" }, { path: "sub" }, { path: "bin.ts" }, { path: "a.ts", sha1: "y" }],
        },
      ],
    }, null, 2)}\n`),
    WB(`${CROOT}/cust_aaaaaaaaaaaa/src/bin.ts`, [0xef, 0xbb, 0xbf, 0x61, 0xff, 0x62, 0xc0, 0x80, 0x0a]),
  ),
  GET_EXPORT(),
  SL("customizations publish with a null file", W(`${CROOT}/index.json`, `${JSON.stringify({
    version: 1,
    customizations: [{ id: "cust_aaaaaaaaaaaa", name: "A", createdAt: 1 }],
    publishes: [{ id: "pub_1", customizationId: "cust_aaaaaaaaaaaa", publishedAt: 10, files: [{ path: "a.ts" }, null] }],
  }, null, 2)}\n`)),
  GET_EXPORT(),
  SL("customizations publish without files", W(`${CROOT}/index.json`, `${JSON.stringify({
    version: 1,
    customizations: [{ id: "cust_aaaaaaaaaaaa", name: "A", createdAt: 1 }],
    publishes: [{ id: "pub_1", customizationId: "cust_aaaaaaaaaaaa", publishedAt: 10 }],
  }, null, 2)}\n`)),
  GET_EXPORT(),
  SL("customizations index malformed", W(`${CROOT}/index.json`, "{")),
  GET_EXPORT(),
];

// ------------------------------ import groups ------------------------------

const VALIDATE_STEPS = [
  SL("bad json"),
  POST_IMPORT(""),
  POST_IMPORT("{"),
  POST_IMPORT("nope"),
  POST_IMPORT(" \n "),
  RAW_IMPORT([0xef, 0xbb, 0xbf, 0x7b, 0x7d], "application/json"),
  RAW_IMPORT([0x22, 0xc0, 0x80, 0x22], "application/json"),
  SL("not a bundle"),
  POST_IMPORT("null"),
  POST_IMPORT("7"),
  POST_IMPORT('"s"'),
  POST_IMPORT("true"),
  POST_IMPORT("[]"),
  POST_IMPORT("{}"),
  JSON_IMPORT({ version: 2, workspaces: [] }),
  JSON_IMPORT({ version: "1", workspaces: [] }),
  POST_IMPORT('{"version":1.0,"workspaces":[]}'),
  POST_IMPORT('{"version":1e400,"workspaces":[]}'),
  JSON_IMPORT({ version: 1 }),
  JSON_IMPORT({ version: 1, workspaces: {} }),
  JSON_IMPORT({ version: 1, workspaces: [null] }),
  JSON_IMPORT({ version: 1, workspaces: [7] }),
  JSON_IMPORT({ version: 1, workspaces: ["s"] }),
  JSON_IMPORT({ version: 1, workspaces: [{}] }),
  JSON_IMPORT({ version: 1, workspaces: [{ meta: null }] }),
  JSON_IMPORT({ version: 1, workspaces: [{ meta: 5 }] }),
  JSON_IMPORT({ version: 1, workspaces: [{ meta: "x" }] }),
  JSON_IMPORT({ version: 1, workspaces: [{ meta: { id: "a" } }] }),
  JSON_IMPORT({ version: 1, workspaces: [{ meta: { id: 1, rootPath: "/a" } }] }),
  JSON_IMPORT({ version: 1, workspaces: [{ meta: { id: "a", rootPath: 1 } }] }),
  JSON_IMPORT({ version: 1, workspaces: [[]] }),
  SL("no system"),
  JSON_IMPORT({ version: 1, workspaces: [] }),
  SL("empty bundle"),
  JSON_IMPORT(bundle()),
  SL("done then re-read"),
  GET_ONE("$IMP2"),
  DEL_ONE("$IMP2"),
  GET_ONE("imp_0000000000000000"),
  DEL_ONE("imp_0000000000000000"),
  RESOLVE_ONE("imp_0000000000000000", { wsIndex: 0, decision: { kind: "skip" } }),
  SL("ids that escape the imports dir"),
  GET_ONE("%2E%2E"),
  GET_ONE("..%2F..%2Fsettings"),
  DEL_ONE("..%2F..%2Fsettings"),
];

const MULTIPART = (parts, boundary = "X", type) => {
  const text = parts.join("\r\n");
  return RAW_IMPORT([...Buffer.from(text, "utf8")], type ?? `multipart/form-data; boundary=${boundary}`);
};
const okBundle = JSON.stringify(bundle());

const MULTIPART_STEPS = [
  SL("file field"),
  MULTIPART(["--X", 'Content-Disposition: form-data; name="file"; filename="b.json"', "Content-Type: application/json", "", okBundle, "--X--", ""]),
  SL("no filename is a string"),
  MULTIPART(["--X", 'Content-Disposition: form-data; name="file"', "", okBundle, "--X--", ""]),
  SL("other field names"),
  MULTIPART(["--X", 'Content-Disposition: form-data; name="other"; filename="b.json"', "", okBundle, "--X--", ""]),
  SL("two file fields: the first wins"),
  MULTIPART([
    "--X",
    'Content-Disposition: form-data; name="file"; filename="a.json"',
    "",
    okBundle,
    "--X",
    'Content-Disposition: form-data; name="file"; filename="b.json"',
    "",
    "{}",
    "--X--",
    "",
  ]),
  SL("empty file"),
  MULTIPART(["--X", 'Content-Disposition: form-data; name="file"; filename="b.json"', "", "", "--X--", ""]),
  SL("bad json in the file"),
  MULTIPART(["--X", 'Content-Disposition: form-data; name="file"; filename="b.json"', "", "{oops", "--X--", ""]),
  SL("quoted boundary and uppercase type"),
  MULTIPART(["--Ab-9", 'Content-Disposition: form-data; name="file"; filename="b.json"', "", okBundle, "--Ab-9--", ""], "Ab-9", 'MULTIPART/Form-Data; Boundary="Ab-9"'),
  SL("the type only has to contain multipart/form-data"),
  MULTIPART(["--X", 'Content-Disposition: form-data; name="file"; filename="b.json"', "", okBundle, "--X--", ""], "X", "application/json; x=multipart/form-data; boundary=X"),
  SL("urlencoded with multipart in a parameter"),
  RAW_IMPORT([...Buffer.from("file=%7B%7D", "utf8")], "application/x-www-form-urlencoded; x=multipart/form-data"),
  SL("missing boundary"),
  MULTIPART(["--X", 'Content-Disposition: form-data; name="file"; filename="b.json"', "", okBundle, "--X--", ""], "X", "multipart/form-data"),
  SL("boundary mismatch"),
  MULTIPART(["--Y", 'Content-Disposition: form-data; name="file"; filename="b.json"', "", okBundle, "--Y--", ""]),
  SL("no closing boundary"),
  MULTIPART(["--X", 'Content-Disposition: form-data; name="file"; filename="b.json"', "", okBundle, ""]),
  SL("no content-disposition"),
  MULTIPART(["--X", "X-Other: 1", "", okBundle, "--X--", ""]),
  SL("unquoted name"),
  MULTIPART(["--X", "Content-Disposition: form-data; name=file", "", okBundle, "--X--", ""]),
  SL("lf only"),
  RAW_IMPORT([...Buffer.from(['--X', 'Content-Disposition: form-data; name="file"; filename="b.json"', "", okBundle, "--X--", ""].join("\n"), "utf8")], "multipart/form-data; boundary=X"),
  SL("empty body"),
  RAW_IMPORT([], "multipart/form-data; boundary=X"),
  SL("extra headers and a bom in the file"),
  RAW_IMPORT(
    [
      ...Buffer.from(
        ["--X", 'Content-Disposition: form-data; name="file"; filename="b.json"', "X-Extra:  1", "Content-Type: text/plain", "", ""].join("\r\n"),
        "utf8",
      ),
      0xef,
      0xbb,
      0xbf,
      ...Buffer.from(`${okBundle}\r\n--X--\r\n`, "utf8"),
    ],
    "multipart/form-data; boundary=X",
  ),
  SL("invalid utf-8 in the file"),
  RAW_IMPORT(
    [
      ...Buffer.from(["--X", 'Content-Disposition: form-data; name="file"; filename="b.json"', "", '{"version":1,"workspaces":[],"system":{},"x":"'].join("\r\n"), "utf8"),
      0xff,
      ...Buffer.from('"}\r\n--X--\r\n', "utf8"),
    ],
    "multipart/form-data; boundary=X",
  ),
];

const SYSTEM_STEPS = [
  SL("merge into empty", W(STORE, store())),
  JSON_IMPORT(
    bundle({
      system: {
        userSettings: { model: "opus", permissions: { allow: ["Bash", "Read"] }, nested: { a: 1 } },
        customizeSettings: { autoFixPrompt: "mine" },
        updaterSettings: { mode: "notify-only", remote: "fork", branch: "next", intervalHours: 2 },
        keybindings: { bindings: [{ key: "ctrl+s", command: "save" }], schema: 2 },
      },
    }),
  ),
  SL("merge over existing"),
  JSON_IMPORT(
    bundle({
      system: {
        userSettings: { model: "sonnet", permissions: { allow: ["Bash", "Edit"], deny: ["Write"] }, nested: { b: 2 } },
        keybindings: { bindings: [{ key: "ctrl+s", command: "save" }, { key: "ctrl+k", command: "cmd" }] },
      },
    }),
  ),
  SL("odd system values"),
  JSON_IMPORT(bundle({ system: { userSettings: [1, 2], keybindings: "s", updaterSettings: 5, customizeSettings: "x" } })),
  SL("falsy system values"),
  JSON_IMPORT(bundle({ system: { userSettings: 0, customizeSettings: null, updaterSettings: false, keybindings: "" } })),
  SL("updater knobs refused"),
  JSON_IMPORT(bundle({ system: { updaterSettings: { mode: "nope", remote: "   ", branch: null, intervalHours: 0 } } })),
  SL("system missing"),
  POST_IMPORT('{"version":1,"workspaces":[]}'),
  SL("system null"),
  POST_IMPORT('{"version":1,"workspaces":[],"system":null}'),
  SL("user settings malformed", W(USER, "{nope")),
  JSON_IMPORT(bundle({ system: { userSettings: { a: 1 } } })),
  SL("user settings is a symlink", RM(USER), MK("extra/dots"), W("extra/dots/settings.json", '{"linked":true}\n'), LN(USER, "$ROOT/extra/dots/settings.json")),
  JSON_IMPORT(bundle({ system: { userSettings: { fromBundle: 1 } } })),
  SL("keybindings malformed", RM(USER), W(KEYS, "{nope")),
  JSON_IMPORT(bundle({ system: { keybindings: { a: 1 } } })),
  SL("customizations restore", RM(KEYS)),
  JSON_IMPORT(
    bundle({
      customizations: [
        {
          meta: { id: "cust_aaaaaaaaaaaa", name: "A", createdAt: 1, workspaceId: "wks_legacy", description: "d" },
          publishedFiles: [
            { path: "a.ts", content: "export const a = 1;\n" },
            { path: "sub/b.ts", content: "deep\n" },
          ],
        },
      ],
    }),
  ),
  SL("customizations upsert over an existing record"),
  JSON_IMPORT(
    bundle({
      customizations: [{ meta: { id: "cust_aaaaaaaaaaaa", name: "A2" }, publishedFiles: [{ path: "a.ts", content: "changed\n" }] }],
    }),
  ),
  SL("customizations bad id"),
  JSON_IMPORT(bundle({ customizations: [{ meta: { id: "../escape" }, publishedFiles: [] }] })),
  JSON_IMPORT(bundle({ customizations: [{ meta: { id: "cust_AAAAAAAAAAAA" }, publishedFiles: [] }] })),
  JSON_IMPORT(bundle({ customizations: [{ meta: {} }] })),
  JSON_IMPORT(bundle({ customizations: [{ publishedFiles: [] }] })),
  JSON_IMPORT(bundle({ customizations: [null] })),
  SL("customizations traversal"),
  JSON_IMPORT(bundle({ customizations: [{ meta: { id: "cust_aaaaaaaaaaaa" }, publishedFiles: [{ path: "../../escaped.ts", content: "x" }] }] })),
  JSON_IMPORT(bundle({ customizations: [{ meta: { id: "cust_aaaaaaaaaaaa" }, publishedFiles: [{ path: "/abs.ts", content: "x" }] }] })),
  SL("customizations odd files"),
  ...[
    { path: 5, content: "x" },
    { content: "x" },
    { path: null, content: "x" },
    { path: "c.ts", content: 5 },
    { path: "c.ts" },
    { path: "c.ts", content: null },
    { path: "c.ts", content: { a: 1 } },
    { path: "c.ts", content: ["a", "b"] },
    { path: "d.ts", content: [] },
    { path: "e.ts", content: ["a", 1, "b"] },
    { path: "f.ts", content: [null] },
    { path: "g.ts", content: ["a", { b: 1 }] },
    { path: "h.ts", content: [["x"]] },
    { path: "i.ts", content: [true] },
    { path: "j/k.ts", content: 5 },
    { path: "c.ts", content: true },
    { path: "c.ts", content: 1.5 },
    null,
    7,
    { path: "", content: "x" },
    { path: ".", content: "x" },
    { path: "sub", content: "x" },
    { path: "sub/b.ts/x", content: "x" },
    { path: "new/dir/f.ts", content: `${U(0xe9)}${U(0x1f600)}` },
  ].map((f) => JSON_IMPORT(bundle({ customizations: [{ meta: { id: "cust_aaaaaaaaaaaa" }, publishedFiles: [f] }] }))),
  JSON_IMPORT(bundle({ customizations: [{ meta: { id: 5 }, publishedFiles: [] }] })),
  SL("customizations odd shapes"),
  JSON_IMPORT(bundle({ customizations: [] })),
  JSON_IMPORT(bundle({ customizations: {} })),
  JSON_IMPORT(bundle({ customizations: "ab" })),
  JSON_IMPORT(bundle({ customizations: [{ meta: { id: "cust_aaaaaaaaaaaa" }, publishedFiles: 5 }] })),
  JSON_IMPORT(bundle({ customizations: [{ meta: { id: "cust_aaaaaaaaaaaa" } }] })),
];

const FLOW_STEPS = [
  SL("missing root pauses", W(STORE, store())),
  JSON_IMPORT(bundle({ workspaces: [bws("wks_bundle00001", "Alpha", "$ROOT/nope")] })),
  SL("re-read is idempotent"),
  GET_ONE("$IMP1"),
  SL("heal to a real dir"),
  RESOLVE_ONE("$IMP1", { wsIndex: 0, decision: { kind: "heal", newRootPath: "$ROOT/ws1" } }),
  SL("the session file is gone"),
  GET_ONE("$IMP1"),
  SL("id collision"),
  JSON_IMPORT(bundle({ workspaces: [bws("wks_bundle00001", "Alpha2", "$ROOT/ws2")] })),
  SL("overwrite"),
  RESOLVE_ONE("$IMP2", { wsIndex: 0, decision: { kind: "overwrite" } }),
  SL("path collision then rename"),
  JSON_IMPORT(bundle({ workspaces: [bws("wks_bundle00002", "Beta", "$ROOT/ws2")] })),
  RESOLVE_ONE("$IMP3", { wsIndex: 0, decision: { kind: "rename", newName: " Beta Renamed " } }),
  SL("not a directory then skip"),
  JSON_IMPORT(bundle({ workspaces: [bws("wks_bundle00003", "Gamma", "$ROOT/afile")] })),
  RESOLVE_ONE("$IMP4", { wsIndex: 0, decision: { kind: "skip" } }),
  SL("two workspaces, settings and icons"),
  JSON_IMPORT(
    bundle({
      workspaces: [
        bws("wks_bundle00004", "Delta", "$ROOT/extra", {
          projectSettings: { model: "haiku", permissions: { allow: ["Bash"] } },
          localSettings: { env: { X: "1" } },
          iconBytes: { ext: "png", base64: "QUJD" },
        }),
        bws("wks_bundle00005", "Eps", "$ROOT/nope2"),
      ],
    }),
  ),
  RESOLVE_ONE("$IMP5", { wsIndex: 1, decision: { kind: "skip" } }),
  SL("resolve refusals"),
  JSON_IMPORT(bundle({ workspaces: [bws("wks_bundle00006", "Zeta", "$ROOT/nope3")] })),
  RESOLVE_ONE("$IMP6", "{"),
  RESOLVE_ONE("$IMP6", ""),
  RESOLVE_ONE("$IMP6", "null"),
  RESOLVE_ONE("$IMP6", "[]"),
  RESOLVE_ONE("$IMP6", "7"),
  RESOLVE_ONE("$IMP6", {}),
  RESOLVE_ONE("$IMP6", { wsIndex: "0", decision: { kind: "skip" } }),
  RESOLVE_ONE("$IMP6", { wsIndex: 0.5, decision: { kind: "skip" } }),
  RESOLVE_ONE("$IMP6", { wsIndex: -1, decision: { kind: "skip" } }),
  RESOLVE_ONE("$IMP6", '{"wsIndex":-0,"decision":{"kind":"skip"}}'),
  RESOLVE_ONE("$IMP6", '{"wsIndex":1e400,"decision":{"kind":"skip"}}'),
  RESOLVE_ONE("$IMP6", { wsIndex: 0 }),
  RESOLVE_ONE("$IMP6", { wsIndex: 0, decision: null }),
  RESOLVE_ONE("$IMP6", { wsIndex: 0, decision: "skip" }),
  RESOLVE_ONE("$IMP6", { wsIndex: 0, decision: [] }),
  RESOLVE_ONE("$IMP6", { wsIndex: 0, decision: {} }),
  RESOLVE_ONE("$IMP6", { wsIndex: 0, decision: { kind: "nope" } }),
  RESOLVE_ONE("$IMP6", { wsIndex: 0, decision: { kind: 7 } }),
  RESOLVE_ONE("$IMP6", { wsIndex: 0, decision: { kind: { a: 1 } } }),
  RESOLVE_ONE("$IMP6", { wsIndex: 9, decision: { kind: "skip" } }),
  RESOLVE_ONE("$IMP6", { wsIndex: 0, decision: { kind: "heal" } }),
  RESOLVE_ONE("$IMP6", { wsIndex: 0, decision: { kind: "heal", newRootPath: "" } }),
  RESOLVE_ONE("$IMP6", { wsIndex: 0, decision: { kind: "heal", newRootPath: "rel/ative" } }),
  RESOLVE_ONE("$IMP6", { wsIndex: 0, decision: { kind: "heal", newRootPath: 5 } }),
  RESOLVE_ONE("$IMP6", { wsIndex: 0, decision: { kind: "rename", newName: "   " } }),
  RESOLVE_ONE("$IMP6", { wsIndex: 0, decision: { kind: "rename", newName: "" } }),
  RESOLVE_ONE("$IMP6", { wsIndex: 0, decision: { kind: "rename" } }),
  SL("heal to a path that needs normalizing"),
  RESOLVE_ONE("$IMP6", { wsIndex: 0, decision: { kind: "heal", newRootPath: "$ROOT/ws1/../extra/./" } }),
  SL("bundle meta without a name or icon"),
  JSON_IMPORT({ version: 1, system: {}, workspaces: [{ meta: { id: "wks_bundle00007", rootPath: "$ROOT/ws2" } }] }),
  SL("bundle meta with a null icon"),
  JSON_IMPORT({ version: 1, system: {}, workspaces: [{ meta: { id: "wks_bundle00008", name: "nul", rootPath: "$ROOT/project" } }] }),
  SL("empty project settings are skipped"),
  JSON_IMPORT(bundle({ workspaces: [bws("wks_bundle00009", "Eta", "$ROOT/ws1", { projectSettings: {}, localSettings: 5 })] })),
  RESOLVE_ONE("$IMP9", { wsIndex: 0, decision: { kind: "overwrite" } }),
];

const IMP1_FILE = "home/.claude/.claudius/imports/$IMP1.json";
/** A hand-written session file for `$IMP1` (cursor 0, system merged). */
const session = (over) =>
  `${JSON.stringify({ importId: "$IMP1", createdAt: 1, bundle: bundle(), mergeStrategy: "merge", cursor: 0, systemDone: true, decisions: {}, log: [], ...over }, null, 2)}\n`;

const TAMPER_STEPS = [
  SL("a paused import", W(STORE, store())),
  JSON_IMPORT(bundle({ workspaces: [bws("wks_bundle00001", "Alpha", "$ROOT/nope")] })),
  SL("session file replaced with an empty object", W("home/.claude/.claudius/imports/$IMP1.json", "{}\n")),
  GET_ONE("$IMP1"),
  SL("session file null", W("home/.claude/.claudius/imports/$IMP1.json", "null\n")),
  GET_ONE("$IMP1"),
  RESOLVE_ONE("$IMP1", { wsIndex: 0, decision: { kind: "skip" } }),
  SL("session file malformed", W("home/.claude/.claudius/imports/$IMP1.json", "{oops")),
  GET_ONE("$IMP1"),
  RESOLVE_ONE("$IMP1", { wsIndex: 0, decision: { kind: "skip" } }),
  DEL_ONE("$IMP1"),
  SL("a session whose cursor is past the end", W("home/.claude/.claudius/imports/$IMP1.json", `${JSON.stringify({ importId: "$IMP1", createdAt: 1, bundle: bundle(), mergeStrategy: "merge", cursor: 3, systemDone: true, decisions: {}, log: [{ wsIndex: 0, workspaceId: "w", action: "skipped" }] }, null, 2)}\n`)),
  GET_ONE("$IMP1"),
  SL("a session with a decision for __proto__", W("home/.claude/.claudius/imports/$IMP1.json", `${JSON.stringify({ importId: "$IMP1", createdAt: 1, bundle: { version: 1, system: {}, workspaces: [{ meta: { id: "__proto__", name: "P", rootPath: "$ROOT/nope" } }] }, mergeStrategy: "merge", cursor: 0, systemDone: true, decisions: {}, log: [] }, null, 2)}\n`)),
  GET_ONE("$IMP1"),
  RESOLVE_ONE("$IMP1", { wsIndex: 0, decision: { kind: "skip" } }),
  GET_ONE("$IMP1"),
  SL("a session without workspaces", W(IMP1_FILE, session({ bundle: { version: 1, system: {} } }))),
  GET_ONE("$IMP1"),
  SL("a session without decisions", W(IMP1_FILE, session({ bundle: bundle({ workspaces: [bws("wks_bundle00001", "Alpha", "$ROOT/nope")] }), decisions: undefined }))),
  GET_ONE("$IMP1"),
  RESOLVE_ONE("$IMP1", { wsIndex: 0, decision: { kind: "skip" } }),
  SL("a session whose workspace has no meta", W(IMP1_FILE, session({ bundle: { version: 1, system: {}, workspaces: [{}] } }))),
  GET_ONE("$IMP1"),
  RESOLVE_ONE("$IMP1", { wsIndex: 0, decision: { kind: "skip" } }),
  SL("unicode and odd strings in a bundle", RM("home/.claude/.claudius/imports")),
  JSON_IMPORT(
    bundle({
      system: { userSettings: { [`k${U(0xeb)}y`]: `v${U(0x1f600)}`, [`quo"te${BS}`]: 1 } },
      workspaces: [bws("wks_bundle0000a", `N${U(0xe9)}me ${U(0x1f600)}`, "$ROOT/ws1", { projectSettings: { [`a${U(0x2028)}b`]: "c" } })],
    }),
  ),
  RESOLVE_ONE("$IMP2", { wsIndex: 0, decision: { kind: "overwrite" } }),
];

const GROUPS = [
  { name: "export", steps: EXPORT_STEPS },
  { name: "validate", steps: VALIDATE_STEPS },
  { name: "multipart", steps: MULTIPART_STEPS },
  { name: "system", steps: SYSTEM_STEPS },
  { name: "flow", steps: FLOW_STEPS },
  { name: "tamper", steps: TAMPER_STEPS },
];

// ------------------------------ pure functions ------------------------------

const FILENAME_AT = [
  0, 1, -1, -0.5, 0.9, 1762000000000, 1700000000000, 86399999, 86400000, 253402300799999, -62167219200000,
  8640000000000000, -8640000000000000, 8640000000000001, -8640000000000001, 1e21, -1e21, 999999999999999, 1,
];
const filenames = FILENAME_AT.map((at) => [String(at), suggestedFilename(at)]);
filenames.push(["NaN", suggestedFilename(NaN)], ["Infinity", suggestedFilename(Infinity)], ["-Infinity", suggestedFilename(-Infinity)]);

const MERGE_PAIRS = [
  ["{}", "{}"],
  ['{"a":1}', '{"b":2}'],
  ['{"a":1}', '{"a":2}'],
  ['{"a":{"b":1,"c":2}}', '{"a":{"c":3,"d":4}}'],
  ['{"a":[1,2]}', '{"a":[2,3]}'],
  ['{"a":[1,1,2]}', '{"a":[2,2,3]}'],
  ['{"a":[{"x":1,"y":2}]}', '{"a":[{"y":2,"x":1},{"z":3}]}'],
  ['{"a":[[1,[2]]]}', '{"a":[[1,[2]],[3]]}'],
  ['{"a":[null,0,false,""]}', '{"a":["",false,0,null,"0"]}'],
  ['{"a":1}', '{"a":null}'],
  ['{"a":{"b":1}}', '{"a":null}'],
  ["null", '{"a":1}'],
  ['{"a":1}', "null"],
  ["[1,2]", '{"a":1}'],
  ['{"a":1}', "[1,2]"],
  ["[1,2]", "[2,3]"],
  ["7", "8"],
  ['"s"', '"t"'],
  ['{"a":1}', "7"],
  ["7", '{"a":1}'],
  ['{"a":[1]}', '{"a":{"0":1}}'],
  ['{"a":{"0":1}}', '{"a":[1]}'],
  ['{"a":1,"b":2,"c":3}', '{"c":30,"a":10}'],
  ['{"2":1,"10":2,"a":3}', '{"1":9,"a":30}'],
  ['{"a":{"b":{"c":{"d":1}}}}', '{"a":{"b":{"c":{"e":2}}}}'],
  ['{"a":[1e400]}', '{"a":[1e400,2]}'],
  ['{"a":1.0}', '{"b":1e2}'],
  ['{"a":"x"}', '{"a":{"b":1}}'],
  ['{"a":{"b":1}}', '{"a":"x"}'],
  ['{"__proto__":{"a":1}}', '{"__proto__":{"b":2}}'],
  ['{"toString":1}', '{"toString":2}'],
  ['{"a":1}', '{"toString":2}'],
  ['{"constructor":{"a":1}}', '{"constructor":{"b":2}}'],
  ["{}", '{"__proto__":{"b":2},"c":3}'],
  ['{"a":1}', '{"__proto__":5}'],
  ['{"a":1}', '{"constructor":null,"toString":null,"valueOf":{"a":1},"hasOwnProperty":0}'],
  ['{"x":{}}', '{"x":{"__lookupGetter__":null,"isPrototypeOf":null,"y":null}}'],
  ['{"constructor":2}', '{"constructor":null}'],
  ['{"a":[{"x":[1,{"y":2}]}]}', '{"a":[{"x":[1,{"y":2}]}]}'],
  [`{"k${BS}u00e9":1}`, `{"k${BS}u00e9":2}`],
  [`{"a":["${BS}u00e9","e"]}`, `{"a":["e","${BS}u00e9"]}`],
];
const merge = MERGE_PAIRS.map(([t, s]) => {
  try {
    const got = JSON.stringify(mergeDeep(JSON.parse(t), JSON.parse(s)));
    return { target: t, source: s, got: got === undefined ? null : got };
  } catch (e) {
    return { target: t, source: s, threw: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
  }
});

const VALIDATE_INPUTS = [
  "null",
  "7",
  '"s"',
  "true",
  "false",
  "[]",
  "{}",
  '{"version":1}',
  '{"version":1,"workspaces":[]}',
  '{"version":"1","workspaces":[]}',
  '{"version":1.0,"workspaces":[]}',
  '{"version":2,"workspaces":[]}',
  '{"version":1,"workspaces":{}}',
  '{"version":1,"workspaces":[null]}',
  '{"version":1,"workspaces":[0]}',
  '{"version":1,"workspaces":[""]}',
  '{"version":1,"workspaces":[[]]}',
  '{"version":1,"workspaces":[{}]}',
  '{"version":1,"workspaces":[{"meta":{}}]}',
  '{"version":1,"workspaces":[{"meta":{"id":"a"}}]}',
  '{"version":1,"workspaces":[{"meta":{"id":"a","rootPath":"/x"}}]}',
  '{"version":1,"workspaces":[{"meta":{"id":"a","rootPath":""}}]}',
  '{"version":1,"workspaces":[{"meta":{"id":"","rootPath":"/x"}}]}',
  '{"version":1,"workspaces":[{"meta":{"id":1,"rootPath":"/x"}}]}',
  '{"version":1,"workspaces":[{"meta":"x"}]}',
  '{"version":1,"workspaces":[{"meta":5}]}',
  '{"version":1,"workspaces":[{"meta":[]}]}',
  '{"version":1,"workspaces":[{"meta":{"id":"a","rootPath":"/x"}},{"meta":{"id":"b"}}]}',
  '[1,2]',
  '{"version":1,"workspaces":"ab"}',
];
const validate = VALIDATE_INPUTS.map((text) => [text, validateBundle(JSON.parse(text))]);

// --------------------------------- output ---------------------------------

const groups = [];
for (const g of GROUPS) groups.push(await runGroup(g));

writeFileSync(
  join(ROOT, "out.json"),
  JSON.stringify({ node: process.version, host: HOST, platform: platform(), prompt: DEFAULT_AUTO_FIX_PROMPT, filenames, merge, validate, world: WORLD, groups }),
);
process.exit(0);
