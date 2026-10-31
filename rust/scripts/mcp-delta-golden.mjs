#!/usr/bin/env node
// Golden fixture for the session's MCP controls (S15a), recorded from the TS
// sources:
//
//   node rust/scripts/mcp-delta-golden.mjs     (node@22: session.ts needs
//                                               better-sqlite3, which bun
//                                               can't load; builds
//                                               claudius-fake-claude)
//
// Re-runs itself under `--experimental-transform-types` with HOME at a temp
// dir and a resolve hook for the extensionless / `@/` imports, twice (two
// temp roots); both recordings must agree byte for byte. Records:
//
// - `bodies`: `mcpDeltaReminderBody(delta)` (lib/server/session.ts) over
//   hand-built deltas. `body` is null when it returns null.
// - `controls`: the real `Session.prototype` methods `mcpServerStatus`,
//   `reconnectMcp`, `toggleMcp` and `setMcpServers`, on a bare session
//   object whose `query` is a real SDK `query()` against the fake CLI, one
//   CLI per case, with the case's `script` (usually a `control.<subtype>`
//   literal: what the CLI answers; a string `script` is passed as written).
//   The SDK query carries an in-process `claudius_goal` server, as a
//   Claudius session does. Each case records
//   every call's `outcome` (`{ok, data}` with `dataUndefined` for an
//   `undefined` data, or `{ok: false, error}`), the `mcp_*` control requests
//   the SDK wrote while it ran (`wire`: the raw stdin lines with the request
//   id written `$ID`), and then what the next turn would carry
//   (`takePendingReminders`, the joined `<system-reminder>` blocks, or null).
//   A case with `query: "none"` has no query (`no active query`); `"ended"`
//   aborts the query, as `Session.end()` does, and waits for the CLI to go.
// - `route`: the real `POST /api/sessions/:id/mcp-dynamic` handler
//   (`sessionManager.get` stubbed to return such a bare session), in order on
//   one session per group. Each case: the `request` body, the response's
//   `status` and `body` as sent (or `threw`), the `wire` and the
//   `reminder`, as above.
//
// Written to rust/crates/claudius-core/tests/fixtures/mcp_delta_golden.json
// and replayed by crates/claudius-core/tests/mcp_controls.rs (bodies,
// controls) and crates/claudius-server/tests/mcp_dynamic.rs (route).
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "crates/claudius-core/tests/fixtures/mcp_delta_golden.json");

// ─────────────────────────────── recording ───────────────────────────────

if (!process.env.MCP_DELTA_GOLDEN_CHILD) {
  execFileSync("cargo", ["build", "-q", "-p", "claudius-agent", "--bin", "claudius-fake-claude"], {
    cwd: rustDir,
    stdio: "inherit",
    env: { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` },
  });
  const fake = join(rustDir, "target/debug/claudius-fake-claude");
  const runs = [0, 1].map(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "mcp-delta-golden-")));
    try {
      const home = join(root, "home");
      mkdirSync(home);
      const r = spawnSync(
        process.execPath,
        ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url)],
        {
          cwd: home,
          encoding: "utf8",
          maxBuffer: 1 << 26,
          env: {
            PATH: process.env.PATH,
            HOME: home,
            CLAUDE_CONFIG_DIR: join(root, "config"),
            MCP_DELTA_GOLDEN_CHILD: root,
            MCP_DELTA_GOLDEN_FAKE: fake,
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
  const calls = fixture.controls.reduce((n, c) => n + c.calls.length, 0);
  const routes = fixture.route.reduce((n, g) => n + g.cases.length, 0);
  console.log(
    `wrote ${out.slice(repo.length + 1)}: ${fixture.bodies.length} bodies, ${fixture.controls.length} control cases (${calls} calls), ${routes} route cases (SDK ${fixture.sdkVersion})`,
  );
  process.exit(0);
}

// ───────────────────────────────── child ─────────────────────────────────

const ROOT_DIR = process.env.MCP_DELTA_GOLDEN_CHILD;
const FAKE = process.env.MCP_DELTA_GOLDEN_FAKE;

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
const { Session, mcpDeltaReminderBody } = await import(join(repo, "lib/server/session.ts"));
const { takePendingReminders } = await import(join(repo, "lib/server/system-reminders.ts"));
const { sessionManager } = await import(join(repo, "lib/server/session-manager.ts"));
const { POST } = await import(join(repo, "app/api/sessions/[id]/mcp-dynamic/route.ts"));
const { query, createSdkMcpServer } = await import(SDK);
const sdkVersion = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.resolve(SDK))), "package.json"), "utf8"),
).version;

// ───────────────────────────── mcpDeltaReminderBody ─────────────────────────────

const LONG = "srv-".repeat(1250);
const MANY = Array.from({ length: 40 }, (_, i) => `server-${i}`);
const DELTAS = [
  {},
  { added: [], removed: [], disabled: [], reconnecting: [] },
  { added: [""] },
  { added: ["", ""], removed: [""], disabled: [""], reconnecting: [""] },
  { added: ["linear"] },
  { removed: ["linear"] },
  { disabled: ["linear"] },
  { reconnecting: ["linear"] },
  { added: ["linear", "slack"] },
  { removed: ["linear", "slack", "github"] },
  { disabled: ["a", "b"] },
  { reconnecting: ["a", "b"] },
  { added: ["linear"], removed: ["slack"] },
  { added: ["a"], reconnecting: ["b"] },
  { disabled: ["c"], reconnecting: ["d"] },
  { removed: ["r"], disabled: ["d"] },
  { added: ["a1", "a2"], removed: ["r1"], disabled: ["d1", "d2"], reconnecting: ["c1"] },
  // Input key order doesn't change the clause order.
  { reconnecting: ["c"], removed: ["r"], disabled: ["d"], added: ["a"] },
  { added: ["", "a", ""], removed: ["", "r"] },
  { added: [""], removed: ["r"] },
  { added: [], reconnecting: ["x"] },
  { added: ["a", "a", "a"] },
  { removed: ["dup", "other", "dup"] },
  { added: ["same"], removed: ["same"], disabled: ["same"], reconnecting: ["same"] },
  { added: [" "] },
  { added: ["\t", "\n", "\u00a0", "\ufeff", "\u2028", "\u3000"] },
  { reconnecting: ["  padded  "] },
  { disabled: ["a\nb", "c\r\nd"] },
  { added: ["s\u00ebrv\u00e9r", "\u{1F600}", "\u{1D11E} clef", "\u4e2d\u6587"] },
  { removed: ["e\u0301", "\u0000nul"] },
  { added: ["a, b", "c."] },
  { added: ["$1", "$&", "`x`", "<system-reminder>", "</system-reminder>"] },
  { added: ['quote"d', "back\\slash"] },
  { added: [LONG] },
  { reconnecting: [LONG, "short"] },
  { added: MANY },
  { added: MANY.slice(0, 10), removed: MANY.slice(10, 20), disabled: MANY.slice(20, 30), reconnecting: MANY.slice(30) },
];
const bodies = DELTAS.map((delta) => ({ delta, body: mcpDeltaReminderBody(delta) }));

// ─────────────────────────────── the bare session ───────────────────────────────

let dirs = 0;
/** A real SDK query against the fake CLI, as a bare session's `query`. */
async function openQuery(script) {
  const dir = join(ROOT_DIR, `q${dirs++}`);
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

function bareSession(id) {
  const host = Object.create(Session.prototype);
  host.id = id;
  host.query = null;
  return host;
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
    .map((l) => {
      const id = JSON.parse(l).request_id;
      return l.replace(JSON.stringify(id), '"$ID"');
    });
}

function outcomeOf(r) {
  if (!r.ok) return { ok: false, error: r.error };
  if (!("data" in r)) return { ok: true };
  return r.data === undefined ? { ok: true, data: null, dataUndefined: true } : { ok: true, data: r.data };
}

async function runCall(host, log, call) {
  const from = log ? readLines(log).length : 0;
  const [method, ...args] = call;
  const r = await host[method](...args);
  return { call, outcome: outcomeOf(r), wire: log ? wireSince(log, from) : [] };
}

// ───────────────────────────────── controls ─────────────────────────────────

const ctl = (subtype, response) => ({ control: { [subtype]: response } });
const SERVERS = { a: { command: "node", args: ["a.js"] } };
const setCase = (name, response, servers = SERVERS) => [
  name,
  ctl("mcp_set_servers", response),
  [["setMcpServers", servers]],
];

const CONTROLS = [
  // mcpServerStatus
  ["status default", null, [["mcpServerStatus"]]],
  [
    "status list",
    ctl("mcp_status", {
      mcpServers: [
        { name: "a", status: "connected", tools: [{ name: "t" }] },
        { name: "b", status: "pending" },
        { name: "c", status: "needs-auth", n: 1.5 },
      ],
    }),
    [["mcpServerStatus"]],
  ],
  ["status no list", ctl("mcp_status", {}), [["mcpServerStatus"]]],
  ["status null list", ctl("mcp_status", { mcpServers: null }), [["mcpServerStatus"]]],
  ["status string reply", ctl("mcp_status", "x"), [["mcpServerStatus"]]],
  ["status error", ctl("mcp_status", { $error: "status failed" }), [["mcpServerStatus"]]],
  // reconnectMcp
  ["reconnect", null, [["reconnectMcp", "github"]]],
  ["reconnect empty name", null, [["reconnectMcp", ""]]],
  ["reconnect space", null, [["reconnectMcp", " "]]],
  ["reconnect unicode", null, [["reconnectMcp", "s\u00ebrv\u00e9r \u{1F600}"]]],
  ["reconnect newline", null, [["reconnectMcp", "a\nb"]]],
  ["reconnect long", null, [["reconnectMcp", LONG]]],
  ["reconnect null reply", ctl("mcp_reconnect", null), [["reconnectMcp", "github"]]],
  ["reconnect error", ctl("mcp_reconnect", { $error: "Server not found: github" }), [["reconnectMcp", "github"]]],
  // toggleMcp
  ["enable", null, [["toggleMcp", "linear", true]]],
  ["disable", null, [["toggleMcp", "linear", false]]],
  ["enable empty name", null, [["toggleMcp", "", true]]],
  ["disable empty name", null, [["toggleMcp", "", false]]],
  ["toggle unicode", null, [["toggleMcp", "\u4e2d\u6587", false]]],
  ["toggle error", ctl("mcp_toggle", { $error: "toggle failed" }), [["toggleMcp", "linear", false]]],
  // setMcpServers: the fake's own add/remove diff
  [
    "set default diff",
    null,
    [
      ["setMcpServers", { b: { command: "b" }, a: { type: "http", url: "http://x" } }],
      ["setMcpServers", { a: { type: "http", url: "http://x" }, c: { command: "c" } }],
      ["setMcpServers", {}],
      ["setMcpServers", {}],
    ],
  ],
  setCase("set added", { added: ["a", "b"], removed: [], errors: {} }),
  setCase("set added removed errored", { added: ["a", "b"], removed: ["c"], errors: { b: "connect failed" } }),
  setCase("set removed only", { added: [], removed: ["x", "y"], errors: {} }),
  setCase("set nothing", { added: [], removed: [], errors: {} }),
  setCase("set all errored", { added: ["a"], removed: [], errors: { a: "boom" } }),
  setCase("set all errored with removal", { added: ["a"], removed: ["z"], errors: { a: "boom" } }),
  setCase("set empty object", {}),
  setCase("set null", null),
  setCase("set string", "str"),
  setCase("set number", 5),
  setCase("set true", true),
  setCase("set array", ["a"]),
  setCase("set added not an array", { added: "a", removed: "r" }),
  setCase("set added an object", { added: { 0: "a" }, removed: { 0: "r" } }),
  setCase("set non-string entries", {
    added: ["a", 5, null, true, {}, [], "b", "", 1.5],
    removed: [1, "r", null, "", false, ["x"]],
    errors: {},
  }),
  setCase("set errors null", { added: ["a"], removed: [], errors: null }),
  setCase("set errors array", { added: ["0", "1", "2", "a"], removed: [], errors: ["x", "y"] }),
  setCase("set errors empty array", { added: ["0", "a"], removed: [], errors: [] }),
  setCase("set errors string", { added: ["a", "0"], removed: [], errors: "a" }),
  setCase("set errors number", { added: ["a"], removed: [], errors: 7 }),
  setCase("set errors true", { added: ["a"], removed: [], errors: true }),
  setCase("set errors false", { added: ["a"], removed: [], errors: false }),
  setCase("set errors null value", { added: ["a", "b"], removed: [], errors: { a: null } }),
  setCase("set errors nested", { added: ["a", "b"], removed: ["b"], errors: { b: { message: "x", code: 1 } } }),
  // An own `__proto__` key, as `JSON.parse` makes one (a literal would set the prototype).
  setCase("set errors proto key", JSON.parse('{"added":["__proto__","a"],"removed":[],"errors":{"__proto__":"e"}}')),
  setCase("set errors index keys", { added: ["1", "10", "x"], removed: [], errors: { 10: "e", 1: "e" } }),
  setCase("set errors unknown name", { added: ["a"], removed: [], errors: { zz: "e" } }),
  setCase("set duplicates", { added: ["a", "a", "b"], removed: ["c", "c"], errors: { b: "e" } }),
  setCase("set unicode", { added: ["\u{1F600}", "s\u00ebrv"], removed: ["\u4e2d"], errors: {} }),
  setCase("set extra keys", { added: ["a"], removed: [], errors: {}, extra: { n: 1.5 } }),
  setCase("set removed errored", { added: [], removed: ["a"], errors: { a: "e" } }),
  // A script given as text reaches the fake as written: `1.0`, `1e2` and the
  // key order are the CLI's own.
  [
    "set number text",
    '{"control":{"mcp_set_servers":{"added":["a"],"removed":[],"errors":{"b":1.0},"n":1e2,"2":-0.0,"f":0.1}}}',
    [["setMcpServers", SERVERS]],
  ],
  setCase("set error", { $error: "set failed" }),
  // Several calls queue several blocks; a failed one queues none.
  [
    "sequence",
    ctl("mcp_toggle", { $error: "toggle refused" }),
    [
      ["reconnectMcp", "a"],
      ["setMcpServers", { x: { command: "x" }, y: { command: "y" } }],
      ["toggleMcp", "b", false],
      ["reconnectMcp", ""],
      ["setMcpServers", { y: { command: "y" } }],
      ["reconnectMcp", "c"],
    ],
  ],
  [
    "no query",
    "none",
    [["mcpServerStatus"], ["reconnectMcp", "a"], ["toggleMcp", "a", true], ["setMcpServers", SERVERS]],
  ],
  [
    "ended",
    "ended",
    [["mcpServerStatus"], ["reconnectMcp", "a"], ["toggleMcp", "a", false], ["setMcpServers", SERVERS]],
  ],
];

const controls = [];
for (const [name, script, calls] of CONTROLS) {
  const host = bareSession(`golden-${controls.length}`);
  let q = null;
  if (script !== "none") {
    q = await openQuery(script === "ended" ? null : script);
    host.query = q.q;
    if (script === "ended") await q.close();
  }
  const results = [];
  for (const call of calls) results.push(await runCall(host, q?.log, call));
  const reminder = takePendingReminders(host);
  const again = takePendingReminders(host);
  if (again !== null) throw new Error(`${name}: takePendingReminders didn't drain`);
  if (q && script !== "ended") await q.close();
  controls.push({ name, script: script === "none" || script === "ended" ? null : script, query: script === "none" ? "none" : script === "ended" ? "ended" : "live", calls: results, reminder });
}

// ─────────────────────────────────── route ───────────────────────────────────

const ROUTE_BODIES = [
  "",
  "{",
  "not json",
  "null",
  "[]",
  "5",
  "0",
  "true",
  "false",
  '""',
  '"x"',
  "{}",
  '{"server":{}}',
  '{"servers":null}',
  '{"servers":[]}',
  '{"servers":[{"a":1}]}',
  '{"servers":"x"}',
  '{"servers":""}',
  '{"servers":5}',
  '{"servers":true}',
  '{"servers":false}',
  "[{\"servers\":{}}]",
  '{"servers":{}}',
  '{"servers":{"a":{"command":"node","args":["a.js"]}}}',
  '{"servers":{"a":{"command":"node","args":["a.js"]},"b":{"type":"http","url":"http://x","headers":{"h":"v"}}}}',
  '{"servers":{"b":{"type":"http","url":"http://x"}}}',
  '\ufeff{"servers":{"c":{"command":"c"}}}',
  '{"servers":{"c":{"command":"c"}},"extra":1}',
  '{"servers":{},"servers":{"d":{"command":"d"}}}',
  '{"servers":{"d":"str","e":5,"f":[],"g":true}}',
  '{"servers":{"z":{"command":"z"},"2":{"command":"two"},"y":{"command":"y"},"10":{"command":"ten"},"1":{"command":"one"}}}',
  '{"servers":{"n":{"command":"n","timeout":1.0,"x":1e2,"y":-0.0,"z":2.5,"env":{"b":"1","3":"x","a":"2"}}}}',
  '{"servers":{"s\\u00ebrv\\u00e9r \\ud83d\\ude00":{"command":"u"}}}',
  '{"servers":{"":{"command":"empty"}}}',
  '{"servers":{"x":{"type":"sdk","name":"x"}}}',
  '{"servers":{"a":null}}',
  '{"servers":{"ok":{"command":"ok"},"a":null}}',
  '{"servers":{"x":{"type":"sdk","instance":{}}}}',
  '{"servers":{"x":{"type":"sdk","instance":null}}}',
  '{"__proto__":{"servers":{}}}',
  '{"servers":{"__proto__":{"command":"p"},"q":{"command":"q"}}}',
  '{"servers":{"__proto__":null}}',
  '{"servers":{"__proto__":"p"}}',
  '{"servers":{"big":{"command":"b","n":1e21,"m":1e-7}}}',
  '{"servers":{"nums":{"command":"n","a":0.000001,"b":1e-7,"c":123456789012345680000,"d":5e-324,"e":1.7976931348623157e308,"f":-1.5e-10,"g":1e300,"h":0.1,"i":100.0}}}',
  '{"servers":{}}',
];
// Scripted CLI answers to `mcp_set_servers`, one session each.
const ROUTE_SCRIPTED = [
  ["error", ctl("mcp_set_servers", { $error: "set failed" })],
  ["null reply", ctl("mcp_set_servers", null)],
  ["string reply", ctl("mcp_set_servers", "str")],
  [
    "numbers in the reply",
    '{"control":{"mcp_set_servers":{"added":["a"],"removed":[],"errors":{"b":{"code":1.0,"at":1e2}},"x":[1.0,1e21],"2":1.5}}}',
  ],
  ["errored added", ctl("mcp_set_servers", { added: ["a", "b"], removed: ["c"], errors: { a: "boom" } })],
];
const SCRIPTED_BODY = '{"servers":{"a":{"command":"a"},"b":{"command":"b"}}}';

async function routeCall(host, log, id, body) {
  const from = log ? readLines(log).length : 0;
  let got;
  try {
    const res = await POST(new Request("http://x/api", { method: "POST", body }), { params: Promise.resolve({ id }) });
    got = { status: res.status, body: await res.text() };
  } catch (e) {
    got = { threw: e instanceof Error ? e.message : String(e) };
  }
  return {
    id: id === host.id ? "live" : id,
    request: body,
    ...got,
    wire: log ? wireSince(log, from) : [],
    reminder: takePendingReminders(host),
  };
}

async function routeGroup(name, script, bodies) {
  const host = bareSession(`golden-route-${name}`);
  let q = null;
  if (script !== "none") {
    q = await openQuery(script);
    host.query = q.q;
  }
  sessionManager.get = (id) => (id === host.id ? host : undefined);
  const cases = [];
  if (name === "validation") cases.push(await routeCall(host, null, "missing", '{"servers":{}}'));
  for (const body of bodies) cases.push(await routeCall(host, q?.log, host.id, body));
  if (q) await q.close();
  return { name, script: script === "none" ? null : script, query: script === "none" ? "none" : "live", cases };
}

const route = [await routeGroup("validation", null, ROUTE_BODIES)];
for (const [name, script] of ROUTE_SCRIPTED) route.push(await routeGroup(name, script, [SCRIPTED_BODY, "{}", '{"servers":{}}']));
route.push(await routeGroup("no query", "none", [SCRIPTED_BODY, '{"servers":[]}']));

// A file, not stdout: `process.exit` would cut a piped stdout short.
writeFileSync(join(ROOT_DIR, "out.json"), JSON.stringify({ sdkVersion, bodies, controls, route }));
process.exit(0);
