#!/usr/bin/env node
// Golden fixture for the MCP config routes (G03), recorded from the TS
// sources:
//
//   node rust/scripts/mcp-config-golden.mjs     (node@22: session.ts needs
//                                                better-sqlite3, which bun
//                                                can't load; builds
//                                                claudius-fake-claude)
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
// Records:
//
// - `protoNames`: `Object.getOwnPropertyNames` of `Object.prototype` and
//   `Array.prototype` (what `name in servers` also finds).
// - `warnings`: `findConfigWhitespaceWarnings(config)` over hand-built
//   configs: the list, or `threw` (a primitive config: `"url" in config`).
// - `groups`: the real route handlers (`app/api/mcp/route.ts` GET / POST,
//   `[name]/route.ts` DELETE, `[name]/toggle` and `[name]/reconnect` POST),
//   called with `Request` objects, in order on one world per group. A step
//   is either `setup` (file operations, applied as written: `write` text or
//   `bytes`, `mkdir`, `rm`, `symlink`, `chmod`) or a `request` (`method`,
//   `url`, `body`; `$ROOT` stands for the root, `$LIVE` for the group's live
//   session id). A route's `[name]` is `decodeURIComponent` of its URL
//   segment, as Next decodes it. Each request records `got` (status, content
//   type and body text, or `threw`: Next's empty 500), `changes` (every
//   watched path whose entry differs from before the request: kind, mode,
//   UTF-8 text or raw bytes, symlink target; `null` when it is gone), the
//   `mcp_*` control requests the session's CLI got (`wire`, ids as `$ID`)
//   and what the next turn would carry (`reminder`, joined
//   `<system-reminder>` blocks or null). A group with a `session` has a bare
//   `Session.prototype` object as `$LIVE` (`sessionManager.get` stubbed),
//   whose `query` is a real SDK `query()` against the fake CLI with the
//   group's `script`, or none (`session: "none"`). A `setup` may carry a
//   `label` naming the section it starts; `final` is every watched path at
//   the end of the group.
//
// Written to rust/crates/claudius-core/tests/fixtures/mcp_config_golden.json
// and replayed by crates/claudius-core/tests/mcp_config_golden.rs
// (protoNames, warnings) and crates/claudius-server/tests/mcp_config.rs
// (groups, against the real binary).
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
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "crates/claudius-core/tests/fixtures/mcp_config_golden.json");

// ------------------------------- recording -------------------------------

if (!process.env.MCP_CONFIG_GOLDEN_ROOT) {
  execFileSync("cargo", ["build", "-q", "-p", "claudius-agent", "--bin", "claudius-fake-claude"], {
    cwd: rustDir,
    stdio: "inherit",
    env: { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` },
  });
  const fake = join(rustDir, "target/debug/claudius-fake-claude");
  const runs = [0, 1].map(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "mcp-config-golden-")));
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
            MCP_CONFIG_GOLDEN_ROOT: root,
            MCP_CONFIG_GOLDEN_FAKE: fake,
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
  const steps = fixture.groups.reduce((n, g) => n + g.steps.filter((s) => s.request).length, 0);
  console.log(
    `wrote ${out.slice(repo.length + 1)}: ${fixture.warnings.length} warning configs, ${fixture.groups.length} groups (${steps} requests, SDK ${fixture.sdkVersion})`,
  );
  process.exit(0);
}

// --------------------------------- child ---------------------------------

const ROOT = process.env.MCP_CONFIG_GOLDEN_ROOT;
const FAKE = process.env.MCP_CONFIG_GOLDEN_FAKE;
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

const SDK = "@anthropic-ai/claude-agent-sdk";
const mcpRoute = await import(join(repo, "app/api/mcp/route.ts"));
const nameRoute = await import(join(repo, "app/api/mcp/[name]/route.ts"));
const toggleRoute = await import(join(repo, "app/api/mcp/[name]/toggle/route.ts"));
const reconnectRoute = await import(join(repo, "app/api/mcp/[name]/reconnect/route.ts"));
const { findConfigWhitespaceWarnings } = await import(join(repo, "lib/server/mcp.ts"));
const { Session } = await import(join(repo, "lib/server/session.ts"));
const { takePendingReminders } = await import(join(repo, "lib/server/system-reminders.ts"));
const { sessionManager } = await import(join(repo, "lib/server/session-manager.ts"));
const { query, createSdkMcpServer } = await import(SDK);
const sdkVersion = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.resolve(SDK))), "package.json"), "utf8"),
).version;

/** Characters by code point, so this file stays ASCII. */
const U = (...cps) => String.fromCodePoint(...cps);
/** A backslash, for escapes inside raw JSON text. */
const BS = String.fromCharCode(92);
const LIVE = "00000000-0000-4000-8000-000000000001";

// --------------------------- the whitespace scan ---------------------------

// Every JS `\s` character, plus NEL, ZWSP and U+180E (none of which `\s` has).
const JS_SPACE = [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2000, 0x2005, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff];
const NOT_SPACE = [0x85, 0x200b, 0x180e, 0x00, 0x1c, 0x1f];
const WARNING_CONFIGS = [
  {},
  [],
  [" a"],
  { command: "node" },
  { command: " node" },
  { command: "node " },
  { command: " " },
  { command: "" },
  { command: "a b" },
  { type: "http", url: "https://x " },
  { type: "http", url: "\nhttps://x" },
  { url: " u", command: " c" },
  { command: " c", url: " u" },
  { url: null, command: null },
  { url: 5, command: true },
  { url: [" a"], command: ["a", " "] },
  { url: [["a"], [" "]], command: [null, " x"] },
  { url: [], command: [null] },
  { url: {}, command: { toString: " x" } },
  { url: " ", headers: { " k": " v" } },
  { command: "c", env: { TOKEN: " abc", " KEY": "v", "K ": "v ", OK: "ok" } },
  { command: "c", env: { b: " 1", 3: " x", a: "2 ", 1: " y" } },
  { command: "c", env: { k: null, n: 5, t: true, a: [" "], o: {}, e: "" } },
  { command: "c", env: {}, headers: { " h": "v" } },
  { command: "c", env: null, headers: { " h": "v" } },
  { command: "c", env: "", headers: { " h": "v" } },
  { command: "c", env: 0, headers: { " h": "v" } },
  { command: "c", env: false },
  { command: "c", env: true },
  { command: "c", env: 7 },
  { command: "c", env: "a b " },
  { command: "c", env: " " + U(0x1f600) + " x" + U(0xa0) },
  { command: "c", env: [" a", "b", [" "], null, "c"] },
  { url: "u", headers: { Authorization: "Bearer x ", " X-Key": "1" } },
  { url: "u", headers: null },
  { url: "u", headers: "  " },
  { url: "u", headers: [" v"] },
  { url: "u", headers: { 'quo"te': ' "', "": " " } },
  { url: "u", headers: { [U(0xe9) + " "]: U(0x4e2d), [U(0x1f600)]: U(0x1f600) + " " } },
  { env: { k: "v" } },
  { headers: { k: " v" } },
  { other: " x", args: [" a"] },
  ...JS_SPACE.map((c) => ({ command: U(c) + "x", url: "x" + U(c) })),
  ...NOT_SPACE.map((c) => ({ command: U(c) + "x", url: "x" + U(c), env: { [U(c)]: U(c) } })),
  // `String(v)` throws for an object with its own `toString` key.
  JSON.parse('{"url":{"toString":"x"}}'),
  JSON.parse('{"url":"u","command":[1,[{"toString":null}]]}'),
  JSON.parse('{"command":"c","env":{"k":{"toString":1}}}'),
  JSON.parse('{"command":"c","env":{" k":"v","toString":" "}}'),
  JSON.parse('{"command":{"valueOf":" x"},"url":[{}," "]}'),
  JSON.parse('{"command":{"__proto__":" x"}}'),
  { command: U(0x3000) + U(0x1f600) },
  { command: U(0x1f600) + U(0x2028) },
  // Primitives: `"url" in config` throws.
  "str",
  "",
  " ",
  5,
  0,
  true,
  false,
  null,
];
const warnings = WARNING_CONFIGS.map((config) => {
  try {
    return { config, warnings: findConfigWhitespaceWarnings(config) };
  } catch (e) {
    return { config, threw: String(e) };
  }
});

// --------------------------------- worlds ---------------------------------

const toAbs = (s) => s.replaceAll("$ROOT", ROOT).replaceAll("$LIVE", LIVE);
const toRel = (s) => s.replaceAll(ROOT, "$ROOT");

/** The watched paths: everything the routes could touch, and decoys. */
const WATCH = ["home", "project", "ws", "ws-extra", "untrusted", "shared", "config/settings.json", "config/mcp.json"];
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
      for (const e of readdirSync(abs).sort()) visit(`${rel}/${e}`);
    } else {
      const buf = readFileSync(abs);
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
  dirs: ["home/.claude/.claudius", "project", "ws", "ws-extra", "untrusted", "shared", "config"],
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
    // Decoys nothing reads: the CLI config dir, the project scope's settings.json.
    ["config/settings.json", '{"mcpServers":{"decoy":{"command":"decoy"}}}\n'],
    ["config/mcp.json", '{"mcpServers":{"decoy2":{"command":"decoy"}}}\n'],
    ["project/.claude/settings.json", '{"mcpServers":{"projsettings":{"command":"no"}}}\n'],
  ],
};

function buildWorld() {
  // The project dir is this process's cwd: emptied, never removed.
  for (const d of WATCH) {
    if (d === "project") {
      for (const e of readdirSync(join(ROOT, d))) rmSync(join(ROOT, d, e), { recursive: true, force: true });
    } else {
      rmSync(join(ROOT, d), { recursive: true, force: true });
    }
  }
  rmSync(join(ROOT, "home"), { recursive: true, force: true });
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

// --------------------------------- sessions ---------------------------------

let qdirs = 0;
/** A real SDK query against the fake CLI, as a bare session's `query`. */
async function openQuery(script) {
  const dir = join(ROOT, `q${qdirs++}`);
  const cwd = join(dir, "proj");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(dir, "home"));
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
      cwd,
      pathToClaudeCodeExecutable: FAKE,
      abortController: ctrl,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: join(dir, "home"),
        FAKE_CLAUDE_LOG: log,
        ...(script ? { FAKE_CLAUDE_SCRIPT: typeof script === "string" ? script : JSON.stringify(script) } : {}),
      },
      mcpServers: { claudius_goal: createSdkMcpServer({ name: "claudius_goal", version: "1.0.0", tools: [] }) },
    },
  });
  const drained = (async () => {
    try {
      for await (const m of q) void m;
    } catch {
      // the abort ends the stream with an error
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

/** The `mcp_*` control requests written since line `from`, ids as `$ID`. */
function wireSince(log, from) {
  return readLines(log)
    .slice(from)
    .filter((l) => {
      const m = JSON.parse(l);
      return m.type === "control_request" && /^mcp_/.test(m.request?.subtype ?? "");
    })
    .map((l) => l.replace(JSON.stringify(JSON.parse(l).request_id), '"$ID"'));
}

// --------------------------------- requests ---------------------------------

async function call(req) {
  if (!/^[\x21-\x7e]+$/.test(req.url) || req.url.includes("#")) throw new Error(`url must be plain ASCII: ${req.url}`);
  const init = { method: req.method };
  if (req.body !== undefined) init.body = toAbs(req.body);
  const request = new Request(`http://localhost${toAbs(req.url)}`, init);
  const segs = req.url.split("?")[0].split("/");
  try {
    let res;
    if (segs.length === 3) {
      res = await (req.method === "GET" ? mcpRoute.GET : mcpRoute.POST)(request);
    } else {
      const ctx = { params: Promise.resolve({ name: decodeURIComponent(segs[3]) }) };
      const handler = segs.length === 4 ? nameRoute.DELETE : segs[4] === "toggle" ? toggleRoute.POST : reconnectRoute.POST;
      res = await handler(request, ctx);
    }
    return { status: res.status, type: res.headers.get("content-type"), body: toRel(await res.text()) };
  } catch (e) {
    return { threw: toRel(e instanceof Error ? `${e.name}: ${e.message}` : String(e)) };
  }
}

async function runGroup(group) {
  buildWorld();
  let host = null;
  let q = null;
  if (group.session) {
    host = Object.create(Session.prototype);
    host.id = LIVE;
    host.query = null;
    if (group.session !== "none") {
      q = await openQuery(group.script ?? null);
      host.query = q.q;
    }
  }
  // `sessions.get(id)`: a Map lookup, so only the exact string matches.
  sessionManager.get = (id) => (host && id === host.id ? host : undefined);
  const steps = [];
  for (const step of group.steps) {
    if (step.setup) {
      for (const op of step.setup) apply(op);
      steps.push(step);
      continue;
    }
    const before = snapshot();
    const from = q ? readLines(q.log).length : 0;
    const got = await call(step);
    const after = snapshot();
    steps.push({
      request: { method: step.method, url: step.url, ...(step.body !== undefined ? { body: step.body } : {}) },
      got,
      changes: changes(before, after),
      wire: q ? wireSince(q.log, from) : [],
      reminder: host ? takePendingReminders(host) : null,
    });
  }
  if (q) await q.close();
  return {
    name: group.name,
    session: group.session ?? null,
    script: group.script ?? null,
    probes: !!group.probes,
    steps,
    final: snapshot(),
  };
}

// ---------------------------------- steps ----------------------------------

const USER = "home/.claude/settings.json";
const UMCP = "home/.claude/mcp.json";
const PROJ = "project/.mcp.json";
const LOCAL = "project/.claude/settings.local.json";
const WSPROJ = "ws/.mcp.json";

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
const enc = encodeURIComponent;

const GET = (query) => ({ method: "GET", url: `/api/mcp${query ? `?${query}` : ""}` });
const POST = (body) => ({ method: "POST", url: "/api/mcp", body: typeof body === "string" ? body : J(body) });
const DEL = (name, query) => ({ method: "DELETE", url: `/api/mcp/${enc(name)}${query ? `?${query}` : ""}` });
const TOGGLE = (name, body) => ({ method: "POST", url: `/api/mcp/${enc(name)}/toggle`, body: typeof body === "string" ? body : J(body) });
const RECONNECT = (name, query) => ({ method: "POST", url: `/api/mcp/${enc(name)}/reconnect${query ? `?${query}` : ""}` });

const add = (scope, name, config, extra = {}) => POST({ scope, name, config, ...extra });
const CFG = { command: "node", args: ["server.js"] };
/** Reset the four config files. */
const CLEAN = S(RM(USER), RM(UMCP), RM(PROJ), RM(LOCAL));

const NUMS = `{"model":"opus","n":1.0,"x":1e2,"neg":-0.0,"big":12345678901234567890,"tiny":5e-324,"e21":1e21,"f":0.1,"2":true,"a":{"10":1,"b":2,"1":3},"mcpServers":{"z":{"command":"z","timeout":30.0}},"after":[1.50,-0.0,1e-7]}\n`;
const DEEP = `{"mcpServers":{},"deep":${"[".repeat(200)}${"]".repeat(200)}}`;

const CONFIG_STEPS = [
  // ---- cwd resolution ----
  GET(),
  GET("cwd="),
  GET("cwd=%20%09"),
  GET("cwd=%EF%BB%BF"),
  GET("cwd=%C2%85"),
  GET("cwd=%C2%A0"),
  GET("cwd=$ROOT/untrusted"),
  GET("cwd=$ROOT/nowhere"),
  GET("cwd=$ROOT/ws"),
  GET("cwd=$ROOT/ws-extra"),
  GET("cwd=$ROOT/project/"),
  GET("cwd=$ROOT/ws/../project"),
  GET("cwd=."),
  GET("cwd=..%2Fws"),
  GET("cwd=ws"),
  GET("cwd=$ROOT/ws&cwd=$ROOT/untrusted"),
  GET("cwd=$ROOT/untrusted&cwd=$ROOT/ws"),
  GET("CWD=$ROOT/untrusted"),
  GET("cwd=%00"),
  GET("cwd=$ROOT%2Fws"),
  GET("cwd=$ROOT/w+s"),
  GET("sessionId=nope"),
  GET("sessionId="),
  GET("sessionId=nope&cwd=$ROOT/untrusted"),

  // ---- POST validation ----
  POST(""),
  POST("{"),
  POST("not json"),
  POST("null"),
  POST("[]"),
  POST('"user"'),
  POST("5"),
  POST("{}"),
  POST({ scope: "global", name: "a", config: CFG }),
  POST({ scope: "USER", name: "a", config: CFG }),
  POST({ scope: ["user"], name: "a", config: CFG }),
  POST({ scope: "user" }),
  POST({ scope: "user", name: "a" }),
  POST({ scope: "user", config: CFG }),
  POST({ scope: "user", name: "", config: CFG }),
  POST({ scope: "user", name: 0, config: CFG }),
  POST({ scope: "user", name: false, config: CFG }),
  POST({ scope: "user", name: null, config: CFG }),
  POST({ scope: "user", name: "a", config: null }),
  POST({ scope: "user", name: "a", config: 0 }),
  POST({ scope: "user", name: "a", config: "" }),
  POST({ scope: "user", name: "a", config: false }),
  POST({ name: "a", config: CFG, cwd: "$ROOT/untrusted" }),
  add("user", "a", CFG, { cwd: "$ROOT/untrusted" }),
  add("project", "a", CFG, { cwd: "$ROOT/nowhere" }),
  add("local", "a", CFG, { cwd: "" }),
  GET(),
  CLEAN,
  add("user", "a", CFG, { cwd: 5 }),
  add("user", "b", CFG, { cwd: " " }),
  add("user", "c", CFG, { cwd: U(0xfeff) }),
  add("user", "d", CFG, { cwd: U(0x85) }),
  add("user", "e", CFG, { cwd: "$ROOT/project/" }),
  GET(),
  CLEAN,

  // ---- user scope: settings.json ----
  add("user", "linear", { type: "http", url: "https://mcp.linear.app/sse" }),
  GET(),
  add("project", "fs", { command: "npx", args: ["-y", "@x/fs", " /tmp "], env: { TOKEN: " abc" } }),
  add("local", "loc", { command: " node", env: { " K": "v\n" } }),
  GET(),
  add("user", "linear", { type: "sse", url: "https://other " }),
  add("user", "slack", { command: "slack" }),
  GET(),
  add("user", "10", { command: "ten" }),
  add("user", "2", { command: "two" }),
  add("user", "0", { command: "zero" }),
  add("user", "01", { command: "zero-one" }),
  POST({ scope: "user", name: 5, config: { command: "five" } }),
  POST({ scope: "user", name: true, config: { command: "true" } }),
  POST({ scope: "user", name: {}, config: { command: "obj" } }),
  POST({ scope: "user", name: [], config: { command: "empty-array" } }),
  POST({ scope: "user", name: ["a", ["b", null], 1.5], config: { command: "joined" } }),
  POST('{"scope":"user","name":1.0,"config":{"command":"one"}}'),
  POST('{"scope":"user","name":1e21,"config":{"command":"e21"}}'),
  POST('{"scope":"user","name":0.1,"config":{"command":"tenth"}}'),
  POST('{"scope":"user","name":-0.0,"config":{"command":"neg-zero"}}'),
  POST('{"scope":"user","name":1e400,"config":{"command":"inf-name"}}'),
  POST('{"scope":"user","name":"inf-config","config":1e400}'),
  POST('{"scope":"user","name":"inf-cwd","config":{"command":"c"},"cwd":1e400}'),
  POST('{"scope":"user","name":{"toString":1},"config":{"command":"own-tostring"}}'),
  POST('{"scope":"user","name":[{"toString":1}],"config":{"command":"own-tostring"}}'),
  POST('{"scope":"user","name":{"valueOf":1},"config":{"command":"own-valueof"}}'),
  POST('{"scope":"user","name":[[{}],null,[]],"config":{"command":"nested"}}'),
  GET(),
  CLEAN,
  add("user", "__proto__", { command: "proto" }),
  add("user", "constructor", { command: "ctor" }),
  add("user", "toString", { command: "ts" }),
  GET(),
  DEL("__proto__", "scope=user"),
  DEL("constructor", "scope=user"),
  DEL("toString", "scope=user"),
  DEL("toString", "scope=user"),
  DEL("valueOf", "scope=user"),
  DEL("hasOwnProperty", "scope=user"),
  DEL("length", "scope=user"),
  DEL("nope", "scope=user"),
  CLEAN,
  // configs of every shape
  add("user", "str", "str"),
  GET(),
  DEL("str", "scope=user"),
  add("user", "num", 5),
  GET(),
  DEL("num", "scope=user"),
  add("user", "t", true),
  GET(),
  DEL("t", "scope=user"),
  POST('{"scope":"user","name":"ts","config":{"url":{"toString":"x"}}}'),
  GET(),
  DEL("ts", "scope=user"),
  add("user", "arr", []),
  add("user", "arr2", [" a", { url: " x" }]),
  GET(),
  add("user", "o", { url: [" a"], command: { x: 1 } }),
  add("user", "env", { command: "c", env: { k: [" "], n: 5, z: null }, headers: { " h": "v" } }),
  add("user", "envnull", { command: "c", env: null, headers: { " h": "v" } }),
  add("user", "envstr", { command: "c", env: "a " }),
  add("user", "uni", { command: U(0xa0) + "x", url: "x" + U(0x2028), env: { [U(0x85)]: U(0x85), ["k" + U(0x3000)]: U(0xfeff) + "v" } }),
  add("user", "s" + U(0xeb) + "rv" + U(0xe9) + "r " + U(0x1f600), { command: U(0x4e2d) + U(0x6587) }),
  POST(`{"scope":"user","name":"nums","config":{"command":"n","timeout":1.0,"x":1e2,"y":-0.0,"z":2.5,"big":1e21,"small":1e-7,"env":{"b":"1","3":"x","a":"2"}}}`),
  POST(`{"scope":"user","name":"inf","config":{"command":"i","n":1e400}}`),
  POST(`${U(0xfeff)}{"scope":"user","name":"bom","config":{"command":"b"}}`),
  POST(`${U(0xfeff)}${U(0xfeff)}{"scope":"user","name":"bom2","config":{"command":"b"}}`),
  POST(`{"scope":"user","name":"dup","config":{"command":"first"},"config":{"command":"second"}}`),
  GET(),
  CLEAN,
  SL("lone surrogate body"),
  POST(`{"scope":"user","name":"lone${BS}ud800","config":{"command":"c${BS}udc00"}}`),
  POST(`{"scope":"project","name":"p","config":{"command":"${BS}ud83d${BS}ude00"}}`),
  SL("body nested past 128 levels"),
  POST(`{"scope":"project","name":"deep","config":{"args":${"[".repeat(200)}${"]".repeat(200)}}}`),
  CLEAN,

  // ---- settings.json shapes ----
  S(W(USER, NUMS)),
  add("user", "y", { command: "y" }),
  GET(),
  DEL("z", "scope=user"),
  DEL("y", "scope=user"),
  S(W(USER, '{"model":"opus","env":{"A":"1"}}')),
  add("user", "a", CFG),
  S(W(USER, '{"mcpServers":null,"model":"m"}')),
  GET(),
  add("user", "a", CFG),
  S(W(USER, '{"mcpServers":"ab","model":"m"}')),
  GET(),
  DEL("a", "scope=user"),
  add("user", "c", CFG),
  SL("astral string spread", W(USER, `{"mcpServers":"${U(0x1f600)}"}`)),
  add("user", "c", CFG),
  S(W(USER, '{"mcpServers":[{"command":"zero"},{"command":" one"}],"model":"m"}')),
  GET(),
  DEL("0", "scope=user"),
  add("user", "c", CFG),
  S(W(USER, '{"mcpServers":5}')),
  GET(),
  DEL("a", "scope=user"),
  add("user", "c", CFG),
  S(W(USER, '{"mcpServers":true}')),
  DEL("a", "scope=user"),
  S(W(USER, '{"mcpServers":false}')),
  DEL("a", "scope=user"),
  add("user", "c", CFG),
  S(W(USER, '{"mcpServers":0}')),
  DEL("a", "scope=user"),
  S(W(USER, '{"mcpServers":""}')),
  GET(),
  DEL("a", "scope=user"),
  S(W(USER, '{"mcpServers":{}}')),
  DEL("a", "scope=user"),
  S(W(USER, '{"__proto__":{"x":1},"mcpServers":{"__proto__":{"command":"p"}},"b":2}')),
  GET(),
  add("user", "c", CFG),
  DEL("__proto__", "scope=user"),
  S(W(USER, '{"a":1,"b":2,"a":3,"mcpServers":{"s":{"command":"s"},"s":{"command":"t"}}}')),
  GET(),
  DEL("s", "scope=user"),
  S(W(USER, "[1,2]")),
  GET(),
  DEL("0", "scope=user"),
  add("user", "c", CFG),
  S(W(USER, '"ab"')),
  GET(),
  DEL("0", "scope=user"),
  add("user", "c", CFG),
  S(W(USER, "5")),
  add("user", "c", CFG),
  S(W(USER, "true")),
  add("user", "c", CFG),
  S(W(USER, "false")),
  add("user", "c", CFG),
  S(W(USER, '""')),
  add("user", "c", CFG),
  S(W(USER, "null")),
  GET(),
  DEL("a", "scope=user"),
  add("user", "c", CFG),
  S(W(USER, "{")),
  GET(),
  DEL("a", "scope=user"),
  add("user", "c", CFG),
  S(W(USER, "")),
  GET(),
  add("user", "c", CFG),
  S(W(USER, " \n")),
  GET(),
  add("user", "c", CFG),
  S(W(USER, `${U(0xfeff)}{}`)),
  GET(),
  add("user", "c", CFG),
  S(WB(USER, [...Buffer.from('{"model":"a'), 0xff, 0xfe, ...Buffer.from('b","mcpServers":{"x":{"command":"c'), 0xc3, ...Buffer.from('"}}}')])),
  GET(),
  add("user", "c", CFG),
  S(W(USER, '{"model":"m","n":1e400,"mcpServers":{"x":{"command":"c","t":1e400}}}')),
  GET(),
  add("user", "c", CFG),
  SL("lone surrogate escapes", W(USER, `{"model":"${BS}ud800","mcpServers":{"x":{"command":"c${BS}udfff"}}}`)),
  GET(),
  add("user", "c", CFG),
  SL("nested past 128 levels", W(USER, DEEP)),
  add("user", "c", CFG),
  // a symlinked settings.json is written through; a chmod'd one keeps its mode
  S(RM(USER), W("shared/settings.json", '{"model":"linked"}'), LN(USER, "$ROOT/shared/settings.json")),
  add("user", "c", CFG),
  DEL("c", "scope=user"),
  S(RM(USER), RM("shared/settings.json"), LN(USER, "$ROOT/shared/missing.json")),
  add("user", "c", CFG),
  S(RM(USER), RM("shared/missing.json"), W(USER, '{"model":"secret"}'), CH(USER, 0o600)),
  add("user", "c", CFG),
  DEL("c", "scope=user"),
  S(RM(USER), MK(USER)),
  GET(),
  add("user", "c", CFG),
  DEL("c", "scope=user"),
  CLEAN,

  // ---- user scope: ~/.claude/mcp.json ----
  S(W(USER, '{"mcpServers":{"linear":{"command":"from-settings"}}}'), W(UMCP, '{"mcpServers":{"other":{"command":" o"},"linear":{"command":"from-mcp-json"},"2":{"url":"u "}}}')),
  GET(),
  DEL("other", "scope=user"),
  DEL("linear", "scope=user"),
  GET(),
  add("user", "other", CFG),
  GET(),
  S(W(UMCP, "")),
  GET(),
  S(W(UMCP, " \n\t")),
  GET(),
  S(W(UMCP, U(0xfeff))),
  GET(),
  S(W(UMCP, `${U(0xfeff)}{}`)),
  GET(),
  S(W(UMCP, "null")),
  GET(),
  S(W(UMCP, "5")),
  GET(),
  S(W(UMCP, '"str"')),
  GET(),
  S(W(UMCP, "[]")),
  GET(),
  S(W(UMCP, '{"mcpServers":null}')),
  GET(),
  S(W(UMCP, '{"mcpServers":5}')),
  GET(),
  S(W(UMCP, '{"mcpServers":"ab"}')),
  GET(),
  S(W(UMCP, '{"mcpServers":""}')),
  GET(),
  S(W(UMCP, '{"mcpServers":[{"command":" a"}]}')),
  GET(),
  S(W(UMCP, "{")),
  GET(),
  S(RM(UMCP), MK(UMCP)),
  GET(),
  S(RM(UMCP), WB(UMCP, [...Buffer.from('{"mcpServers":{"bad'), 0xe2, 0x82, ...Buffer.from('":{"command":"x"}}}')])),
  GET(),
  CLEAN,

  // ---- project scope: .mcp.json ----
  add("project", "p", CFG),
  GET(),
  add("project", "q", { url: "u" }),
  DEL("p", "scope=project"),
  DEL("p", "scope=project"),
  DEL("q", "scope=project"),
  GET(),
  S(W(PROJ, "")),
  add("project", "p", CFG),
  S(W(PROJ, " \n")),
  add("project", "p", CFG),
  S(W(PROJ, "null")),
  DEL("p", "scope=project"),
  add("project", "p", CFG),
  S(W(PROJ, '{"other":1.0,"mcpServers":{"b":{"command":"b","n":1e2}},"z":[1.0]}')),
  add("project", "a", CFG),
  add("project", "1", CFG),
  S(W(PROJ, '{"other":1}')),
  add("project", "a", CFG),
  S(W(PROJ, "{}")),
  DEL("a", "scope=project"),
  S(W(PROJ, '{"mcpServers":null}')),
  DEL("a", "scope=project"),
  add("project", "a", CFG),
  S(W(PROJ, '[{"mcpServers":{"a":{}}}]')),
  GET(),
  DEL("a", "scope=project"),
  add("project", "a", CFG),
  S(W(PROJ, '"str"')),
  GET(),
  DEL("a", "scope=project"),
  add("project", "a", CFG),
  S(W(PROJ, "5")),
  add("project", "a", CFG),
  S(W(PROJ, "0")),
  add("project", "a", CFG),
  S(W(PROJ, "true")),
  add("project", "a", CFG),
  S(W(PROJ, "false")),
  add("project", "a", CFG),
  S(W(PROJ, '""')),
  add("project", "a", CFG),
  S(W(PROJ, '{"mcpServers":"ab"}')),
  DEL("a", "scope=project"),
  add("project", "c", CFG),
  S(W(PROJ, '{"mcpServers":[{"command":"zero"},{"command":"one"},{"command":"two"}]}')),
  GET(),
  DEL("1", "scope=project"),
  S(W(PROJ, '{"mcpServers":[{"command":"zero"},{"command":"one"}]}')),
  DEL("length", "scope=project"),
  DEL("push", "scope=project"),
  DEL("toSorted", "scope=project"),
  DEL("toString", "scope=project"),
  DEL("01", "scope=project"),
  DEL("2", "scope=project"),
  DEL("-0", "scope=project"),
  add("project", "c", CFG),
  S(W(PROJ, '{"mcpServers":5}')),
  DEL("a", "scope=project"),
  add("project", "c", CFG),
  S(W(PROJ, '{"mcpServers":true}')),
  DEL("a", "scope=project"),
  S(W(PROJ, '{"mcpServers":0}')),
  DEL("a", "scope=project"),
  S(W(PROJ, '{"mcpServers":""}')),
  DEL("a", "scope=project"),
  S(W(PROJ, '{"mcpServers":{"a":{"command":"a"}},"mcpServers":{"b":{"command":"b"}}}')),
  DEL("a", "scope=project"),
  DEL("b", "scope=project"),
  S(W(PROJ, "{")),
  GET(),
  add("project", "a", CFG),
  DEL("a", "scope=project"),
  S(W(PROJ, `${U(0xfeff)}{"mcpServers":{}}`)),
  add("project", "a", CFG),
  SL("lone surrogate escape", W(PROJ, `{"mcpServers":{"a":{"command":"${BS}ud83d"}}}`)),
  GET(),
  DEL("a", "scope=project"),
  S(W(PROJ, '{"mcpServers":{"a":{"command":"a","n":1e400}},"x":1e400}')),
  DEL("a", "scope=project"),
  S(RM(PROJ), MK(PROJ)),
  GET(),
  add("project", "a", CFG),
  DEL("a", "scope=project"),
  S(RM(PROJ), WB(PROJ, [...Buffer.from('{"mcpServers":{"a":{"command":"'), 0x80, ...Buffer.from('"},"b":{}}}')])),
  GET(),
  DEL("a", "scope=project"),
  // symlinks are written through; a chmod'd file keeps its mode
  S(RM(PROJ), W("shared/mcp.json", '{"mcpServers":{"s":{"command":"s"}}}'), LN(PROJ, "$ROOT/shared/mcp.json")),
  add("project", "a", CFG),
  DEL("s", "scope=project"),
  S(RM(PROJ), RM("shared/mcp.json"), LN(PROJ, "$ROOT/shared/dangling.json")),
  GET(),
  add("project", "a", CFG),
  S(RM(PROJ), RM("shared/dangling.json"), W(PROJ, '{"mcpServers":{"s":{"command":"s"}}}'), CH(PROJ, 0o600)),
  add("project", "a", CFG),
  DEL("s", "scope=project"),
  CLEAN,

  // ---- local scope: .claude/settings.local.json ----
  S(RM("project/.claude")),
  add("local", "l", CFG),
  GET(),
  add("local", "m", { url: "u" }),
  DEL("l", "scope=local"),
  DEL("l", "scope=local"),
  DEL("m", "scope=project"),
  DEL("m", "scope=local"),
  S(RM("project/.claude"), W("project/.claude", "not a dir")),
  GET(),
  add("local", "l", CFG),
  DEL("l", "scope=local"),
  add("project", "p", CFG),
  DEL("p", "scope=project"),
  S(RM("project/.claude"), MK("project/.claude"), W(LOCAL, '{"permissions":{"allow":["Bash"]},"mcpServers":{"l":{"command":"l "}}}')),
  GET(),
  add("local", "k", CFG),
  DEL("l", "scope=local"),
  CLEAN,

  // ---- other trusted cwds ----
  add("project", "w", CFG, { cwd: "$ROOT/ws" }),
  add("local", "w", CFG, { cwd: "$ROOT/ws-extra" }),
  GET("cwd=$ROOT/ws"),
  GET("cwd=$ROOT/ws-extra"),
  GET(),
  DEL("w", "scope=project"),
  DEL("w", "scope=project&cwd=$ROOT/ws"),
  DEL("w", "scope=local&cwd=$ROOT/ws-extra"),
  S(RM(WSPROJ)),
  // A trusted root that doesn't exist (yet): both writers mkdir -p it.
  S(RM("ws-extra")),
  GET("cwd=$ROOT/ws-extra"),
  add("project", "g", CFG, { cwd: "$ROOT/ws-extra" }),
  S(RM("ws-extra")),
  add("local", "g", CFG, { cwd: "$ROOT/ws-extra" }),
  GET("cwd=$ROOT/ws-extra"),
  DEL("g", "scope=project&cwd=$ROOT/ws-extra"),
  S(RM("ws-extra"), MK("ws-extra")),

  // ---- DELETE validation ----
  add("user", "keep", CFG),
  DEL("keep"),
  DEL("keep", "scope="),
  DEL("keep", "scope=bogus"),
  DEL("keep", "scope=USER"),
  DEL("keep", "scope=user&cwd=$ROOT/untrusted"),
  DEL("keep", "scope=bogus&cwd=$ROOT/untrusted"),
  DEL("keep", "cwd=$ROOT/untrusted"),
  DEL("keep", "scope=project&scope=user"),
  DEL("keep", "scope=user&scope=project"),
  DEL("keep", "scope=user+"),
  DEL("keep", "scope=%75ser"),
  // names through the URL
  add("user", "a b", CFG),
  add("user", "a/b", CFG),
  add("user", "%41", CFG),
  add("user", "s" + U(0xeb) + "rv" + U(0xe9) + "r " + U(0x1f600), CFG),
  add("user", "a+b", CFG),
  DEL("a b", "scope=user"),
  DEL("a/b", "scope=user"),
  DEL("%41", "scope=user"),
  DEL("A", "scope=user"),
  DEL("s" + U(0xeb) + "rv" + U(0xe9) + "r " + U(0x1f600), "scope=user"),
  DEL("a+b", "scope=user"),
  DEL("keep", "scope=user"),
  GET(),
];

const toggle = (name, body) => TOGGLE(name, body);
const LIVE_STEPS = [
  GET("sessionId=$LIVE"),
  GET("sessionId=$LIVE&cwd=$ROOT/ws"),
  GET("sessionId=$LIVE&cwd=$ROOT/untrusted"),
  GET("sessionId=$LIVE&sessionId=nope"),
  GET("sessionId=nope&sessionId=$LIVE"),
  GET("sessionid=$LIVE"),
  S(W(PROJ, "{")),
  GET("sessionId=$LIVE"),
  S(RM(PROJ)),
  add("user", "linear", { url: " u" }),
  GET("sessionId=$LIVE"),
  // toggle bodies
  toggle("linear", ""),
  toggle("linear", "{"),
  toggle("linear", "null"),
  toggle("linear", "[]"),
  toggle("linear", '"$LIVE"'),
  toggle("linear", "{}"),
  toggle("linear", { sessionId: "" }),
  toggle("linear", { sessionId: 0 }),
  toggle("linear", { sessionId: false }),
  toggle("linear", { sessionId: 5 }),
  toggle("linear", { sessionId: true }),
  toggle("linear", { sessionId: ["$LIVE"] }),
  toggle("linear", { sessionId: "nope", enabled: true }),
  toggle("linear", { sessionId: "$LIVE " }),
  toggle("linear", { sessionId: "$LIVE" }),
  toggle("linear", { sessionId: "$LIVE", enabled: true }),
  toggle("linear", { sessionId: "$LIVE", enabled: false }),
  toggle("linear", { sessionId: "$LIVE", enabled: "false" }),
  toggle("linear", { sessionId: "$LIVE", enabled: "" }),
  toggle("linear", { sessionId: "$LIVE", enabled: 0 }),
  toggle("linear", { sessionId: "$LIVE", enabled: 1 }),
  toggle("linear", { sessionId: "$LIVE", enabled: null }),
  toggle("linear", { sessionId: "$LIVE", enabled: [] }),
  toggle("linear", { sessionId: "$LIVE", enabled: {} }),
  TOGGLE("linear", '{"sessionId":"$LIVE","enabled":1e400}'),
  TOGGLE("linear", `${U(0xfeff)}{"sessionId":"$LIVE","enabled":true}`),
  toggle("a b", { sessionId: "$LIVE", enabled: true }),
  toggle("a/b", { sessionId: "$LIVE", enabled: false }),
  toggle("%41", { sessionId: "$LIVE", enabled: true }),
  toggle("s" + U(0xeb) + "rv" + U(0xe9) + "r " + U(0x1f600), { sessionId: "$LIVE", enabled: false }),
  toggle('quo"te' + BS, { sessionId: "$LIVE", enabled: true }),
  toggle("__proto__", { sessionId: "$LIVE", enabled: true }),
  toggle("x".repeat(300), { sessionId: "$LIVE", enabled: false }),
  // reconnect queries
  RECONNECT("linear"),
  RECONNECT("linear", "sessionId="),
  RECONNECT("linear", "sessionid=$LIVE"),
  RECONNECT("linear", "sessionId=nope"),
  RECONNECT("linear", "sessionId=nope&sessionId=$LIVE"),
  RECONNECT("linear", "sessionId=$LIVE&sessionId=nope"),
  RECONNECT("linear", "sessionId=%20$LIVE"),
  RECONNECT("linear", "sessionId=$LIVE"),
  RECONNECT("a b", "sessionId=$LIVE"),
  RECONNECT("a/b", "sessionId=$LIVE"),
  RECONNECT("s" + U(0xeb) + "rv" + U(0xe9) + "r " + U(0x1f600), "sessionId=$LIVE"),
  RECONNECT("toString", "sessionId=$LIVE"),
  // several in a row: one reminder each, drained together by the next turn
  RECONNECT("one", "sessionId=$LIVE"),
  GET("sessionId=$LIVE"),
  DEL("linear", "scope=user"),
];

const ERROR_SCRIPT = {
  control: {
    mcp_status: { $error: "status failed" },
    mcp_toggle: { $error: "toggle failed: linear" },
    mcp_reconnect: { $error: "Server not found: linear" },
  },
};
const ERROR_STEPS = [
  GET("sessionId=$LIVE"),
  toggle("linear", { sessionId: "$LIVE", enabled: true }),
  toggle("linear", { sessionId: "$LIVE", enabled: false }),
  RECONNECT("linear", "sessionId=$LIVE"),
  GET("sessionId=$LIVE&cwd=$ROOT/ws"),
];

const STATUS_REPLIES = [
  ["status list", '{"control":{"mcp_status":{"mcpServers":[{"name":"a","status":"connected","n":1.0,"x":1e2},{"name":"b","status":"needs-auth","2":true,"1":false}],"extra":1}}}'],
  ["status empty list", { control: { mcp_status: { mcpServers: [] } } }],
  ["status no list", { control: { mcp_status: {} } }],
  ["status null list", { control: { mcp_status: { mcpServers: null } } }],
  ["status null reply", { control: { mcp_status: null } }],
  ["status string reply", { control: { mcp_status: "x" } }],
  ["status number reply", { control: { mcp_status: 5 } }],
  ["status array reply", { control: { mcp_status: [] } }],
  ["status string list", { control: { mcp_status: { mcpServers: "str" } } }],
  ["status object list", '{"control":{"mcp_status":{"mcpServers":{"b":1,"10":2.0,"1":3}}}}'],
  ["status false list", { control: { mcp_status: { mcpServers: false } } }],
];

const NO_QUERY_STEPS = [
  GET("sessionId=$LIVE"),
  toggle("linear", { sessionId: "$LIVE", enabled: true }),
  RECONNECT("linear", "sessionId=$LIVE"),
  toggle("linear", { sessionId: "nope" }),
  RECONNECT("linear", "sessionId=nope"),
];

const GROUPS = [
  { name: "config", steps: CONFIG_STEPS },
  { name: "live", session: "live", probes: true, steps: LIVE_STEPS },
  { name: "errors", session: "live", script: ERROR_SCRIPT, steps: ERROR_STEPS },
  ...STATUS_REPLIES.map(([name, script]) => ({
    name,
    session: "live",
    script,
    steps: [GET("sessionId=$LIVE"), GET("sessionId=$LIVE&cwd=$ROOT/ws-extra")],
  })),
  { name: "no query", session: "none", steps: NO_QUERY_STEPS },
];

const groups = [];
for (const g of GROUPS) groups.push(await runGroup(g));

const protoNames = {
  object: Object.getOwnPropertyNames(Object.prototype),
  array: Object.getOwnPropertyNames(Array.prototype),
};

// A file, not stdout: `process.exit` would cut a piped stdout short.
writeFileSync(join(ROOT, "out.json"), JSON.stringify({ sdkVersion, protoNames, warnings, world: WORLD, groups }));
process.exit(0);
