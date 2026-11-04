#!/usr/bin/env node
// Golden fixture for the settings routes (D10), recorded from the TS
// sources:
//
//   node rust/scripts/settings-routes-golden.mjs     (node@22)
//
// Re-runs itself under `--experimental-transform-types` with a resolve hook
// for the extensionless / `@/` imports, twice (two temp roots, both through
// realpath); both recordings must agree byte for byte. The child runs with
// its cwd at `<root>/project` (so `process.cwd()` is the first trusted root),
// HOME at `<root>/home`, CLAUDE_CONFIG_DIR at `<root>/config` and umask 022.
// `<root>/home/.claude/.claudius/workspaces.json` registers `<root>/ws` with
// `<root>/ws-extra` as an additional directory; `<root>/untrusted` exists
// but is not registered.
//
// Records `groups`: the real route handlers (`app/api/settings/route.ts`
// GET, `full` GET / PUT, `permissions` GET / POST, `auto-mode` GET / POST /
// DELETE, `additional-dirs` POST, `skill-overrides` GET / POST), called with
// `Request` objects, in order on one world per group (the trusted-cwd caches
// dropped first, as in a fresh server). A step is either `setup` (file
// operations, applied as written: `write` text or `bytes` (making its
// folder), `mkdir`, `rm`,
// `symlink`, `chmod`; a `label` names the section it starts) or a `request`
// (`method`, `url`, `body` text or `bodyBytes`; `$ROOT` stands for the
// root). Each request records `got` (status, content type and body text, or
// `threw`: Next's empty 500, with the error as `<name>: <message>` and any
// temp-file name as `.tmp-$PID-$SEQ`) and `changes` (every watched path whose
// entry differs from before the request: kind, mode, UTF-8 text or raw
// bytes, symlink target, or nothing for an unreadable file or folder; `null`
// when it is gone). `final` is every watched path at the end of the group.
//
// Written to rust/crates/claudius-server/tests/fixtures/settings_routes_golden.json
// and replayed by crates/claudius-server/tests/settings_routes.rs against
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
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "crates/claudius-server/tests/fixtures/settings_routes_golden.json");

// ------------------------------- recording -------------------------------

if (!process.env.SETTINGS_ROUTES_GOLDEN_ROOT) {
  const runs = [0, 1].map(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "settings-routes-golden-")));
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
            SETTINGS_ROUTES_GOLDEN_ROOT: root,
          },
        },
      );
      if (r.status !== 0) {
        process.stderr.write(r.stderr);
        process.exit(r.status ?? 1);
      }
      return readFileSync(join(root, "out.json"), "utf8");
    } finally {
      // Undo any mode a group left behind, so the tree can go.
      spawnSync("chmod", ["-R", "u+rwx", root]);
      rmSync(root, { recursive: true, force: true });
    }
  });
  if (runs[0] !== runs[1]) throw new Error("the two recordings differ");
  const fixture = JSON.parse(runs[0]);
  writeFileSync(out, `${JSON.stringify(fixture, null, 1)}\n`);
  const steps = fixture.groups.reduce((n, g) => n + g.steps.filter((s) => s.request).length, 0);
  console.log(`wrote ${out.slice(repo.length + 1)}: ${fixture.groups.length} groups (${steps} requests, node ${fixture.node})`);
  process.exit(0);
}

// --------------------------------- child ---------------------------------

const ROOT = process.env.SETTINGS_ROUTES_GOLDEN_ROOT;
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

const ROUTES = {
  "/api/settings": await import(join(repo, "app/api/settings/route.ts")),
  "/api/settings/full": await import(join(repo, "app/api/settings/full/route.ts")),
  "/api/settings/permissions": await import(join(repo, "app/api/settings/permissions/route.ts")),
  "/api/settings/auto-mode": await import(join(repo, "app/api/settings/auto-mode/route.ts")),
  "/api/settings/additional-dirs": await import(join(repo, "app/api/settings/additional-dirs/route.ts")),
  "/api/settings/skill-overrides": await import(join(repo, "app/api/settings/skill-overrides/route.ts")),
};
const { __resetTrustedCwdCache } = await import(join(repo, "lib/server/trusted-cwd.ts"));

/** Characters by code point, so this file stays ASCII. */
const U = (...cps) => String.fromCodePoint(...cps);
/** A backslash, for escapes inside raw JSON text. */
const BS = String.fromCharCode(92);

// --------------------------------- worlds ---------------------------------

const toAbs = (s) => s.replaceAll("$ROOT", ROOT);
const toRel = (s) => s.replaceAll(ROOT, "$ROOT");
/** Temp-file names carry the pid and a per-process counter. */
const normalize = (s) => toRel(s).replace(/\.tmp-\d+-\d+/g, ".tmp-$PID-$SEQ");

/** The watched paths: everything the routes could touch, and decoys. */
const WATCH = ["home", "project", "ws", "ws-extra", "untrusted", "config", "shared"];
const SKIP = new Set(["home/.claude/.claudius", "home/.claude/projects"]);
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function snapshot() {
  const snap = {};
  const visit = (rel) => {
    if (SKIP.has(rel)) return;
    const abs = join(ROOT, rel);
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
      snap[rel] = text === null ? { kind: "file", mode: st.mode & 0o777, bytes: [...buf] } : { kind: "file", mode: st.mode & 0o777, text: toRel(text) };
    }
  };
  for (const w of WATCH) visit(w);
  return snap;
}

function changes(before, after) {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return keys
    .filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
    .map((k) => [k, after[k] ?? null]);
}

const WORLD = {
  dirs: ["home/.claude/.claudius", "project", "ws", "ws-extra", "untrusted", "config"],
  files: [
    [
      "home/.claude/.claudius/workspaces.json",
      `${JSON.stringify(
        {
          version: 1,
          workspaces: [
            {
              id: "wks_golden00001",
              name: "ws",
              rootPath: "$ROOT/ws",
              icon: { kind: "letter", letter: "W", color: "#d97757" },
              createdAt: 1,
              updatedAt: 1,
              defaults: { additionalDirectories: ["$ROOT/ws-extra"] },
            },
          ],
        },
        null,
        2,
      )}\n`,
    ],
    // Decoys nothing reads: the CLI config dir's settings, an untrusted project's.
    ["config/settings.json", '{"decoy":"config dir"}\n'],
    ["untrusted/.claude/settings.json", '{"decoy":"untrusted"}\n'],
    ["ws/.claude/settings.json", '{"where":"ws project"}\n'],
    ["ws-extra/.claude/settings.local.json", '{"where":"ws-extra local"}\n'],
  ],
};

function buildWorld() {
  spawnSync("chmod", ["-R", "u+rwx", ROOT]);
  // The project dir is this process's cwd: emptied, never removed.
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
    writeFileSync(join(ROOT, p), toAbs(text));
  }
}

function apply(op) {
  const p = join(ROOT, op.path);
  switch (op.op) {
    case "write":
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, op.bytes ? Buffer.from(op.bytes) : toAbs(op.text));
      break;
    case "mkdir":
      mkdirSync(p, { recursive: true });
      break;
    case "rm":
      rmSync(p, { recursive: true, force: true });
      break;
    case "symlink":
      symlinkSync(toAbs(op.target), p);
      break;
    case "chmod":
      chmodSync(p, op.mode);
      break;
    default:
      throw new Error(`unknown op ${op.op}`);
  }
}

// --------------------------------- requests ---------------------------------

async function call(req) {
  if (!/^[\x21-\x7e]+$/.test(req.url) || req.url.includes("#")) throw new Error(`url must be plain ASCII: ${req.url}`);
  const init = { method: req.method };
  if (req.body !== undefined) init.body = toAbs(req.body);
  if (req.bodyBytes !== undefined) init.body = new Uint8Array(req.bodyBytes);
  const request = new Request(`http://localhost${toAbs(req.url)}`, init);
  const mod = ROUTES[req.url.split("?")[0]];
  if (!mod || !mod[req.method]) throw new Error(`no handler for ${req.method} ${req.url}`);
  try {
    const res = await mod[req.method](request);
    return { status: res.status, type: res.headers.get("content-type"), body: toRel(await res.text()) };
  } catch (e) {
    return { threw: normalize(e instanceof Error ? `${e.name}: ${e.message}` : String(e)) };
  }
}

async function runGroup(group) {
  buildWorld();
  __resetTrustedCwdCache();
  const steps = [];
  for (const step of group.steps) {
    if (step.setup) {
      for (const op of step.setup) apply(op);
      steps.push(step);
      continue;
    }
    const before = snapshot();
    const got = await call(step);
    const after = snapshot();
    const request = { method: step.method, url: step.url };
    if (step.body !== undefined) request.body = step.body;
    if (step.bodyBytes !== undefined) request.bodyBytes = step.bodyBytes;
    steps.push({ request, got, changes: changes(before, after) });
  }
  return { name: group.name, steps, final: snapshot() };
}

// ---------------------------------- steps ----------------------------------

const USER = "home/.claude/settings.json";
const PROJ = "project/.claude/settings.json";
const LOCAL = "project/.claude/settings.local.json";
const WSLOCAL = "ws/.claude/settings.local.json";
const PATH_OF = { user: USER, project: PROJ, local: LOCAL };

const S = (...ops) => ({ setup: ops });
/** A setup that starts a named section (the Rust replay lists some as differences). */
const SL = (label, ...ops) => ({ setup: ops, label });
const W = (path, text) => ({ op: "write", path, text });
const WB = (path, bytes) => ({ op: "write", path, bytes });
const RM = (path) => ({ op: "rm", path });
const MK = (path) => ({ op: "mkdir", path });
const LN = (path, target) => ({ op: "symlink", path, target });
const CH = (path, mode) => ({ op: "chmod", path, mode });
const J = (v) => JSON.stringify(v);
const text = (body) => (typeof body === "string" ? body : J(body));

const q = (path, query) => ({ method: "GET", url: `${path}${query ? `?${query}` : ""}` });
const GET_S = (query) => q("/api/settings", query);
const GET_FULL = (query) => q("/api/settings/full", query);
const PUT_FULL = (body) => ({ method: "PUT", url: "/api/settings/full", body: text(body) });
const GET_PERM = (query) => q("/api/settings/permissions", query);
const POST_PERM = (body) => ({ method: "POST", url: "/api/settings/permissions", body: text(body) });
const GET_AUTO = (query) => q("/api/settings/auto-mode", query);
const POST_AUTO = (body) => ({ method: "POST", url: "/api/settings/auto-mode", body: text(body) });
const DEL_AUTO = (query) => ({ method: "DELETE", url: `/api/settings/auto-mode${query ? `?${query}` : ""}` });
const POST_DIRS = (body) => ({ method: "POST", url: "/api/settings/additional-dirs", body: text(body) });
const GET_SKILL = (query) => q("/api/settings/skill-overrides", query);
const POST_SKILL = (body) => ({ method: "POST", url: "/api/settings/skill-overrides", body: text(body) });

/** Remove every settings file the routes write in the default world. */
const CLEAN = S(RM(USER), RM(PROJ), RM(LOCAL), RM("project/.claude"), RM(WSLOCAL));

// ---- cwd resolution, on every route ----

const CWDS = [
  "",
  "cwd=",
  "cwd=%20%09",
  "cwd=%EF%BB%BF",
  "cwd=%C2%85",
  "cwd=%C2%A0",
  "cwd=$ROOT/untrusted",
  "cwd=$ROOT/nowhere",
  "cwd=$ROOT/ws",
  "cwd=$ROOT/ws-extra",
  "cwd=$ROOT/project/",
  "cwd=$ROOT/ws/../project",
  "cwd=.",
  "cwd=..%2Fws",
  "cwd=ws",
  "cwd=$ROOT/ws&cwd=$ROOT/untrusted",
  "cwd=$ROOT/untrusted&cwd=$ROOT/ws",
  "CWD=$ROOT/untrusted",
  "cwd=%00",
  "cwd=$ROOT%2Fws",
  "cwd=$ROOT/w+s",
  "cwd=%E0%A4%A",
  "cwd=%FF",
];
const BODY_CWDS = [undefined, "", " ", U(0xfeff), U(0x85), "$ROOT/untrusted", "$ROOT/nowhere", "$ROOT/ws", "$ROOT/ws-extra", "$ROOT/project/", "ws", 5, null, true, [], {}, ["$ROOT/ws"]];
const withCwd = (cwd, body) => (cwd === undefined ? body : { ...body, cwd });

const CWD_STEPS = [
  S(W(USER, '{"who":"user"}\n'), MK("project/.claude"), W(PROJ, '{"who":"project"}\n'), W(LOCAL, '{"who":"local"}\n'), W(WSLOCAL, '{"who":"ws local"}\n')),
  ...CWDS.flatMap((c) => [
    GET_S(c),
    GET_S(c ? `${c}&scope=project` : "scope=project"),
    GET_S(c ? `${c}&scope=bogus` : "scope=bogus"),
    GET_FULL(c),
    GET_PERM(c),
    GET_AUTO(c),
    GET_SKILL(c),
    DEL_AUTO(c),
  ]),
  S(W(USER, '{"who":"user"}\n'), W(PROJ, '{"who":"project"}\n'), W(LOCAL, '{"who":"local"}\n'), W(WSLOCAL, '{"who":"ws local"}\n')),
  ...BODY_CWDS.flatMap((cwd) => [
    PUT_FULL(withCwd(cwd, { scope: "local", settings: { cwd: cwd ?? "absent" } })),
    POST_PERM(withCwd(cwd, { scope: "project", patch: { allow: [`cwd ${J(cwd)}`] } })),
    POST_AUTO(withCwd(cwd, { patch: { environment: [`cwd ${J(cwd)}`] } })),
    POST_DIRS(withCwd(cwd, { scope: "local", add: [`/d/${J(cwd)}`] })),
    POST_SKILL(withCwd(cwd, { name: `s${J(cwd)}`, value: "off" })),
  ]),
  PUT_FULL('{"scope":"local","settings":{"inf":true},"cwd":1e400}'),
  POST_SKILL('{"name":"inf","value":"off","cwd":-1e400}'),
  GET_FULL("cwd=$ROOT/ws"),
  GET_FULL(),
];

// ---- every route on every file shape ----

const NUMS = `{"n":1.0,"x":1e2,"neg":-0.0,"big":12345678901234567890,"tiny":5e-324,"e21":1e21,"f":0.1,"2":true,"a":{"10":1,"b":2,"1":3},"after":[1.50,-0.0,1e-7]}\n`;
/** File shapes: text, bytes, or absent. */
const SHAPES = [
  ["missing", null],
  ["empty object", "{}"],
  ["plain", '{"model":"opus","permissions":{"allow":["Bash(ls)"],"defaultMode":"default"},"autoMode":{"allow":["$defaults"]},"skillOverrides":{"pdf":"off","x":"name-only"}}\n'],
  ["null", "null"],
  ["null padded", " \n null \t"],
  ["array", '[1,{"a":2}]'],
  ["empty array", "[]"],
  ["string", '"ab"'],
  ["empty string", '""'],
  ["number", "5"],
  ["zero", "0"],
  ["true", "true"],
  ["false", "false"],
  ["infinity", "1e400"],
  ["minus infinity", "-1e400"],
  ["empty file", ""],
  ["whitespace", "  \n"],
  ["malformed", '{"a":'],
  ["echo", '{"apiKeyHelper": "secret-value" oops}'],
  ["bom", `${U(0xfeff)}{}`],
  ["invalid utf-8", [0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0xfe, 0x22, 0x7d]],
  ["numbers", NUMS],
  ["duplicate keys", '{"permissions":{"allow":["a"]},"b":2,"permissions":{"deny":["d"]},"autoMode":1,"autoMode":{"allow":["x"]}}'],
  ["proto keys", '{"__proto__":{"x":1},"permissions":{"__proto__":["p"],"additionalDirectories":["/p"]},"skillOverrides":{"__proto__":"off"}}'],
  ["unicode", `{"${U(0xe9)}t${U(0xe9)}":"${U(0x4e2d)}${U(0x1f600)}","permissions":{"allow":["Read(${U(0x1f600)})"]},"${U(0x2028)}":"${BS}u2029"}`],
  ["escapes", `{"a":"${BS}u0000${BS}n${BS}t${BS}"${BS}${BS}${BS}/${BS}u001f${BS}u007f"}`],
  ["nested infinity", '{"permissions":1e400,"autoMode":-1e400,"skillOverrides":1e400}'],
  ["nested null", '{"permissions":null,"autoMode":null,"skillOverrides":null}'],
  ["nested string", '{"permissions":"ab","autoMode":"cd","skillOverrides":"ef"}'],
  ["nested array", '{"permissions":[1,["x"]],"autoMode":["x"],"skillOverrides":["on","off"]}'],
  ["nested number", '{"permissions":0,"autoMode":5,"skillOverrides":true}'],
  ["nested false", '{"permissions":false,"autoMode":false,"skillOverrides":false}'],
  ["nested empty", '{"permissions":{},"autoMode":{},"skillOverrides":{}}'],
  ["integer keys", '{"b":1,"10":2,"2":3,"a":{"1":1,"0":0,"x":2},"permissions":{"9":"n","allow":["a"],"1":"o"},"4294967295":1,"4294967294":2,"01":3}'],
  ["perm infinity values", '{"permissions":{"allow":1e400,"additionalDirectories":["/a",1e400,null,1e400,-1e400]}}'],
];
/** Shapes where Rust differs (see GAPS in the Rust test). */
const GAP_SHAPES = [
  ["lone surrogate", `{"a":"${BS}ud800","permissions":{"allow":["${BS}udc00"]},"skillOverrides":{"${BS}ud83d":"off"}}`],
  ["astral string", `"a${U(0x1f600)}"`],
  ["nested past 128 levels", `{"permissions":{"allow":["a"]},"deep":${"[".repeat(130)}${"]".repeat(130)}}`],
];
const writeShape = (path, shape) => (shape === null ? RM(path) : typeof shape === "string" ? W(path, shape) : WB(path, shape));

function shapeSteps(name, shape) {
  const steps = [];
  for (const scope of ["user", "project", "local"]) {
    const path = PATH_OF[scope];
    const put = () => S(CLEAN.setup[0], RM(PROJ), RM(LOCAL), MK("project/.claude"), writeShape(path, shape));
    steps.push(SL(`${name} / ${scope}`, ...put().setup));
    steps.push(GET_S(`scope=${scope}`));
    steps.push(GET_S());
    steps.push(GET_FULL());
    steps.push(GET_PERM());
    steps.push(POST_PERM({ scope, patch: { allow: ["Bash(git *)"], deny: [] } }));
    steps.push(put());
    steps.push(POST_DIRS({ scope, add: ["/added", "/p"], remove: ["/a"] }));
    steps.push(put());
    steps.push(POST_DIRS({ scope, remove: ["/p", "/added"] }));
    steps.push(put());
    steps.push(PUT_FULL({ scope, settings: { replaced: scope } }));
    if (scope === "user") {
      steps.push(put());
      steps.push(GET_AUTO());
      steps.push(POST_AUTO({ patch: { soft_deny: ["no prod"] } }));
      steps.push(put());
      steps.push(DEL_AUTO());
    }
    if (scope === "project") {
      steps.push(put());
      steps.push(GET_SKILL());
      steps.push(POST_SKILL({ name: "pdf", value: "on" }));
      steps.push(put());
      steps.push(POST_SKILL({ name: "pdf", value: "user-invocable-only" }));
      steps.push(put());
      steps.push(POST_SKILL({ name: "x", value: "on" }));
    }
  }
  return steps;
}

const SHAPE_STEPS = SHAPES.flatMap(([name, shape]) => shapeSteps(name, shape));
const GAP_STEPS = GAP_SHAPES.flatMap(([name, shape]) => shapeSteps(name, shape));

// ---- bodies ----

const ODD_BODIES = ["", "{", "not json", "null", "[]", '"user"', "5", "true", "{}", `${U(0xfeff)}{}`, `${U(0xfeff)}${U(0xfeff)}{}`, `${U(0xfeff)}${U(0xfeff)}${U(0xfeff)}{}`, " {} ", "{}x", "1e400"];
const SCOPE_VALUES = [undefined, "user", "project", "local", "global", "USER", " user", "", null, 0, 1, true, ["user"], { user: 1 }, "1e400"];
const scoped = (scope, rest) => (scope === "1e400" ? `{"scope":1e400,${J(rest).slice(1)}` : J(scope === undefined ? rest : { scope, ...rest }));

const FULL_STEPS = [
  ...ODD_BODIES.map((b) => PUT_FULL(b)),
  { method: "PUT", url: "/api/settings/full", bodyBytes: [0x7b, 0x22, 0x73, 0x63, 0x6f, 0x70, 0x65, 0x22, 0x3a, 0x22, 0x75, 0x73, 0x65, 0x72, 0x22, 0x2c, 0x22, 0x73, 0x65, 0x74, 0x74, 0x69, 0x6e, 0x67, 0x73, 0x22, 0x3a, 0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d, 0x7d] },
  ...SCOPE_VALUES.map((scope) => PUT_FULL(scoped(scope, { settings: { scope: J(scope) } }))),
  CLEAN,
  ...[undefined, null, 0, "", "x", true, false, [], [1, { a: 2 }], {}, { a: 1 }].map((settings) =>
    PUT_FULL(settings === undefined ? { scope: "user" } : { scope: "user", settings }),
  ),
  PUT_FULL('{"scope":"user","settings":1e400}'),
  PUT_FULL('{"scope":"user","settings":-1e400}'),
  GET_S("scope=user"),
  PUT_FULL(`{"scope":"project","settings":${NUMS.trim()}}`),
  GET_S("scope=project"),
  PUT_FULL('{"scope":"project","settings":{"a":1e400,"b":[1e400,-1e400,null],"c":{"d":-1e400}}}'),
  GET_S("scope=project"),
  PUT_FULL('{"scope":"local","settings":{"b":1,"a":2,"b":3,"10":4,"2":5,"__proto__":{"p":1},"constructor":6}}'),
  GET_FULL(),
  PUT_FULL({ scope: "local", settings: { [U(0xe9)]: U(0x1f600), k: `${U(0x2028)}${U(0x2029)}${U(0)}${U(0x1f)}${U(0x7f)}"${BS}/`, nested: { deeper: [[], {}, [[]], [{}]] } } }),
  GET_FULL(),
  PUT_FULL(`{"scope":"user","scope":"local","settings":{"first":1},"settings":{"second":2}}`),
  PUT_FULL({ scope: "user", settings: { toJSON: 1, valueOf: "x" } }),
  GET_S(),
  // modes, symlinks and failing writes
  S(CH(USER, 0o600)),
  PUT_FULL({ scope: "user", settings: { mode: "kept" } }),
  S(CH(USER, 0o644), MK("shared"), RM(LOCAL), W("shared/target.json", '{"linked":true}\n'), LN(LOCAL, "../../shared/target.json")),
  GET_S("scope=local"),
  PUT_FULL({ scope: "local", settings: { through: "link" } }),
  S(RM(LOCAL), LN(LOCAL, "../../shared/dangling.json")),
  GET_S("scope=local"),
  PUT_FULL({ scope: "local", settings: { dangling: "created" } }),
  S(RM(LOCAL), RM("shared"), LN(LOCAL, "../../nowhere/x.json")),
  PUT_FULL({ scope: "local", settings: { dangling: "no dir" } }),
  S(RM(LOCAL), MK(LOCAL)),
  GET_S("scope=local"),
  GET_S(),
  PUT_FULL({ scope: "local", settings: { onto: "a folder" } }),
  S(W(`${LOCAL}/inner`, "x")),
  PUT_FULL({ scope: "local", settings: { onto: "a full folder" } }),
  S(RM(LOCAL), W(LOCAL, '{"locked":true}\n'), CH(LOCAL, 0o000)),
  GET_S("scope=local"),
  GET_PERM(),
  PUT_FULL({ scope: "local", settings: { over: "unreadable" } }),
  S(CH(LOCAL, 0o644), CH("project/.claude", 0o555)),
  PUT_FULL({ scope: "local", settings: { in: "read-only dir" } }),
  POST_PERM({ scope: "local", patch: { allow: ["x"] } }),
  S(CH("project/.claude", 0o755), RM("project/.claude"), W("project/.claude", "a file")),
  GET_S("scope=project"),
  PUT_FULL({ scope: "project", settings: { under: "a file" } }),
  POST_SKILL({ name: "a", value: "off" }),
  S(RM("project/.claude"), CH("project", 0o555)),
  PUT_FULL({ scope: "project", settings: { mkdir: "refused" } }),
  S(CH("project", 0o755)),
  PUT_FULL({ scope: "project", settings: { mkdir: "ok" } }),
];

const PATCHES = [undefined, null, false, 0, "", "x", 5, true, [], ["a", "b"], {}, { allow: ["Read"] }, { allow: null, deny: ["Write"] }, { "1": "one", ask: [] }];

const PERM_STEPS = [
  ...ODD_BODIES.map((b) => POST_PERM(b)),
  ...SCOPE_VALUES.map((scope) => POST_PERM(scoped(scope, { patch: { allow: [J(scope)] } }))),
  CLEAN,
  ...PATCHES.map((patch) => POST_PERM(patch === undefined ? { scope: "user" } : { scope: "user", patch })),
  POST_PERM('{"scope":"user","patch":1e400}'),
  POST_PERM('{"scope":"user","patch":{"allow":1e400,"deny":[1e400]}}'),
  GET_PERM(),
  S(W(PROJ, '{"z":1,"permissions":{"deny":["d"],"allow":["a"]},"a":2}\n')),
  POST_PERM({ scope: "project", patch: { allow: ["b"], ask: ["c"] } }),
  POST_PERM({ scope: "project", patch: { "__proto__": { polluted: true }, constructor: "c" } }),
  POST_PERM('{"scope":"project","patch":{"__proto__":["x"],"2":"two"}}'),
  POST_PERM({ scope: "project", patch: { defaultMode: "acceptEdits", blockReadsOutsideWorkingDirectories: true, additionalDirectories: ["/x"] } }),
  POST_PERM(`{"scope":"project","patch":{"allow":["${U(0x1f600)}"],"allow":["dup"]}}`),
  GET_PERM(),
  GET_PERM("cwd=$ROOT/ws"),
  POST_PERM({ scope: "local", cwd: "$ROOT/ws", patch: { allow: ["ws"] } }),
  GET_PERM("cwd=$ROOT/ws"),
  S(W(USER, "null")),
  GET_PERM(),
  S(W(USER, "{}"), W(PROJ, "["), W(LOCAL, "null")),
  GET_PERM(),
  S(W(PROJ, "{}")),
  GET_PERM(),
];

const AUTO_STEPS = [
  ...ODD_BODIES.map((b) => POST_AUTO(b)),
  ...PATCHES.map((patch) => POST_AUTO(patch === undefined ? {} : { patch })),
  POST_AUTO('{"patch":1e400}'),
  POST_AUTO('{"patch":{"allow":[1e400],"hard_deny":-1e400}}'),
  GET_AUTO(),
  POST_AUTO({ patch: { environment: ["Trusted repo: github.com/acme"], allow: ["$defaults", "deploy to staging"] } }),
  POST_AUTO({ patch: { allow: ["replaced"], soft_deny: ["x"] } }),
  POST_AUTO({ scope: "project", cwd: "$ROOT/ws", patch: { hard_deny: ["rm -rf /"] } }),
  GET_AUTO("cwd=$ROOT/ws"),
  DEL_AUTO("cwd=$ROOT/ws"),
  DEL_AUTO(),
  GET_AUTO(),
  { method: "DELETE", url: "/api/settings/auto-mode", body: '{"cwd":"$ROOT/untrusted"}' },
  S(W(USER, '{"a":1,"autoMode":{"allow":["x"]},"b":2}\n')),
  DEL_AUTO(),
  S(W(USER, '{"autoMode":{"allow":["x"]},"a":1,"b":2}\n')),
  DEL_AUTO(),
  S(W(USER, '{"autoMode":null}')),
  DEL_AUTO(),
  S(W(USER, '{"autoMode":1e400,"z":1}')),
  GET_AUTO(),
  DEL_AUTO(),
];

const ADDS = [undefined, null, [], ["/a"], "str", "", 5, 0, {}, true, false, [5], [null], ["/a", 5], [{}], [[]], [true], ["/ok", null]];
const REMOVES = [undefined, null, [], ["/a"], "/ab", "", 5, 0, {}, true, false, [5], [null], [{}], [["/a"]], ["/a", "/a"]];
const NETWORK = [
  `${BS}${BS}server${BS}share`,
  `${BS}${BS}server`,
  `${BS}${BS}${BS}x`,
  `${BS}${BS}s${BS}`,
  ` ${BS}${BS}s${BS}x `,
  `${BS}server${BS}share`,
  `//server/share`,
  "/net/host",
  "/net/host/x",
  "/net/",
  "/net//x",
  "/net/h\n",
  "\t/net/h ",
  "/NET/h",
  "//net/h",
  "/network/h",
  "/net",
  "net/h",
  `${U(0xa0)}/net/h`,
  `${U(0xfeff)}${BS}${BS}a${BS}b`,
  `${U(0x85)}/net/h`,
  `${U(0x3000)}/net/${U(0x1f600)}`,
  `/net/${U(0x1f600)}`,
  `${BS}${BS}${U(0x4e2d)}${BS}`,
  "/net/\n",
];

const DIRS_STEPS = [
  ...ODD_BODIES.map((b) => POST_DIRS(b)),
  ...SCOPE_VALUES.map((scope) => POST_DIRS(scoped(scope, { add: [`/s/${J(scope)}`] }))),
  CLEAN,
  ...ADDS.map((add) => POST_DIRS(add === undefined ? { scope: "local" } : { scope: "local", add })),
  POST_DIRS('{"scope":"local","add":1e400}'),
  POST_DIRS('{"scope":"local","add":[1e400]}'),
  POST_DIRS('{"scope":"local","add":["/b",-1e400]}'),
  CLEAN,
  ...REMOVES.map((remove) => POST_DIRS(remove === undefined ? { scope: "local", add: ["/a", "/b", "/"] } : { scope: "local", add: ["/a", "/b", "/"], remove })),
  POST_DIRS('{"scope":"local","remove":1e400}'),
  POST_DIRS('{"scope":"local","remove":[1e400]}'),
  CLEAN,
  ...NETWORK.map((p) => POST_DIRS({ scope: "local", add: ["/fine", p] })),
  POST_DIRS({ scope: "local", add: NETWORK }),
  POST_DIRS({ scope: "local", add: ["/net/a", "/fine", `${BS}${BS}b${BS}c`], cwd: "$ROOT/untrusted" }),
  POST_DIRS({ scope: "nope", add: ["/net/a"] }),
  POST_DIRS({ scope: "local", add: ["/net/a", 5] }),
  POST_DIRS({ scope: "local", add: [5, "/net/a"] }),
  GET_S("scope=local"),
  CLEAN,
  // the existing list
  S(MK("project/.claude"), W(LOCAL, '{"permissions":{"additionalDirectories":["/a","/a","/b",1,1.0,0,-0.0,null,null,true,true,{},{},[],"1"]}}')),
  POST_DIRS({ scope: "local", add: ["/a", "/c", "/c"], remove: ["/b", 1, 0, null, true, {}, "/zz"] }),
  S(W(LOCAL, '{"permissions":{"additionalDirectories":[1e400,null,1e400,-1e400,"x"]}}')),
  POST_DIRS({ scope: "local", add: ["x"] }),
  S(W(LOCAL, '{"permissions":{"additionalDirectories":[1e400,null,-1e400]}}')),
  POST_DIRS('{"scope":"local","remove":[1e400]}'),
  S(W(LOCAL, '{"permissions":{"additionalDirectories":"/a,/b"}}')),
  POST_DIRS({ scope: "local", add: ["/c"] }),
  S(W(LOCAL, '{"permissions":{"additionalDirectories":{"0":"/a"}}}')),
  POST_DIRS({ scope: "local", add: ["/c"] }),
  S(W(LOCAL, '{"permissions":{"additionalDirectories":null,"allow":["k"]}}')),
  POST_DIRS({ scope: "local" }),
  // emptied permissions block: dropped when every value is null
  S(W(LOCAL, '{"a":1,"permissions":{"additionalDirectories":["/a"]},"b":2}')),
  POST_DIRS({ scope: "local", remove: ["/a"] }),
  S(W(LOCAL, '{"permissions":{"additionalDirectories":["/a"]},"a":1,"b":2}')),
  POST_DIRS({ scope: "local", remove: ["/a"] }),
  S(W(LOCAL, '{"permissions":{"additionalDirectories":["/a"],"allow":["x"],"deny":["y"]},"a":1}')),
  POST_DIRS({ scope: "local", remove: ["/a"] }),
  S(W(LOCAL, '{"permissions":{"allow":null,"additionalDirectories":["/a"]}}')),
  POST_DIRS({ scope: "local", remove: ["/a"] }),
  S(W(LOCAL, '{"permissions":{"allow":1e400,"additionalDirectories":["/a"]}}')),
  POST_DIRS({ scope: "local", remove: ["/a"] }),
  ...["false", "0", '""', "[]", "{}"].map((v) => [S(W(LOCAL, `{"permissions":{"allow":${v},"additionalDirectories":["/a"]}}`)), POST_DIRS({ scope: "local", remove: ["/a"] })]).flat(),
  S(W(LOCAL, '{"permissions":{"additionalDirectories":["/a"],"x":null,"y":null}}')),
  POST_DIRS({ scope: "local", remove: ["/a"] }),
  S(W(LOCAL, '{"permissions":{"__proto__":null,"additionalDirectories":["/a"]}}')),
  POST_DIRS({ scope: "local", remove: ["/a"] }),
  S(W(LOCAL, '{"permissions":{"__proto__":{},"additionalDirectories":["/a"]}}')),
  POST_DIRS({ scope: "local", remove: ["/a"] }),
  S(W(LOCAL, '{"permissions":{"additionalDirectories":["/a"],"1":null}}')),
  POST_DIRS({ scope: "local", remove: ["/a"], add: [] }),
  S(W(LOCAL, '{"permissions":{"additionalDirectories":["/a"],"1":"x"}}')),
  POST_DIRS({ scope: "local", remove: ["/a"] }),
  S(W(LOCAL, '{"permissions":{}}')),
  POST_DIRS({ scope: "local" }),
  S(W(LOCAL, '{"x":1}')),
  POST_DIRS({ scope: "local", remove: ["/a"] }),
  // string iteration of `remove`, by code point
  S(W(LOCAL, `{"permissions":{"additionalDirectories":["a","b","c","${U(0x1f600)}","ab"]}}`)),
  POST_DIRS({ scope: "local", remove: `ab${U(0x1f600)}` }),
  // unicode and other scopes
  POST_DIRS({ scope: "local", add: [`/${U(0xe9)}t${U(0xe9)}`, `/${U(0x1f600)}`, "/a b", ` /padded `, "", "/x\n"] }),
  POST_DIRS({ scope: "user", add: ["/u"] }),
  POST_DIRS({ scope: "project", add: ["/p"] }),
  POST_DIRS({ scope: "local", cwd: "$ROOT/ws", add: ["/w"] }),
  POST_DIRS({ scope: "local", cwd: "$ROOT/ws-extra", add: ["/x"] }),
  GET_FULL("cwd=$ROOT/ws-extra"),
  GET_FULL(),
];

const NAMES = [undefined, "", null, 0, 5, true, [], ["pdf"], {}, " ", "pdf"];
const VALUES = [undefined, "on", "off", "name-only", "user-invocable-only", "ON", "Off", "", " off", null, 0, true, ["off"], {}];
const SKILL_STEPS = [
  ...ODD_BODIES.map((b) => POST_SKILL(b)),
  ...NAMES.map((name) => POST_SKILL(name === undefined ? { value: "off" } : { name, value: "off" })),
  ...VALUES.map((value) => POST_SKILL(value === undefined ? { name: "v" } : { name: "v", value })),
  POST_SKILL('{"name":1e400,"value":"off"}'),
  POST_SKILL('{"name":"inf","value":1e400}'),
  GET_SKILL(),
  CLEAN,
  POST_SKILL({ name: "new", value: "on" }),
  GET_SKILL(),
  POST_SKILL({ name: "b", value: "off" }),
  POST_SKILL({ name: "a", value: "name-only" }),
  POST_SKILL({ name: "10", value: "off" }),
  POST_SKILL({ name: "2", value: "off" }),
  POST_SKILL({ name: "b", value: "user-invocable-only" }),
  POST_SKILL({ name: "constructor", value: "off" }),
  POST_SKILL({ name: "toString", value: "off" }),
  POST_SKILL({ name: "hasOwnProperty", value: "on" }),
  POST_SKILL({ name: "__proto__", value: "off" }),
  POST_SKILL({ name: "__proto__", value: "on" }),
  POST_SKILL({ name: `s${U(0xeb)}rv${U(0xe9)} ${U(0x1f600)}`, value: "off" }),
  POST_SKILL({ name: `quo"te${BS}`, value: "off" }),
  POST_SKILL({ name: "x".repeat(300), value: "off" }),
  GET_SKILL(),
  POST_SKILL({ name: "b", value: "on" }),
  POST_SKILL({ name: "a", value: "on" }),
  POST_SKILL({ name: "10", value: "on" }),
  POST_SKILL({ name: "2", value: "on" }),
  POST_SKILL({ name: "constructor", value: "on" }),
  POST_SKILL({ name: "toString", value: "on" }),
  POST_SKILL({ name: `s${U(0xeb)}rv${U(0xe9)} ${U(0x1f600)}`, value: "on" }),
  POST_SKILL({ name: `quo"te${BS}`, value: "on" }),
  POST_SKILL({ name: "x".repeat(300), value: "on" }),
  GET_SKILL(),
  S(W(PROJ, '{"skillOverrides":{"__proto__":"off","k":"off"},"z":1}')),
  POST_SKILL({ name: "__proto__", value: "name-only" }),
  POST_SKILL({ name: "__proto__", value: "on" }),
  POST_SKILL({ name: "k", value: "on" }),
  S(W(PROJ, '{"a":1,"skillOverrides":{"only":"off"},"b":2}')),
  POST_SKILL({ name: "only", value: "on" }),
  S(W(PROJ, '{"skillOverrides":{"only":"off"},"a":1,"b":2}')),
  POST_SKILL({ name: "only", value: "on" }),
  S(W(PROJ, '{"skillOverrides":{"x":"off","y":"off","z":"off"},"a":1}')),
  POST_SKILL({ name: "x", value: "on" }),
  S(W(PROJ, '{"skillOverrides":{"x":1e400,"y":null}}')),
  POST_SKILL({ name: "z", value: "off" }),
  GET_SKILL(),
  POST_SKILL({ name: "pdf", value: "off", cwd: "$ROOT/ws" }),
  GET_SKILL("cwd=$ROOT/ws"),
  POST_SKILL({ name: "pdf", value: "on", cwd: "$ROOT/ws" }),
  POST_SKILL({ name: "pdf", value: "off", cwd: "$ROOT/untrusted" }),
];

const GROUPS = [
  { name: "cwd", steps: CWD_STEPS },
  { name: "shapes", steps: SHAPE_STEPS },
  { name: "gaps", steps: GAP_STEPS },
  { name: "full", steps: FULL_STEPS },
  { name: "permissions", steps: PERM_STEPS },
  { name: "auto-mode", steps: AUTO_STEPS },
  { name: "additional-dirs", steps: DIRS_STEPS },
  { name: "skill-overrides", steps: SKILL_STEPS },
];

const groups = [];
for (const g of GROUPS) groups.push(await runGroup(g));

// A file, not stdout: `process.exit` would cut a piped stdout short.
writeFileSync(join(ROOT, "out.json"), JSON.stringify({ node: process.version, world: WORLD, groups }));
process.exit(0);
