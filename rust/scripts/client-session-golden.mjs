#!/usr/bin/env node
// Golden fixture for the chat client's state machine (U01c onward): the REAL
// `useSession` hook (lib/client/use-session.ts) mounted under react-dom 19 in
// plain node, fed scripted server events one `act()` at a time.
//
//   node rust/scripts/client-session-golden.mjs     (node@22)
//
// Re-runs itself under `--experimental-transform-types` with HOME in a temp
// dir and `TZ` pinned, twice; both recordings must agree byte for byte.
// Nothing is installed: react / react-dom / next come from the repo's
// node_modules, and the browser is hand-rolled shims:
// - `window` / `document` with in-memory storage, `history` and a location
//   (`http://localhost:3000/?session=sess-1` unless the scenario says);
// - a fake `EventSource` (the test opens it and pushes `data` text to
//   `onmessage`, exactly what the SSE route sends);
// - a scripted `fetch` (per-scenario routes first, then the defaults below;
//   a route's response is `{ status, body }`, `{ status, text }` for a raw
//   body, `{ reject }` for a network error, or a list used in turn);
// - a fake clock (`Date` / `Date.now`, `performance.timeOrigin`), counted
//   `crypto.randomUUID()` (`00000000-0000-4000-8000-000000000001`, ...), a
//   counted `getRandomValues` (so the tab id is the same in every scenario)
//   and fake timers. The timers go in after react-dom loads, so React's own
//   scheduler keeps the real ones; `act` drains it.
//
// A scenario is a prelude (mount: the boot effect resumes `?session=`, binds
// and opens the stream; then the stream's `open`, all on the default
// routes) and a list of steps (on the scenario's routes). A step first sets
// `document.hidden` if it says (`hidden`, no `visibilitychange`), moves the
// clock by `dt` ms (1000 by default), firing every timer that falls due on
// the way, each in its own `act()`, then does its input in one `act()`: an
// SSE message (`data`), or a hook action (`action` with `args`). Later
// slices add scenarios (and step kinds) to `scenarios` below.
//
// The prelude also records the stream URL (`eventSource`, which carries the
// tab id) and the uuids used so far (`uuids`). After the prelude and after
// each step it records:
// - `state`: the hook's return value minus its functions, as the client's
//   snapshot JSON (see `enc`). The prelude has every key; a step has only
//   the keys that changed.
// - `fetches`: each `fetch` call in order, `{ method, url, headers?, body?,
//   response: { status, body } | reject }` (`body` is the text sent or
//   received);
// - `timers`: `{ op: "set", id, kind, ms }`, `{ op: "clear", id }` (only of
//   a live timer) and `{ op: "fire", id }`, in order;
// - `windowEvents` (`dispatchEvent`), `history` (`replaceState` /
//   `pushState`), `storage` (sessionStorage after the step, when it changed)
//   and `logs` (console output; an Error prints as `<name>: <message>`).
// Empty lists are left out.
//
// Snapshot JSON: a top-level `undefined` is `{"$undefined": true}`, a nested
// one is left out (an array item is `null`), a `Set` is an array, the
// `Record`s the UI iterates (`RECORDS`) are `[key, value]` pairs in own-key
// order, and a number JSON can't hold is `{"$num": "NaN" | "Infinity" |
// "-Infinity" | "-0"}`.
//
// Written to rust/crates/claudius-client/tests/fixtures/client_session_golden.json
// and replayed by crates/claudius-client/tests/client_session_golden.rs.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "crates/claudius-client/tests/fixtures/client_session_golden.json");
const TZ = "America/New_York";
const NOW = 1763300000000;

if (!process.env.CLIENT_SESSION_GOLDEN_CHILD) {
  const runs = [0, 1].map(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "client-session-golden-")));
    try {
      const r = spawnSync(
        process.execPath,
        ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url)],
        {
          cwd: repo,
          encoding: "utf8",
          maxBuffer: 1 << 26,
          env: { PATH: process.env.PATH, HOME: root, TZ, CLIENT_SESSION_GOLDEN_CHILD: root },
        },
      );
      if (r.status !== 0) {
        process.stderr.write(r.stdout);
        process.stderr.write(r.stderr);
        process.exit(r.status ?? 1);
      }
      return readFileSync(join(root, "out.json"), "utf8");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  if (runs[0] !== runs[1]) {
    const keep = mkdtempSync(join(tmpdir(), "client-session-golden-diff-"));
    runs.forEach((r, i) => writeFileSync(join(keep, `run${i}.json`), r));
    throw new Error(`the two recordings differ (both kept in ${keep})`);
  }
  writeFileSync(out, runs[0]);
  const fixture = JSON.parse(runs[0]);
  const steps = fixture.scenarios.reduce((n, s) => n + s.steps.length, 0);
  console.log(
    `wrote ${out.slice(repo.length + 1)}: ${fixture.scenarios.length} scenarios, ${steps} steps (stable)`,
  );
  process.exit(0);
}

const ROOT_DIR = process.env.CLIENT_SESSION_GOLDEN_CHILD;
const REAL_NM = realpathSync(join(repo, "node_modules")) + "/";

// ------------------------------ resolve hook ------------------------------

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

// ------------------------------- recording --------------------------------

/** What the current scenario has seen since the last record. */
let rec = null;
function freshRec() {
  return { fetches: [], timers: [], windowEvents: [], history: [], logs: [] };
}

function errText(e) {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}
for (const level of ["error", "warn", "log", "info", "debug"]) {
  console[level] = (...args) => {
    const text = args.map((a) => (a instanceof Error ? errText(a) : typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    if (rec) rec.logs.push({ level, text });
    else process.stderr.write(`${level}: ${text}\n`);
  };
}
process.on("unhandledRejection", (e) => {
  if (rec) rec.logs.push({ level: "unhandledRejection", text: errText(e) });
});

// ------------------------------ determinism -------------------------------

const clock = { now: NOW };
const RealDate = Date;
class FakeDate extends RealDate {
  constructor(...a) {
    if (a.length === 0) super(clock.now);
    else super(...a);
  }
  static now() {
    return clock.now;
  }
}
globalThis.Date = FakeDate;
// The boot guard stamps its marker with the page load.
Object.defineProperty(globalThis.performance, "timeOrigin", { configurable: true, value: NOW - 5000 });
let uuidN = 0;
Object.defineProperty(globalThis.crypto, "randomUUID", {
  configurable: true,
  value: () => `00000000-0000-4000-8000-${String(++uuidN).padStart(12, "0")}`,
});
let rndByte = 0;
Object.defineProperty(globalThis.crypto, "getRandomValues", {
  configurable: true,
  value: (arr) => {
    for (let i = 0; i < arr.length; i++) arr[i] = (rndByte++ * 37 + 11) & 0xff;
    return arr;
  },
});

// -------------------------------- DOM shim --------------------------------

class MemStorage {
  #m = new Map();
  get length() {
    return this.#m.size;
  }
  key(i) {
    return [...this.#m.keys()][i] ?? null;
  }
  getItem(k) {
    return this.#m.has(k) ? this.#m.get(k) : null;
  }
  setItem(k, v) {
    this.#m.set(k, String(v));
  }
  removeItem(k) {
    this.#m.delete(k);
  }
  clear() {
    this.#m.clear();
  }
  dump() {
    return Object.fromEntries(this.#m);
  }
}
const sessionStorage = new MemStorage();
const localStorage = new MemStorage();
let locationObj = new URL("http://localhost:3000/");
const history = {
  state: null,
  replaceState(state, _t, url) {
    rec.history.push({ op: "replaceState", url: String(url) });
    this.state = state;
    locationObj.href = new URL(url, locationObj.href).href;
  },
  pushState(state, _t, url) {
    rec.history.push({ op: "pushState", url: String(url) });
    this.state = state;
    locationObj.href = new URL(url, locationObj.href).href;
  },
};
const docTarget = new EventTarget();
const document = {
  nodeType: 9,
  nodeName: "#document",
  hidden: false,
  visibilityState: "visible",
  activeElement: null,
  body: null,
  ownerDocument: null,
  addEventListener: docTarget.addEventListener.bind(docTarget),
  removeEventListener: docTarget.removeEventListener.bind(docTarget),
  dispatchEvent: docTarget.dispatchEvent.bind(docTarget),
};
const container = {
  nodeType: 1,
  nodeName: "DIV",
  tagName: "DIV",
  namespaceURI: "http://www.w3.org/1999/xhtml",
  ownerDocument: document,
  textContent: "",
  addEventListener() {},
  removeEventListener() {},
};
const winTarget = new EventTarget();
globalThis.window = {
  get location() {
    return locationObj;
  },
  history,
  sessionStorage,
  localStorage,
  document,
  event: undefined,
  HTMLIFrameElement: class HTMLIFrameElement {},
  addEventListener: winTarget.addEventListener.bind(winTarget),
  removeEventListener: winTarget.removeEventListener.bind(winTarget),
  dispatchEvent: (e) => {
    rec.windowEvents.push({ type: e.type, detail: enc(e.detail ?? null) });
    return winTarget.dispatchEvent(e);
  },
};
globalThis.document = document;

// ------------------------------- fake fetch -------------------------------

const DEFAULT_ROUTES = [
  ["POST", "^/api/sessions$", { status: 200, body: { id: "sess-1", cwd: "/work/proj" } }],
  ["GET", "^/api/sessions$", { status: 200, body: [{ id: "sess-1", cwd: "/work/proj", title: null, status: "idle" }] }],
  [
    "GET",
    "^/api/sessions/all\\?limit=25$",
    {
      status: 200,
      body: { sessions: [{ sessionId: "sess-1", cwd: "/work/proj", lastModified: NOW - 1_000_000 }], accountsConfigured: 0 },
    },
  ],
  ["GET", "^/api/sessions/open-tabs$", { status: 200, body: { activeId: null } }],
  ["GET", "^/api/sessions/[^/]+/advisor$", { status: 200, body: { model: null } }],
  ["GET", "^/api/sessions/[^/]+/suggested-messages$", { status: 200, body: { uuids: [] } }],
  ["GET", "^/api/sessions/[^/]+/goal-messages$", { status: 200, body: { uuids: [] } }],
  ["GET", "^/api/sessions/[^/]+/pending-prompts$", { status: 200, body: { asks: [], permissions: [], elicitations: [] } }],
  ["POST", "^/api/sessions/[^/]+/recap$", { status: 200, body: { ok: true } }],
];
/** [method, RegExp, spec, calls] for the current scenario. */
let routes = [];
function setRoutes(extra = []) {
  routes = [...extra, ...DEFAULT_ROUTES].map(([m, re, spec]) => ({ m, re: new RegExp(re), spec, calls: 0 }));
}
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  const method = (init.method ?? "GET").toUpperCase();
  const entry = { method, url };
  if (init.headers) entry.headers = { ...init.headers };
  if (init.body !== undefined) entry.body = String(init.body);
  rec.fetches.push(entry);
  const hit = routes.find((r) => r.m === method && r.re.test(url));
  let spec = hit ? hit.spec : { status: 404, body: { error: "not stubbed" } };
  if (Array.isArray(spec)) spec = spec[Math.min(hit.calls++, spec.length - 1)];
  if (spec.reject) {
    entry.reject = `TypeError: ${spec.reject}`;
    throw new TypeError(spec.reject);
  }
  const text = spec.text ?? JSON.stringify(spec.body);
  entry.response = { status: spec.status, body: text };
  return new Response(text, { status: spec.status, headers: { "content-type": "application/json" } });
};

// ---------------------------- fake EventSource ----------------------------

let sources = [];
class FakeEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    sources.push(this);
  }
  close() {
    this.readyState = 2;
  }
  addEventListener(type) {
    throw new Error(`unexpected EventSource.addEventListener(${type})`);
  }
  open() {
    this.readyState = 1;
    this.onopen?.({ type: "open" });
  }
  send(data) {
    this.onmessage?.({ type: "message", data });
  }
}
globalThis.EventSource = FakeEventSource;

// --------------------------------- imports --------------------------------

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import(pathToFileURL(REAL_NM + "react/index.js").href)).default;
const { createRoot } = (await import(pathToFileURL(REAL_NM + "react-dom/client.js").href)).default;
const { useSession } = await import(pathToFileURL(join(repo, "lib/client/use-session.ts")).href);
const { act } = React;
if (typeof act !== "function") throw new Error("React.act missing (production build?)");
const { PathnameContext } = (
  await import(pathToFileURL(REAL_NM + "next/dist/shared/lib/hooks-client-context.shared-runtime.js").href)
).default;
const realSetImmediate = globalThis.setImmediate;

// ------------------------------- fake timers ------------------------------

let timers = new Map();
let timerSeq = 0;
function addTimer(kind, fn, ms, args) {
  const id = ++timerSeq;
  const delay = Number(ms) > 0 ? Number(ms) : 0;
  timers.set(id, { id, kind, ms: delay, due: clock.now + delay, fn, args });
  rec.timers.push({ op: "set", id, kind, ms: delay });
  return id;
}
function clearTimer(id) {
  if (!timers.has(id)) return;
  timers.delete(id);
  rec.timers.push({ op: "clear", id });
}
globalThis.setTimeout = (fn, ms, ...args) => addTimer("timeout", fn, ms, args);
globalThis.setInterval = (fn, ms, ...args) => addTimer("interval", fn, ms, args);
globalThis.clearTimeout = clearTimer;
globalThis.clearInterval = clearTimer;

async function drain() {
  for (let i = 0; i < 8; i++) await new Promise((r) => realSetImmediate(r));
}

/** Move the clock by `ms`, firing each timer that falls due, in due order. */
async function advance(ms) {
  const target = clock.now + ms;
  for (;;) {
    const next = [...timers.values()]
      .filter((t) => t.due <= target)
      .sort((a, b) => a.due - b.due || a.id - b.id)[0];
    if (!next) break;
    clock.now = next.due;
    if (next.kind === "interval") next.due += Math.max(1, next.ms);
    else timers.delete(next.id);
    rec.timers.push({ op: "fire", id: next.id });
    await act(async () => {
      next.fn(...next.args);
      await drain();
    });
  }
  clock.now = target;
}

// -------------------------------- encoding --------------------------------

const RECORDS = new Set(["toolProgress", "tasks", "subagentMessages", "backgroundBashes", "scheduledLoops"]);
const def = (o, k, v) => Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });

function enc(v) {
  if (v === undefined) return { $undefined: true };
  if (typeof v === "number") {
    if (Number.isNaN(v)) return { $num: "NaN" };
    if (Object.is(v, -0)) return { $num: "-0" };
    if (!Number.isFinite(v)) return { $num: String(v) };
    return v;
  }
  if (typeof v === "function") return { $function: v.name };
  if (v === null || typeof v !== "object") return v;
  if (v instanceof Set) return [...v].map(enc);
  if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : enc(x)));
  const o = {};
  for (const [k, x] of Object.entries(v)) if (x !== undefined) def(o, k, enc(x));
  return o;
}

function snapshot(hookValue) {
  const o = {};
  for (const [k, v] of Object.entries(hookValue)) {
    if (typeof v === "function") continue;
    if (RECORDS.has(k) && v && typeof v === "object") {
      def(o, k, Object.entries(v).map(([rk, rv]) => [rk, enc(rv)]));
    } else {
      def(o, k, enc(v));
    }
  }
  return o;
}

// --------------------------------- driver ---------------------------------

let latest = null;
function Probe() {
  latest = useSession();
  return null;
}

async function runScenario(sc) {
  clock.now = NOW;
  uuidN = 0;
  rndByte = 0;
  timers = new Map();
  timerSeq = 0;
  sources = [];
  sessionStorage.clear();
  localStorage.clear();
  locationObj = new URL(sc.url ?? "http://localhost:3000/?session=sess-1");
  history.state = null;
  document.hidden = false;
  setRoutes();
  rec = freshRec();

  let prevState = {};
  let prevStorage = "{}";
  const record = (extra) => {
    const full = snapshot(latest);
    const state = {};
    for (const [k, v] of Object.entries(full)) {
      if (JSON.stringify(v) !== JSON.stringify(prevState[k])) def(state, k, v);
    }
    prevState = full;
    const r = { ...extra, at: clock.now, state };
    for (const [k, list] of Object.entries(rec)) if (list.length > 0) r[k] = list;
    const storage = JSON.stringify(sessionStorage.dump());
    if (storage !== prevStorage) r.storage = sessionStorage.dump();
    prevStorage = storage;
    rec = freshRec();
    return r;
  };

  let el = React.createElement(Probe);
  if (sc.pathname !== undefined) el = React.createElement(PathnameContext.Provider, { value: sc.pathname }, el);
  const root = createRoot(container);
  await act(async () => {
    root.render(el);
    await drain();
  });
  const es = sources.at(-1);
  if (!es) throw new Error(`${sc.name}: the prelude opened no EventSource`);
  await act(async () => {
    es.open();
    await drain();
  });
  const tabId = new URL(es.url, "http://localhost:3000").searchParams.get("tabId");
  const prelude = record({ eventSource: es.url, uuids: uuidN });
  setRoutes(sc.routes);

  const steps = [];
  for (const raw of sc.steps) {
    const st = typeof raw === "function" ? raw({ tabId }) : raw;
    const dt = st.dt ?? 1000;
    if (st.hidden !== undefined) document.hidden = st.hidden;
    await advance(dt);
    const input = {};
    if (st.data !== undefined) {
      input.data = st.data;
      await act(async () => {
        es.send(st.data);
        await drain();
      });
    } else if (st.action) {
      input.action = st.action;
      input.args = st.args ?? [];
      await act(async () => {
        latest[st.action](...input.args);
        await drain();
      });
    }
    steps.push(
      record({ ...(st.hidden !== undefined ? { hidden: st.hidden } : {}), ...(st.dt !== undefined ? { dt } : {}), ...input }),
    );
  }

  rec = freshRec();
  await act(async () => {
    root.unmount();
    await drain();
  });
  if (timers.size !== 0) throw new Error(`${sc.name}: timers left after unmount: ${[...timers.keys()]}`);
  rec = null;
  return { name: sc.name, ...(sc.routes ? { routes: sc.routes } : {}), prelude, steps };
}

// -------------------------------- scenarios -------------------------------

const ev = (o) => ({ data: JSON.stringify(o) });
const raw = (data) => ({ data });
const wait = (ms) => ({ dt: ms });
const call = (action, ...args) => ({ action, args });

const LONE_HI = String.fromCharCode(0xd83d);
const ACCOUNT = { id: "acc_1", label: "Personal Max", driftFromActive: { id: "acc_2", label: "Work" } };
const READY = { type: "ready", sessionId: "sess-1" };
const RUNNING = { type: "turn_status", status: "running" };
const IDLE = { type: "turn_status", status: "idle" };
// The `sdk` envelope (U01d): `at` is the server's stamp, left out when not
// given.
const SID = "sess-1";
const OPUS = "claude-opus-4-5";
const S = (message, at) => ev({ type: "sdk", message: { session_id: SID, ...message }, ...(at === undefined ? {} : { at }) });
const U = (input, output, extra = {}) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  ...extra,
});
/** A `BetaMessage` holding one split's content. */
const M = (id, content, extra = {}) => ({
  id,
  type: "message",
  role: "assistant",
  model: OPUS,
  content,
  stop_reason: null,
  usage: U(10, 5),
  ...extra,
});
/** `SDKAssistantMessage`. */
const A = (uuid, message, o = {}) =>
  S({ type: "assistant", message, parent_tool_use_id: o.parent ?? null, uuid, ...(o.extra ?? {}) }, o.at);
/** `SDKPartialAssistantMessage`. */
const E = (uuid, event, o = {}) => S({ type: "stream_event", event, parent_tool_use_id: o.parent ?? null, uuid }, o.at);
/** `SDKResultSuccess` / `SDKResultError`. */
const R = (extra = {}) =>
  S({
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 1200,
    duration_api_ms: 1100,
    num_turns: 1,
    result: "Done",
    stop_reason: "end_turn",
    total_cost_usd: 0.0123,
    usage: U(10, 5),
    modelUsage: {},
    permission_denials: [],
    ...extra,
  });
const sessionsAs = (status) => ({
  status: 200,
  body: [{ id: "sess-1", cwd: "/work/proj", title: null, status }],
});

const scenarios = [
  {
    name: "ready with every field",
    steps: [
      ev({
        ...READY,
        transcriptPath: "~/.claude/projects/-work-proj/sess-0.jsonl",
        agent: "reviewer",
        fallbackModel: "claude-sonnet-4-5",
        account: ACCOUNT,
      }),
    ],
  },
  {
    name: "duplicate ready",
    steps: [
      ev(READY),
      ev({ ...READY, transcriptPath: "~/a.jsonl", agent: "reviewer", account: ACCOUNT }),
      ev(READY),
      ev({ ...READY, transcriptPath: "~/b.jsonl" }),
      ev({ ...READY, transcriptPath: null, agent: null, account: null }),
      ev({ ...READY, agent: "", account: { id: 5 }, fallbackModel: 7 }),
      ev({ ...READY, agent: 3, account: "acc", transcriptPath: "" }),
    ],
  },
  {
    name: "bind, ready, replay, turn",
    steps: [
      ({ tabId }) => ev({ type: "holder_changed", holderId: tabId }),
      ev({ type: "tips", tips: [{ id: "t1", text: "Press Esc to interrupt" }] }),
      ev({ type: "turn_status", status: "idle", backgroundTasks: 0 }),
      ev({ ...READY, transcriptPath: "~/t.jsonl" }),
      ev({ type: "replay_done", hasMoreAbove: true }),
      ev({ type: "session_title", title: "Fix the login bug" }),
      ev({ type: "goal_changed", goal: "Ship the fix", achieved: false, setAt: NOW + 5000 }),
      ev(RUNNING),
      ev({ type: "turn_status", status: "needs_input" }),
      ev(RUNNING),
      ev({ type: "turn_status", status: "idle", backgroundTasks: 2 }),
      ev({ type: "goal_changed", goal: "Ship the fix", achieved: true, summary: "Done", setAt: NOW + 5000, achievedAt: NOW + 11000 }),
      wait(31_000),
    ],
  },
  {
    name: "events before ready",
    steps: [
      ev(RUNNING),
      ev({ type: "session_title", title: "Early" }),
      ev({ type: "cwd_changed", cwd: "/work/proj/.claude/worktrees/x" }),
      ev({ type: "holder_changed", holderId: "tab-someone-else" }),
      ev({ type: "error", message: "before ready" }),
      ev(READY),
      ev({ type: "replay_done", hasMoreAbove: false }),
    ],
  },
  {
    name: "holder_changed",
    steps: [
      ({ tabId }) => ev({ type: "holder_changed", holderId: tabId }),
      ev({ type: "holder_changed", holderId: "tab-other" }),
      ev({ type: "holder_changed", holderId: null }),
      ev({ type: "holder_changed" }),
      ({ tabId }) => ev({ type: "holder_changed", holderId: tabId }),
      ev({ type: "holder_changed", holderId: 5 }),
      ev({ type: "holder_changed", holderId: "" }),
    ],
  },
  {
    name: "error",
    steps: [
      ev({ type: "error", message: "boom" }),
      ev(RUNNING),
      ev({ type: "error", message: 5, sessionEnded: 0 }),
      ev({ type: "error", sessionEnded: null }),
      ev({ type: "error", message: { detail: "x" }, sessionEnded: "yes" }),
      ev(RUNNING),
      ev({ type: "error", message: "the CLI exited", sessionEnded: true }),
      ev({ type: "error", message: `lone ${LONE_HI} half`, sessionEnded: false }),
    ],
  },
  {
    name: "cwd_changed",
    steps: [
      ev({ type: "cwd_changed", cwd: "/work/proj/.claude/worktrees/feature" }),
      ev({ type: "cwd_changed", cwd: "/work/proj" }),
      ev({ type: "cwd_changed" }),
      ev({ type: "cwd_changed", cwd: null }),
      ev({ type: "cwd_changed", cwd: 42 }),
    ],
  },
  {
    name: "session_title",
    steps: [
      ev({ type: "session_title", title: "My title" }),
      ev({ type: "session_title", title: "" }),
      ev({ type: "session_title", title: null }),
      ev({ type: "session_title", title: "Again" }),
      ev({ type: "session_title" }),
      ev({ type: "session_title", title: 42 }),
      ev({ type: "session_title", title: ["a"] }),
    ],
  },
  {
    name: "goal_changed",
    steps: [
      ev({ type: "goal_changed", goal: "Ship it", achieved: false, setAt: NOW }),
      ev({ type: "goal_changed", goal: "Ship it", achieved: true, summary: "Shipped", setAt: NOW, achievedAt: NOW + 9000 }),
      ev({ type: "goal_changed", goal: null, achieved: false }),
      ev({ type: "goal_changed", goal: "Minimal" }),
      ev({ type: "goal_changed", goal: "" }),
      ev({ type: "goal_changed", goal: 5, achieved: "yes", summary: 0, setAt: "soon", achievedAt: null }),
      ev({ type: "goal_changed" }),
      ev({ type: "goal_changed", goal: { text: "obj" }, achieved: 0, summary: null }),
    ],
  },
  {
    name: "account, agent and mode",
    steps: [
      ev({ type: "account_changed", account: ACCOUNT }),
      ev({ type: "account_changed", account: { id: "acc_1", label: "Personal Max" } }),
      ev({ type: "account_changed" }),
      ev({ type: "account_changed", account: null }),
      ev({ type: "agent_changed", agent: "planner" }),
      ev({ type: "agent_changed", agent: null }),
      ev({ type: "agent_changed" }),
      ev({ type: "agent_changed", agent: 1 }),
      ev({ type: "mode_changed", mode: "plan" }),
      ev({ type: "mode_changed", mode: "acceptEdits" }),
      ev({ type: "mode_changed" }),
      ev({ type: "mode_changed", mode: "bypassPermissions" }),
      ev({ type: "mode_changed", mode: null }),
    ],
  },
  {
    name: "tips",
    steps: [
      ev({ type: "tips", tips: [{ id: "a", text: "one" }, { id: "b", text: "two", weight: 2 }] }),
      ev({ type: "tips", tips: [] }),
      ev({ type: "tips" }),
      ev({ type: "tips", tips: "nope" }),
      ev({ type: "tips", tips: null }),
    ],
  },
  {
    name: "feedback survey and nudges",
    steps: [
      ev({ type: "feedback_survey", sessionId: "sess-1", surface: "post_turn" }),
      ev({ type: "opus_overload_nudge", model: "claude-opus-4-5", count: 2 }),
      ev({ type: "long_context_credits_required", model: "claude-sonnet-4-5[1m]" }),
      ev({ type: "auth_failed_required", model: "claude-opus-4-5", reason: "oauth_revoked" }),
      ev({ type: "token_expiring_required", expiresAt: NOW + 3_600_000 }),
      ev({ type: "opus_overload_nudge", model: "claude-opus-4-5", count: 3, extra: { nested: [1, null] } }),
      ev({ type: "feedback_survey" }),
      ev({ type: "auth_failed_required" }),
      ev({ type: "token_expiring_required", expiresAt: "later" }),
      ev({ type: "long_context_credits_required", model: null }),
    ],
  },
  {
    name: "mcp notices",
    steps: [
      ev({ type: "mcp_needs_auth_notice", servers: ["linear"] }),
      ev({ type: "mcp_needs_auth_notice", servers: ["linear", "slack"] }),
      ev({ type: "mcp_disconnected_notice", servers: ["postgres"] }),
      ev({ type: "mcp_disconnected_notice", servers: ["a", "b", "c"] }),
      ev({ type: "mcp_needs_auth_notice", servers: [] }),
      ev({ type: "mcp_disconnected_notice", servers: [null, 5, ["x", ["y", null]], { a: 1 }, true, ""] }),
      ev({ type: "mcp_needs_auth_notice", servers: [`caf${String.fromCharCode(0xe9)}`, LONE_HI] }),
      ev(READY),
      ev({ type: "mcp_disconnected_notice", servers: ["after ready"] }),
    ],
  },
  {
    name: "mcp notices that throw",
    steps: [
      ev({ type: "mcp_needs_auth_notice" }),
      ev({ type: "mcp_needs_auth_notice", servers: null }),
      ev({ type: "mcp_disconnected_notice", servers: "linear" }),
      ev({ type: "mcp_disconnected_notice", servers: 3 }),
      ev({ type: "mcp_needs_auth_notice", servers: { 0: "a", length: 1 } }),
      ev({ type: "mcp_needs_auth_notice", servers: [{ toString: "x" }] }),
      ev({ type: "mcp_disconnected_notice", servers: ["ok"] }),
    ],
  },
  {
    name: "session recap",
    steps: [
      ev({ type: "session_recap", text: "We fixed the bug.", at: NOW, origin: "away" }),
      ev({ type: "session_recap_error", reason: "failed", message: "ignored: not loading" }),
      call("dismissRecap"),
      ev({ type: "session_recap_error", reason: "failed" }),
      call("requestRecap"),
      ev({ type: "session_recap_error", reason: "rate_limited" }),
      call("requestRecap", "away"),
      ev({ type: "session_recap_error", reason: "failed", message: "model overloaded" }),
      call("requestRecap", "manual"),
      ev({ type: "session_recap_error", reason: "failed" }),
      call("requestRecap", "away"),
      ev({ type: "session_recap", text: "Recap text", at: NOW + 2000, origin: "away" }),
      ev({ type: "session_recap_error", reason: "failed", message: "late" }),
      call("requestRecap"),
      ev({ type: "session_recap" }),
      call("requestRecap"),
      ev({ type: "session_recap_error", reason: "failed", message: null }),
      call("requestRecap"),
      ev({ type: "session_recap_error" }),
      call("requestRecap"),
      ev({ type: "session_recap_error", reason: "failed", message: 7 }),
    ],
  },
  {
    name: "recap request fails",
    routes: [["POST", "^/api/sessions/[^/]+/recap$", [{ status: 500, body: { error: "no" } }, { reject: "Failed to fetch" }, { status: 202, text: "" }]]],
    steps: [call("requestRecap"), call("requestRecap", "away"), call("requestRecap")],
  },
  {
    name: "turn_status",
    steps: [
      ev(RUNNING),
      ev(RUNNING),
      ev({ type: "turn_status", status: "needs_input", backgroundTasks: 1 }),
      ev({ type: "turn_status", status: "idle", backgroundTasks: 3 }),
      ev({ type: "turn_status", status: "idle" }),
      ev({ type: "turn_status", status: "running", backgroundTasks: "2" }),
      ev({ type: "turn_status" }),
      ev({ type: "turn_status", status: 5, backgroundTasks: null }),
      ev({ type: "turn_status", status: "RUNNING" }),
    ],
  },
  {
    name: "unknown and malformed events",
    steps: [
      ev({ type: "brand_new_event", x: 1 }),
      ev({}),
      raw("null"),
      raw("5"),
      raw('"ready"'),
      raw("[1,2]"),
      raw('{"type":'),
      raw(""),
      ev({ type: 5 }),
      ev({ type: "READY" }),
      ev({ type: "account_auto_rotated", fromLabel: "A", toLabel: "B" }),
      ev({ type: "ready", sessionId: "sess-1", agent: "survives" }),
    ],
  },
  {
    name: "poll settles a stuck turn",
    routes: [["GET", "^/api/sessions$", [sessionsAs("running"), sessionsAs("idle")]]],
    // 30 s: the server still says running; 60 s: idle settles the turn; 90 s:
    // nothing is running, so no fetch.
    steps: [
      ev(READY),
      ev({ type: "replay_done", hasMoreAbove: false }),
      ev(RUNNING),
      wait(20_000),
      wait(10_000),
      wait(30_000),
      wait(30_000),
      ev(RUNNING),
      wait(30_000),
    ],
  },
  {
    name: "poll for a background session",
    routes: [
      [
        "GET",
        "^/api/sessions$",
        [
          { status: 200, body: [{ id: "sess-1", status: "idle" }, { id: "sess-bg", status: "running" }] },
          { status: 200, body: [{ id: "sess-1", status: "idle" }, { id: "sess-bg", status: "running" }] },
          { status: 200, body: [{ id: "sess-1", status: "idle" }, { id: "sess-bg", status: "idle" }] },
        ],
      ],
    ],
    steps: [ev(RUNNING), wait(28_000), ev(IDLE), wait(30_000), { hidden: true, dt: 30_000 }, { hidden: false, dt: 30_000 }, wait(30_000)],
  },
  {
    name: "poll while hidden",
    steps: [ev(RUNNING), { hidden: true, dt: 30_000 }, { dt: 30_000 }, { hidden: false, dt: 30_000 }],
  },
  {
    name: "poll with nothing running",
    steps: [wait(30_000), ev(IDLE), wait(61_000)],
  },
  {
    name: "poll merges the session lists",
    routes: [
      [
        "GET",
        "^/api/sessions$",
        {
          status: 200,
          body: [
            { id: "sess-1", cwd: "/work/proj", title: null, status: "running", model: "claude-opus-4-5" },
            { id: "sess-live", cwd: "/work/other", title: "Live only", status: "idle" },
            "junk",
            { id: "" },
          ],
        },
      ],
      [
        "GET",
        "^/api/sessions/all\\?limit=25$",
        {
          status: 200,
          body: {
            accountsConfigured: 2,
            sessions: [
              { sessionId: "sess-1", cwd: "/work/proj", lastModified: NOW - 5000, claudiusTitle: "  DB title  ", customTitle: "SDK title" },
              { sessionId: "sess-old", cwd: "/work/proj", lastModified: NOW - 900000, customTitle: " Renamed ", accountId: "acc_2", accountLabel: "Work" },
              { sessionId: "sess-untitled", lastModified: NOW - 100, claudiusTitle: "   ", summary: "prompt text" },
              { sessionId: "", lastModified: NOW },
            ],
          },
        },
      ],
    ],
    steps: [ev(RUNNING), wait(30_000)],
  },
  {
    name: "poll keeps live sessions past the top 20",
    routes: [
      [
        "GET",
        "^/api/sessions$",
        {
          status: 200,
          body: [
            { id: "sess-1", status: "running" },
            { id: "s-00", status: "running" },
            { id: "s-23", status: "idle" },
            { id: "s-21", status: "idle" },
          ],
        },
      ],
      [
        "GET",
        "^/api/sessions/all\\?limit=25$",
        {
          status: 200,
          body: {
            accountsConfigured: 1,
            sessions: Array.from({ length: 24 }, (_, i) => ({
              sessionId: `s-${String(i).padStart(2, "0")}`,
              lastModified: NOW - 1000 * (i + 1),
              customTitle: i % 2 ? `T${i}` : "",
            })),
          },
        },
      ],
    ],
    steps: [ev(RUNNING), wait(30_000)],
  },
  {
    name: "poll with failing lists",
    routes: [
      [
        "GET",
        "^/api/sessions$",
        [
          { status: 500, body: { error: "down" } },
          { reject: "Failed to fetch" },
          { status: 200, text: "not json" },
          { status: 200, body: { not: "a list" } },
          { status: 200, body: "a string" },
          { status: 200, text: "\ufeff[]" },
          { status: 200, body: [{ id: "sess-1", status: "running" }, { id: "sess-x", status: "idle" }] },
        ],
      ],
      [
        "GET",
        "^/api/sessions/all\\?limit=25$",
        [
          { status: 200, body: { sessions: "nope", accountsConfigured: 3 } },
          { status: 503, text: "" },
          { status: 200, body: { sessions: [], accountsConfigured: 4 } },
          { status: 200, body: { sessions: [{ sessionId: "sess-1", lastModified: NOW }], accountsConfigured: "9" } },
          { status: 200, body: null },
          { status: 200, body: { sessions: [{ sessionId: "sess-1", lastModified: NOW }], accountsConfigured: 1.5 } },
          { status: 200, text: "nope" },
        ],
      ],
    ],
    // 1: no lists, so nothing matches; 2: both fail; 3: live isn't JSON; 4:
    // disk alone settles the turn; 5: disk is null (a throw, the list
    // stays); 6: a BOM before JSON; 7: disk isn't JSON (a throw).
    steps: [
      ev(RUNNING),
      wait(30_000),
      wait(30_000),
      wait(30_000),
      wait(30_000),
      ev(RUNNING),
      wait(29_000),
      wait(30_000),
      ev(RUNNING),
      wait(29_000),
    ],
  },
  {
    name: "poll merge throws",
    routes: [
      [
        "GET",
        "^/api/sessions/all\\?limit=25$",
        [
          { status: 200, body: { accountsConfigured: 5, sessions: [null] } },
          { status: 200, body: { accountsConfigured: 6, sessions: [{ sessionId: "s", claudiusTitle: 7 }] } },
          { status: 200, body: { accountsConfigured: 7, sessions: [{ sessionId: "s", customTitle: true }] } },
          { status: 200, body: { accountsConfigured: 8, sessions: [{ sessionId: "s", lastModified: 1 }] } },
          { status: 200, body: { accountsConfigured: 9, sessions: [{ sessionId: "s", lastModified: { toString: 1 } }, { sessionId: "t" }] } },
          { status: 200, body: { accountsConfigured: 10, sessions: [{ sessionId: "s", lastModified: { toString: 1 } }] } },
        ],
      ],
      [
        "GET",
        "^/api/sessions$",
        [
          sessionsAs("running"),
          sessionsAs("running"),
          sessionsAs("running"),
          { status: 200, body: [{ id: "sess-1", status: "running" }, null] },
          sessionsAs("running"),
          { status: 200, body: [] },
        ],
      ],
    ],
    steps: [ev(RUNNING), wait(30_000), wait(30_000), wait(30_000), wait(30_000), wait(30_000), wait(30_000)],
  },
  {
    name: "replay_done and pending prompts",
    routes: [
      [
        "GET",
        "^/api/sessions/[^/]+/pending-prompts$",
        [
          {
            status: 200,
            body: {
              asks: [{ type: "ask_user_question", requestId: "ask-1", questions: [] }],
              permissions: [
                { type: "permission_request", requestId: "perm-1", toolName: "Bash", input: { command: "ls" } },
                { type: "permission_request", requestId: "perm-2", toolName: "Edit", input: {} },
              ],
            },
          },
          { status: 200, body: { asks: [{ requestId: "ask-1", questions: ["dup"] }, { requestId: "ask-2" }], elicitations: [{ requestId: "el-1" }] } },
          { status: 404, body: { error: "gone" } },
          { status: 200, text: "nope" },
          { reject: "Failed to fetch" },
          { status: 200, body: { asks: "x", permissions: null, elicitations: {} } },
          { status: 500, body: { asks: [{ requestId: "ask-9" }] } },
        ],
      ],
    ],
    steps: [
      ev(RUNNING),
      ev({ type: "replay_done", hasMoreAbove: true }),
      ev({ type: "replay_done", hasMoreAbove: false }),
      ev({ type: "replay_done" }),
      ev({ type: "replay_done", hasMoreAbove: "yes" }),
      ev({ type: "replay_done", hasMoreAbove: false }),
      ev({ type: "replay_done", hasMoreAbove: false }),
      ev({ type: "replay_done", hasMoreAbove: true }),
    ],
  },
  // ---- U01d: the `sdk` messages that build the transcript. Shapes are
  // the SDK's (0.3.312): `SDKAssistantMessage` splits (one content block
  // each, the same `message.id`), `SDKPartialAssistantMessage` stream
  // events, `SDKResultSuccess` / `SDKResultError` and
  // `SDKPromptSuggestionMessage`, wrapped as the server broadcasts them
  // (`{ type: "sdk", message, at }`). A turn's tool results are `user`
  // messages (U01e), so these turns go straight from a tool_use to the
  // next request.
  {
    name: "unstreamed turn",
    steps: [
      ev(READY),
      ev({ type: "replay_done", hasMoreAbove: false }),
      ev(RUNNING),
      A("u-a1", M("msg_A", [{ type: "thinking", thinking: "Let me look.", signature: "sig" }]), { at: NOW + 3000 }),
      A("u-a2", M("msg_A", [{ type: "text", text: "I'll read the file." }]), { at: NOW + 3100 }),
      A("u-a3", M("msg_A", [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/work/proj/a.ts" } }]), { at: NOW + 3200 }),
      A("u-a2", M("msg_A", [{ type: "text", text: "I'll read the file." }]), { at: NOW + 3100 }),
      A("u-b1", M("msg_B", [{ type: "text", text: "The file exports one function." }], { usage: U(20, 8, { cache_read_input_tokens: 100, cache_creation_input_tokens: 40 }) }), { at: NOW + 5000 }),
      S({ type: "prompt_suggestion", suggestion: "Run the tests", uuid: "ps-1" }),
      R({ uuid: "res-1" }),
      S({ type: "prompt_suggestion", suggestion: "Commit the change", uuid: "ps-2" }),
      R({ uuid: "res-1" }),
      ev(IDLE),
      S({ type: "prompt_suggestion", suggestion: "Run the tests", uuid: "ps-3" }),
      S({ type: "prompt_suggestion", suggestion: "  \n\t", uuid: "ps-4" }),
      S({ type: "prompt_suggestion", suggestion: 5, uuid: "ps-5" }),
      S({ type: "prompt_suggestion", uuid: "ps-6" }),
      S({ type: "prompt_suggestion", suggestion: "Open a PR", uuid: "ps-7" }),
      S({ type: "prompt_suggestion", suggestion: " Write docs ", uuid: "ps-8" }),
      S({ type: "prompt_suggestion", suggestion: "Ship it", uuid: "ps-9" }),
    ],
  },
  {
    name: "streamed turn",
    steps: [
      ev(READY),
      ev({ type: "replay_done", hasMoreAbove: false }),
      ev(RUNNING),
      E("se-1", { type: "message_start", message: { id: "msg_S", type: "message", role: "assistant", model: OPUS, content: [], stop_reason: null, usage: U(12, 1) } }, { at: NOW + 4000 }),
      E("se-2", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }, { at: NOW + 4100 }),
      E("se-3", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Checking " } }),
      E("se-4", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "the tests." } }),
      E("se-5", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "abc" } }),
      E("se-6", { type: "content_block_stop", index: 0 }),
      A("u-s1", M("msg_S", [{ type: "thinking", thinking: "Checking the tests.", signature: "abc" }]), { at: NOW + 4500 }),
      E("se-7", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
      E("se-8", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "All " } }),
      E("se-8", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "All " } }),
      E("se-9", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "green." } }),
      E("se-10", { type: "content_block_stop", index: 1 }),
      A("u-s2", M("msg_S", [{ type: "text", text: "All green." }]), { at: NOW + 4700 }),
      E("se-10b", { type: "content_block_stop", index: 1 }),
      E("se-10c", { type: "content_block_delta", index: 1 }),
      E("se-11", { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_S1", name: "Grep", input: {} } }),
      E("se-12", { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"pattern": "TO' } }),
      E("se-13", { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: 'DO", "path": "src"}' } }),
      E("se-14", { type: "content_block_stop", index: 2 }),
      A("u-s3", M("msg_S", [{ type: "tool_use", id: "toolu_S1", name: "Grep", input: { pattern: "TODO", path: "src" } }]), { at: NOW + 4900 }),
      E("se-15", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 40 } }),
      E("se-16", { type: "message_stop" }),
      E("se-17", { type: "message_start", message: { id: "msg_T", type: "message", role: "assistant", model: OPUS, content: [], usage: U(30, 1) } }, { at: NOW + 9000 }),
      E("se-18", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, { at: NOW + 9100 }),
      E("se-19", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Found 3 TODOs." } }),
      E("se-20", { type: "content_block_stop", index: 0 }),
      E("se-21", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 6 } }),
      E("se-22", { type: "message_stop" }),
      A("u-t1", M("msg_T", [{ type: "text", text: "Found 3 TODOs." }], { usage: U(30, 6) }), { at: NOW + 9200 }),
      E("se-23", { type: "message_start", message: { id: "msg_S" } }),
      E("se-24", { type: "message_stop" }),
      R({ uuid: "res-S" }),
      ev(IDLE),
    ],
  },
  {
    name: "stream edge cases",
    steps: [
      ev(READY),
      ev(RUNNING),
      E("x-1", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "orphan" } }),
      E("x-2", { type: "content_block_start", index: 0, content_block: { type: "text", text: "Hi" } }, { at: NOW + 2000 }),
      E("x-2b", { type: "message_start", message: { id: "" } }),
      E("x-2", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " more" } }),
      E("", { type: "content_block_start", index: 0, content_block: { type: "text", text: "no anchor" } }),
      E("x-3", { type: "message_start", message: {} }),
      E("x-4", { type: "message_start", message: { id: "msg_E" } }, { at: NOW + 3000 }),
      E("x-4b", { type: "content_block_start", index: 9, content_block: null }, { at: NOW + 3000 }),
      E("x-5", { type: "content_block_delta", index: 7, delta: { type: "text_delta", text: "unknown index" } }),
      E("x-6", { type: "content_block_start", index: "1", content_block: { type: "text", text: "string index" } }),
      E("x-7", { type: "content_block_start", index: 1, content_block: { type: "redacted_thinking", data: "enc", thinking: "secret" } }, { at: NOW + 3100 }),
      E("x-8", { type: "content_block_start", index: 0, content_block: { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} } }),
      E("x-9", { type: "content_block_start", index: 2, content_block: { type: "thinking", thinking: "" } }),
      E("x-9b", { type: "content_block_delta", index: 2, delta: { type: "thinking_delta", thinking: "" } }, { parent: "" }),
      E("x-9c", { type: "content_block_start", index: 8, content_block: { type: "thinking", thinking: "pre-filled" } }, { parent: "" }),
      E("x-10", { type: "content_block_stop", index: 2, content_block: { type: "thinking", thinking: "Filled on stop." } }),
      E("x-11", { type: "content_block_stop", index: 2, content_block: { type: "thinking", thinking: "Not again." } }),
      E("x-11b", { type: "content_block_stop", index: 1, content_block: { type: "redacted_thinking", thinking: "no" } }),
      E("x-11c", { type: "content_block_stop", index: 1, content_block: { type: "thinking", thinking: "fills a redacted slot" } }),
      E("x-12", { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: " (a text delta)" } }),
      E("x-13", { type: "content_block_delta", index: 2, delta: { type: "thinking_delta", thinking: "" } }),
      E("x-14", { type: "content_block_delta", index: 2 }),
      E("x-15", { type: "content_block_start", index: 3, content_block: { type: "tool_use", id: "toolu_E", name: "Glob" } }),
      E("x-16", { type: "content_block_delta", index: 3, delta: { type: "input_json_delta", partial_json: "[1," } }),
      E("x-17", { type: "content_block_delta", index: 3, delta: { type: "input_json_delta", partial_json: "2]" } }),
      E("x-18", { type: "content_block_start", index: 0.5, content_block: { type: "text", text: "half" } }),
      E("x-19", { type: "content_block_start", index: 4, content_block: { type: "text" } }),
      E("x-19b", { type: "content_block_stop", index: 4, content_block: { type: "thinking", thinking: "not a thinking slot" } }),
      E("x-20", { type: "content_block_delta", index: 4, delta: { type: "text_delta", text: 42 } }),
      E("x-20b", { type: "content_block_delta", index: 4, delta: { type: "text_delta", text: 0 } }),
      E("x-21", { type: "content_block_delta", index: 4, delta: { type: "input_json_delta", partial_json: "{}" } }),
      E("x-22", { type: "content_block_start", index: 5, content_block: { type: "tool_use", id: "toolu_F", name: "Read" } }),
      E("x-23", { type: "content_block_delta", index: 5, delta: { type: "input_json_delta", partial_json: '"just a string"' } }),
      E("x-24", { type: "content_block_start", index: 6, content_block: { type: "text", text: `lone ${LONE_HI}` } }),
      E("x-25", { type: "content_block_delta", index: 6, delta: { type: "text_delta", text: String.fromCharCode(0xde00) } }),
      E("x-26", { type: "ping" }),
      E("x-27", { type: "message_stop" }, { parent: "toolu_none" }),
      E("x-28", { type: "message_stop" }),
      E("x-29", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "after stop" } }),
      E("x-29b", { type: "content_block_start", index: 0, content_block: { type: "text", text: "a new anchor after the stop" } }, { at: NOW + 30000 }),
      E("x-30", { type: "message_stop" }),
      S({ type: "stream_event", uuid: "x-31" }),
      S({ type: "stream_event", uuid: "x-32", event: null }),
      S({ type: "stream_event", uuid: "x-33", event: 5 }),
      E("y-1", { type: "message_start", message: { id: "msg_CROSS" } }, { parent: "toolu_Z" }),
      E("y-2", { type: "content_block_start", index: 0, content_block: { type: "text", text: "sub" } }, { parent: "toolu_Z", at: NOW + 40000 }),
      A("y-3", M("msg_CROSS", [{ type: "text", text: "main terminal" }]), { at: NOW + 40100 }),
      E("y-4", { type: "message_start", message: { id: "msg_CROSS2" } }),
      E("y-5", { type: "content_block_start", index: 0, content_block: { type: "text", text: "main" } }, { at: NOW + 40200 }),
      A("y-6", M("msg_CROSS2", [{ type: "text", text: "sub terminal" }]), { parent: "toolu_Q", at: NOW + 40300 }),
      R({ uuid: "res-E" }),
    ],
  },
  {
    name: "interleaved subagent output",
    steps: [
      ev(READY),
      ev({ type: "replay_done", hasMoreAbove: false }),
      ev(RUNNING),
      A("m-1", M("msg_M", [{ type: "text", text: "Spawning two agents." }]), { at: NOW + 3000 }),
      A("m-2", M("msg_M", [{ type: "tool_use", id: "toolu_A", name: "Task", input: { description: "Search A", prompt: "find a", subagent_type: "Explore" } }]), { at: NOW + 3000 }),
      A("m-3", M("msg_M", [{ type: "tool_use", id: "toolu_B", name: "Agent", input: { description: "Search B", prompt: "find b", subagent_type: "general-purpose" } }]), { at: NOW + 3000 }),
      E("sa-1", { type: "message_start", message: { id: "msg_SA", model: "claude-haiku-4-5", usage: U(30, 1) } }, { parent: "toolu_A", at: NOW + 4000 }),
      E("sb-1", { type: "message_start", message: { id: "msg_SB", model: "claude-sonnet-4-5", usage: U(40, 1) } }, { parent: "toolu_B", at: NOW + 4100 }),
      E("sa-2", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, { parent: "toolu_A", at: NOW + 4200 }),
      E("sb-2", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }, { parent: "toolu_B", at: NOW + 4300 }),
      E("sa-3", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Looking in a/" } }, { parent: "toolu_A" }),
      E("sb-3", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Hmm" } }, { parent: "toolu_B" }),
      E("sa-4", { type: "content_block_stop", index: 0 }, { parent: "toolu_A" }),
      A("sa-t1", M("msg_SA", [{ type: "text", text: "Looking in a/" }], { model: "claude-haiku-4-5", usage: U(30, 4) }), { parent: "toolu_A", at: NOW + 4400 }),
      E("sa-5", { type: "message_stop" }, { parent: "toolu_A" }),
      A("sb-t1", M("msg_SB", [{ type: "thinking", thinking: "Hmm" }], { model: "claude-sonnet-4-5", usage: U(40, 3) }), { parent: "toolu_B", at: NOW + 4500 }),
      A("sb-t2", M("msg_SB", [{ type: "tool_use", id: "toolu_B1", name: "Grep", input: { pattern: "b" } }], { model: "claude-sonnet-4-5", usage: U(40, 3) }), { parent: "toolu_B", at: NOW + 4500 }),
      E("sb-4", { type: "message_stop" }, { parent: "toolu_B" }),
      A("sc-1", M("msg_SC", [{ type: "text", text: "Unstreamed subagent reply." }], { model: "claude-haiku-4-5" }), { parent: "toolu_A", at: NOW + 6000 }),
      A("sc-2", M("msg_SC", [{ type: "text", text: "cut sh" }], { model: "claude-haiku-4-5" }), { parent: "toolu_A", at: NOW + 6000, extra: { aborted: true } }),
      A("sa-t1", M("msg_SA", [{ type: "text", text: "Looking in a/" }], { model: "claude-haiku-4-5", usage: U(30, 4) }), { parent: "toolu_A", at: NOW + 4400 }),
      A("sd-1", M("msg_SD", [{ type: "text", text: "Index-keyed parent." }]), { parent: "42", at: NOW + 6100 }),
      A("se-1", M("msg_SE", [{ type: "tool_use", id: "toolu_E1", name: "Read", input: { file_path: "e" } }]), { parent: "", at: NOW + 6200 }),
      E("m-4", { type: "message_start", message: { id: "msg_N", model: OPUS } }, { at: NOW + 7000 }),
      E("m-5", { type: "content_block_start", index: 0, content_block: { type: "text", text: "Both agents finished." } }, { at: NOW + 7100 }),
      E("m-6", { type: "message_stop" }),
      A("m-7", M("msg_N", [{ type: "text", text: "Both agents finished." }]), { at: NOW + 7200 }),
      R({ uuid: "res-D" }),
    ],
  },
  {
    name: "aborted and errored turns",
    steps: [
      ev(READY),
      ev({ type: "replay_done", hasMoreAbove: false }),
      ev(RUNNING),
      E("ab-1", { type: "message_start", message: { id: "msg_X" } }, { at: NOW + 3000 }),
      E("ab-2", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, { at: NOW + 3100 }),
      E("ab-3", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Halfway thr" } }),
      A("ab-4", M("msg_X", [{ type: "text", text: "Halfway thr" }]), { at: NOW + 3200, extra: { aborted: true } }),
      R({ subtype: "error_during_execution", is_error: true, uuid: "res-X1", errors: ["Request was aborted."] }),
      ev(RUNNING),
      A("e-1", M("msg_Y", [{ type: "text", text: "API Error: 500 Internal server error" }]), { at: NOW + 9000, extra: { error: "server_error" } }),
      A("e-2", M("msg_Y", [{ type: "text", text: "Retrying did not help." }]), { at: NOW + 9000 }),
      A("e-3", M("msg_Y", [{ type: "text", text: "Late split." }]), { at: NOW + 9000, extra: { error: "overloaded", aborted: false } }),
      R({ subtype: "error_during_execution", is_error: true, uuid: "res-X2" }),
      R({ subtype: "error_max_turns", is_error: true, uuid: "res-X3", num_turns: 10 }),
      R({ subtype: "error_max_budget_usd", is_error: true, total_cost_usd: 0.125, uuid: "res-X4" }),
      R({ subtype: "error_max_budget_usd", is_error: true, total_cost_usd: 12.3456, uuid: "res-X5" }),
      R({ subtype: "error_max_budget_usd", is_error: true, total_cost_usd: "3", uuid: "res-X6" }),
      R({ subtype: "error_max_budget_usd", is_error: true, total_cost_usd: 2.675 }),
      R({ subtype: "error_max_budget_usd", is_error: true, total_cost_usd: 1e21, uuid: "res-X7" }),
      R({ subtype: "error_max_budget_usd", is_error: true, total_cost_usd: 0.125, uuid: "res-X4" }),
      R({ subtype: "error_during_execution", is_error: true, startup_failure_reason: "org_pin_api_key_conflict", errors: ["ANTHROPIC_API_KEY is set"], total_cost_usd: 0, uuid: "res-X8" }),
      R({ subtype: "error_during_execution", is_error: true, startup_failure_reason: "brand_new_reason", errors: [], uuid: "res-X9" }),
      R({ subtype: "error_during_execution", is_error: true, startup_failure_reason: "temp_dir_unusable", errors: [null, "second"], uuid: "res-X10" }),
      R({ startup_failure_reason: "", uuid: "res-X11" }),
      R({ resume_reason: "host_draining", uuid: "res-X12" }),
      R({ resume_reason: "interrupted_turn" }),
      R({ resume_reason: "some_new_reason", uuid: "res-X13" }),
      R({ resume_reason: "", uuid: "res-X14" }),
      E("ab-9", { type: "message_start", message: { id: "msg_Z" } }),
      E("ab-10", { type: "content_block_start", index: 0, content_block: { type: "text", text: "z" } }, { at: NOW + 40000 }),
      R({ resume_reason: "checkpoint_restore", uuid: "res-X15" }),
      R({ resume_reason: "host_draining", uuid: "" }),
    ],
  },
  {
    name: "rate-limit, high-demand and model-unavailable texts",
    steps: [
      ev({ ...READY, fallbackModel: "claude-sonnet-4-5" }),
      ev({ type: "replay_done", hasMoreAbove: false }),
      ev(RUNNING),
      A("r-1", M("msg_R1", [{ type: "text", text: "You've hit your session limit \u00b7 resets 3pm (America/New_York)" }]), { at: NOW + 2000, extra: { error: "rate_limit" } }),
      R({ uuid: "res-R1", subtype: "success", is_error: true }),
      A("r-2", M("msg_R2", [{ type: "text", text: "You\u2019ve hit your weekly limit \u00b7 resets Mon 9am" }]), { at: NOW + 3000 }),
      A("r-3", M("msg_R3", [{ type: "text", text: "You've reached your Opus limit \u00b7 resets 5pm" }]), { at: NOW + 4000, extra: { error: "rate_limit" } }),
      A("r-4", M("msg_R4", [{ type: "text", text: "We're experiencing high demand for Opus 4. Switch with /model." }]), { at: NOW + 5000 }),
      A("r-5", M("msg_R5", [{ type: "text", text: "There's an issue with the selected model (claude-fable-5). It may not exist or you may not have access to it." }]), { at: NOW + 6000, extra: { error: "model_not_found" } }),
      A("r-6", M("msg_R6", [{ type: "text", text: "The model claude-fable-5 is not available on your bedrock deployment." }]), { at: NOW + 7000 }),
      A("r-7", M("msg_R7", [{ type: "text", text: "There's an issue with the selected model (claude-opus-9)." }]), { at: NOW + 8000, extra: { error: "model_not_found" } }),
      A("r-8", M("msg_R8", [{ type: "text", text: "You've hit your limit" }, { type: "tool_use", id: "toolu_R", name: "Read", input: { file_path: "x" } }]), { at: NOW + 9000 }),
      A("r-9", M("msg_R9", [{ type: "text", text: "Credit balance too low." }]), { at: NOW + 10000, extra: { error: "billing_error" } }),
      A("r-10", M("msg_R1", [{ type: "text", text: "Resets soon." }]), { at: NOW + 2000 }),
      A("r-11", M("msg_R4", [{ type: "text", text: "Still busy." }]), { at: NOW + 5000, extra: { error: "" } }),
      A("r-12", M("msg_R12", [{ type: "text", text: "  you've HIT your usage limit" }]), { at: NOW + 11000, extra: { error: "rate_limit" } }),
      A("r-13", M("msg_R13", [{ type: "text", text: "Limit reached." }]), { at: NOW + 12000, extra: { error: "rate_limit" } }),
      R({ uuid: "res-R2" }),
    ],
  },
  {
    name: "result without an assistant message, and fast mode",
    steps: [
      R({ uuid: "g-1", fast_mode_state: "on" }),
      R({ uuid: "g-2", fast_mode_state: "cooldown", fast_mode_disabled_reason: "rate_limit" }),
      ev(READY),
      ev({ type: "replay_done", hasMoreAbove: false }),
      R({ uuid: "g-3", fast_mode_state: "on", fast_mode_disabled_reason: "stale" }),
      R({ uuid: "g-4", fast_mode_state: "cooldown", fast_mode_disabled_reason: "overloaded" }),
      R({ uuid: "g-5", fast_mode_state: "cooldown" }),
      R({ uuid: "g-6", fast_mode_state: "off", fast_mode_disabled_reason: "free_tier" }),
      R({ uuid: "g-7", fast_mode_state: "cooldown", fast_mode_disabled_reason: null }),
      R({ uuid: "g-8", fast_mode_state: "" }),
      R({ fast_mode_state: "on" }),
      R({ uuid: "g-9", fast_mode_state: "cooldown", resume_reason: "container_recreated" }),
      R({ uuid: "g-9", fast_mode_state: "on" }),
      R({ uuid: "g-10", fast_mode_state: "off" }),
      R({ uuid: "g-11", fast_mode_state: "on" }),
    ],
  },
  {
    name: "fast mode first seen after the replay",
    steps: [ev(READY), ev({ type: "replay_done", hasMoreAbove: false }), R({ uuid: "f-1", fast_mode_state: "cooldown", fast_mode_disabled_reason: "rate_limit" }), R({ uuid: "f-2", fast_mode_state: "on" })],
  },
  {
    name: "odd sdk payloads",
    steps: [
      ev(READY),
      ev({ type: "sdk" }),
      ev({ type: "sdk", message: null }),
      ev({ type: "sdk", message: 5 }),
      ev({ type: "sdk", message: { type: "assistant", uuid: "h-0" } }),
      ev({ type: "sdk", message: { type: "assistant", uuid: "h-1", message: null } }),
      A("h-1b", { id: "msg_H1b", content: "no usage yet", usage: null }, { at: NOW + 1500 }),
      A("h-2", { id: 7, content: "plain string content", usage: { input_tokens: 3 } }, { at: NOW + 2000 }),
      A("h-3", { id: "msg_H3", content: [null], usage: U(4, 2) }, { at: NOW + 3000 }),
      A("h-4", { id: "msg_H4", content: [] }, { at: NOW + 4000 }),
      A("h-5", { id: "msg_H5", content: [{ type: "text" }, { type: "image", source: {} }, { type: "text", text: "" }] }, { at: NOW + 5000 }),
      A("h-6", { id: "msg_H6", content: [{ type: "tool_use", id: "toolu_H", name: "Read", input: null }] }),
      A("h-7", { id: "msg_H6", content: [{ type: "tool_use", id: "toolu_H", name: "Read", input: null }] }),
      A("h-8", { id: "", content: [{ type: "redacted_thinking", data: "x" }, { type: "thinking", thinking: "" }] }, { at: NOW + 8000 }),
      A("h-9", { id: "msg_H9", content: "x", usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: null, cache_creation_input_tokens: null } }, { at: NOW + 9000 }),
      A("h-10", { id: "msg_H10", content: "y", usage: {} }, { at: NOW + 9000 }),
      A("h-11", { id: "msg_H11", content: "z", usage: null }, { at: NOW + 9000 }),
      S({ type: "brand_new_message" }),
      S({ type: "prompt_suggestion" }),
      S({ type: 7 }),
    ],
  },
  {
    name: "usage across models",
    steps: [
      ev(READY),
      ev(RUNNING),
      A("v-1", M("msg_V1", [{ type: "text", text: "a" }], { model: "claude-opus-4-5", usage: U(1000, 500, { cache_read_input_tokens: 2000, cache_creation_input_tokens: 300 }) }), { at: NOW + 2000 }),
      A("v-2", M("msg_V1", [{ type: "text", text: "b" }], { model: "claude-opus-4-5", usage: U(1000, 500) }), { at: NOW + 2000 }),
      A("v-3", M("msg_V2", [{ type: "text", text: "c" }], { model: "claude-sonnet-4-5", usage: U(10, 20) }), { at: NOW + 3000 }),
      A("v-4", M("msg_V3", [{ type: "text", text: "d" }], { model: "claude-haiku-4-5", usage: U(7, 3) }), { at: NOW + 4000 }),
      A("v-5", M("msg_V4", [{ type: "text", text: "e" }], { model: "fake", usage: U(1, 1) }), { at: NOW + 5000 }),
      A("v-6", M("msg_V5", [{ type: "text", text: "f" }], { model: undefined, usage: U(3, 3) }), { at: NOW + 6000 }),
      A("v-7", M("msg_V6", [{ type: "text", text: "g" }], { model: null, usage: U(3, 3) }), { at: NOW + 7000 }),
      A("v-8", M("msg_V7", [{ type: "text", text: "sub" }], { model: "claude-haiku-4-5", usage: U(50, 50) }), { parent: "toolu_V", at: NOW + 8000 }),
      R({ uuid: "res-V", usage: U(2000, 1000), total_cost_usd: 0.5 }),
    ],
  },
  {
    name: "message_stop closes only its own rows",
    steps: [
      ev(READY),
      E("p-1", { type: "message_start", message: { id: "msg_P1" } }),
      E("p-2", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }, { at: NOW + 2000 }),
      E("p-3", { type: "message_start", message: { id: "msg_P2" } }),
      E("p-4", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }, { at: NOW + 4000 }),
      A("p-5", M("msg_P3", [{ type: "tool_use", id: "thinking:msg_P2:7", name: "Read", input: {} }]), { at: NOW + 5000 }),
      E("p-6", { type: "message_stop" }),
      E("p-7", { type: "message_start", message: { id: "msg_P1" } }),
      E("p-8", { type: "message_stop" }),
      E("p-9", { type: "message_start", message: { id: "msg_P2" } }),
      E("p-10", { type: "message_stop" }),
    ],
  },
  {
    name: "the tool rail keeps 100 rows",
    steps: [
      ev(READY),
      A(
        "cap-1",
        M("msg_CAP", [
          { type: "thinking", thinking: "plan" },
          ...Array.from({ length: 101 }, (_, i) => ({ type: "tool_use", id: `toolu_c${i}`, name: "Glob", input: { pattern: `*.${i}` } })),
        ]),
        { at: NOW + 2000 },
      ),
      A("cap-2", M("msg_CAP2", [{ type: "tool_use", id: "toolu_c0", name: "Glob", input: { pattern: "again" } }]), { at: NOW + 3000 }),
      E("cap-3", { type: "message_start", message: { id: "msg_CAP3" } }),
      E("cap-4", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }, { at: NOW + 4000 }),
      E("cap-5", { type: "message_stop" }),
    ],
  },
];

// ---- U01f: permissions and prompts (`prompts-` scenarios) ----

const toolu = (id) => `toolu_${id}`;
const PERM = (id, extra = {}) => ({
  type: "permission_request",
  requestId: id,
  toolName: "Bash",
  toolUseId: toolu(id),
  input: { command: "ls" },
  suggestedRules: [{ toolName: "Bash", ruleContent: "ls:*" }],
  ...extra,
});
const ASK = (id, extra = {}) => ({
  type: "ask_user_question",
  requestId: id,
  toolUseId: toolu(id),
  questions: [
    {
      question: "Which database?",
      header: "DB",
      options: [
        { label: "Postgres", description: "" },
        { label: "SQLite", description: "local" },
      ],
      multiSelect: false,
    },
  ],
  ...extra,
});
const ELICIT = (id, extra = {}) => ({
  type: "mcp_elicitation_request",
  requestId: id,
  serverName: "linear",
  message: "Pick a team",
  mode: "form",
  requestedSchema: { type: "object", properties: { team: { type: "string" } } },
  ...extra,
});
const PLAN = (id, extra = {}) => ({
  type: "plan_approval_request",
  requestId: id,
  toolUseId: toolu(id),
  plan: "1. Read the code\n2. Fix the bug",
  ...extra,
});
const SETTLED = (kind, id) => ({ type: "prompt_settled", kind, requestId: id });
const ANSWER_PATHS = "(permission|elicitation|ask-answer|plan|mode)";
const answerRoute = (path, spec) => ["POST", `^/api/sessions/[^/]+/${path}$`, spec];
const OK_ANSWERS = [answerRoute(ANSWER_PATHS, { status: 200, body: { ok: true } })];
const FAILING_REPLIES = [
  { status: 200, body: { ok: true } },
  { status: 500, body: { error: "boom" } },
  { reject: "Failed to fetch" },
  { status: 200, text: "not json" },
  { status: 404, body: { error: "No pending request" } },
];

scenarios.push(
  {
    name: "prompts-each kind arriving",
    steps: [
      ev(PERM("perm-1")),
      ev(PERM("perm-2", { toolName: "Edit", input: { file_path: "/work/proj/a.ts" }, agentId: "agent-7", defaultToNo: true })),
      ev(ASK("ask-1")),
      ev(ELICIT("el-1")),
      ev(ELICIT("el-2", { mode: "url", url: "https://linear.app/oauth", elicitationId: "eid-2", requestedSchema: undefined })),
      ev(PLAN("plan-1", { raw: { plan: "1. Read the code" } })),
      ev(PERM("perm-1", { input: { command: "ls -la" } })),
      ev(ASK("ask-1", { questions: [] })),
      ev(ASK("ask-2")),
      ev(PLAN("plan-2")),
      ev({ type: "turn_status", status: "needs_input" }),
    ],
  },
  {
    name: "prompts-before ready and during replay",
    routes: [
      [
        "GET",
        "^/api/sessions/[^/]+/pending-prompts$",
        {
          status: 200,
          body: {
            asks: [ASK("ask-1", { questions: ["server copy"] }), ASK("ask-2")],
            permissions: [PERM("perm-1", { input: { command: "server copy" } }), PERM("perm-3")],
            elicitations: [ELICIT("el-1")],
          },
        },
      ],
    ],
    steps: [
      ev(PERM("perm-1")),
      ev(PLAN("plan-1")),
      ev(READY),
      ev(ASK("ask-1")),
      ev(PERM("perm-1", { input: { command: "re-emit" } })),
      ev(SETTLED("elicitation", "el-1")),
      ev({ type: "replay_done", hasMoreAbove: false }),
      ev(PERM("perm-4")),
    ],
  },
  {
    name: "prompts-settled",
    routes: [
      [
        "GET",
        "^/api/sessions/[^/]+/pending-prompts$",
        { status: 200, body: { permissions: [PERM("perm-1"), PERM("perm-2"), PERM("perm-5")], asks: [ASK("shared")] } },
      ],
      ...OK_ANSWERS,
    ],
    steps: [
      ev(PERM("perm-1")),
      ev(PERM("perm-2")),
      ev(ASK("ask-1")),
      ev(ELICIT("el-1")),
      ev(PLAN("plan-1")),
      ev(SETTLED("permission", "perm-1")),
      ev(SETTLED("permission", "perm-unknown")),
      ev(SETTLED("ask", "ask-1")),
      ev(SETTLED("elicitation", "el-1")),
      ev(SETTLED("elicitation", "el-1")),
      ev(SETTLED("plan", "plan-1")),
      ev(SETTLED("PERMISSION", "perm-2")),
      ev(PERM("perm-2", { input: { command: "re-emit" } })),
      ev(PERM("perm-1")),
      ev(PERM("shared")),
      ev(ASK("shared")),
      ev(SETTLED("ask", "shared")),
      ev(ELICIT("shared")),
      ev({ type: "replay_done", hasMoreAbove: false }),
      call("resolvePermission", "perm-1", { kind: "allow_once" }),
      call("resolvePermission", "shared", { kind: "deny" }),
    ],
  },
  {
    name: "prompts-resolvePermission",
    routes: [answerRoute("permission", FAILING_REPLIES)],
    steps: [
      ev(PERM("perm-1")),
      ev(PERM("perm-2")),
      ev(PERM("perm-3")),
      ev(PERM("perm-4")),
      call("resolvePermission", "perm-2", { kind: "allow_once" }),
      call("resolvePermission", "perm-1", { kind: "allow_always_save", destination: "projectSettings" }),
      call("resolvePermission", "perm-3", { kind: "deny", message: `not that ${LONE_HI} one` }),
      call("resolvePermission", "perm-4", { kind: "allow_always_session" }),
      call("resolvePermission", "perm-4", { kind: "allow_once" }),
      ev(PERM("perm-3")),
      call("resolvePermission", "perm-unknown", { kind: "deny" }),
    ],
  },
  {
    name: "prompts-resolveElicitation",
    routes: [answerRoute("elicitation", FAILING_REPLIES)],
    steps: [
      ev(ELICIT("el-1")),
      ev(ELICIT("el-2", { mode: "url", url: "https://example.com/auth" })),
      ev(ELICIT("el-3")),
      call("resolveElicitation", "el-1", { action: "accept", content: { team: "core", count: 2, ok: true, tags: ["a"] } }),
      call("resolveElicitation", "el-2", { action: "decline" }),
      call("resolveElicitation", "el-3", { action: "cancel" }),
      call("resolveElicitation", "el-3", { action: "cancel" }),
      ev(SETTLED("elicitation", "el-9")),
      call("resolveElicitation", "el-9", { action: "accept" }),
    ],
  },
  {
    name: "prompts-submitAskAnswer",
    routes: [answerRoute("ask-answer", FAILING_REPLIES)],
    steps: [
      ev(ASK("ask-1")),
      ev(ASK("ask-2")),
      ev(ASK("ask-3")),
      call("submitAskAnswer", "ask-2", [{ label: "Postgres" }]),
      call("submitAskAnswer", "ask-1", [{ selected: ["a", "b"] }, { label: null, custom: "Other text" }]),
      call("submitAskAnswer", "ask-3", []),
      call("submitAskAnswer", "ask-3", [{ label: "SQLite" }]),
      ev(ASK("ask-1")),
      call("submitAskAnswer", "ask-unknown", [{ custom: `caf${String.fromCharCode(0xe9)}` }]),
    ],
  },
  {
    name: "prompts-resolvePlan",
    routes: [answerRoute("plan", FAILING_REPLIES)],
    steps: [
      call("resolvePlan", { kind: "accept" }),
      ev(PLAN("plan-1", { raw: { plan: "x", extra: [1, null] } })),
      ev(PLAN("plan-2")),
      call("resolvePlan", { kind: "accept", editedPlan: "1. Edited" }),
      call("resolvePlan", { kind: "accept" }),
      ev(PLAN("plan-3")),
      call("resolvePlan", { kind: "reject", message: "Not yet" }),
      ev(PLAN("plan-4")),
      call("resolvePlan", { kind: "reject" }),
      ev(PLAN("plan-5")),
      call("resolvePlan", { kind: "accept" }),
      ev(PLAN("plan-6")),
      call("resolvePlan", { kind: "accept" }),
      ev(PLAN("plan-7")),
      call("resolvePlan", { kind: "accept" }),
    ],
  },
  {
    name: "prompts-setPermissionMode",
    routes: [answerRoute("mode", FAILING_REPLIES)],
    steps: [
      call("setPermissionMode", "plan"),
      call("setPermissionMode", "acceptEdits"),
      call("setPermissionMode", "bypassPermissions"),
      call("setPermissionMode", "plan"),
      ev({ type: "mode_changed", mode: "default" }),
      call("setPermissionMode", "auto"),
      call("setPermissionMode", "auto"),
    ],
  },
  {
    name: "prompts-odd payloads",
    routes: OK_ANSWERS,
    steps: [
      ev({ type: "permission_request" }),
      ev({ type: "permission_request", toolName: 5, input: null }),
      ev({ type: "ask_user_question", requestId: 7, questions: "nope" }),
      ev({ type: "ask_user_question", requestId: 7, questions: null }),
      ev({ type: "mcp_elicitation_request", requestId: null, mode: 5 }),
      ev({ type: "mcp_elicitation_request", requestId: "el-1", serverName: null, message: { text: "x" } }),
      ev({ type: "prompt_settled", kind: null, requestId: "el-1" }),
      ev({ type: "prompt_settled", kind: 5, requestId: "nothing" }),
      ev({ type: "prompt_settled", kind: "ask", requestId: 7 }),
      ev({ type: "permission_request", requestId: "perm-ok", toolName: "Read" }),
      ev({ type: "prompt_settled", kind: "permission" }),
      ev({ type: "plan_approval_request" }),
      ev({ type: "plan_approval_request", requestId: 5, plan: null, raw: 0 }),
      call("resolvePlan", { kind: "reject", message: "odd" }),
      ev({ type: "plan_approval_request", requestId: "plan-a", toolUseId: null, raw: [] }),
      ev({ type: "plan_approval_request", requestId: "plan-b", plan: 42, raw: "" }),
      ev({ type: "plan_approval_request", requestId: "plan-c", raw: "x" }),
      ev({ type: "plan_approval_request", requestId: "plan-d", raw: {} }),
      ev({ type: "plan_approval_request", requestId: "plan-e", raw: null, extra: true }),
      call("resolvePlan", { kind: "accept" }),
      ev({ type: "plan_approval_request", toolUseId: "t" }),
      call("resolvePlan", { kind: "accept" }),
    ],
  },
);

// ---- U01i: status, usage and mode (`status-` scenarios) ----

scenarios.push(
  {
    name: "status-usage snapshot",
    steps: [
      ev(READY),
      ev({
        type: "usage_snapshot",
        usage: {
          totalCostUsd: 0.5,
          numTurns: 3,
          durationMs: 9000,
          durationApiMs: 8000,
          inputTokens: 100,
          outputTokens: 50,
          cacheReadInputTokens: 10,
          cacheCreationInputTokens: 5,
          modelUsage: { [OPUS]: { inputTokens: 100, outputTokens: 50, costUSD: 0.5 } },
        },
      }),
      ev({ type: "replay_done", hasMoreAbove: false }),
      A("us-1", M("msg_US1", [{ type: "text", text: "hi" }]), { at: NOW + 3000 }),
      R({ uuid: "us-res-1" }),
      ev({ type: "usage_snapshot", usage: { totalCostUsd: 0.75, numTurns: 4, inputTokens: 120 } }),
      A("us-2", M("msg_US2", [{ type: "text", text: "on top" }]), { at: NOW + 6000 }),
      ev({ type: "usage_snapshot" }),
      ev({ type: "usage_snapshot", usage: null }),
      ev({ type: "usage_snapshot", usage: 7 }),
      ev({ type: "usage_snapshot", usage: true }),
      ev({ type: "usage_snapshot", usage: "a" + String.fromCodePoint(0x1f600) }),
      ev({ type: "usage_snapshot", usage: [5, { x: 1 }] }),
      raw('{"type":"usage_snapshot","usage":{"b":1,"2":2,"1":3,"a":{"n":null}}}'),
      ev({ type: "usage_snapshot", usage: {} }),
      A("us-3", M("msg_US3", [{ type: "text", text: "from empty" }]), { at: NOW + 14000 }),
    ],
  },
  {
    name: "status-plan usage",
    steps: [
      ev({ type: "plan_usage_unavailable" }),
      ev(READY),
      ev({
        type: "plan_usage",
        subscriptionType: "max",
        rateLimitsAvailable: true,
        rateLimits: {
          fiveHour: { utilization: 12.5, resetsAt: "2025-11-16T15:00:00Z" },
          sevenDay: { utilization: 40, resetsAt: null },
          sevenDayOpus: null,
        },
        modelScoped: [{ model: "Opus", utilization: 3 }],
        spendLimit: { usedUsd: 5, limitUsd: 20 },
        extraUsage: { isEnabled: true, usedCredits: 12 },
        fetchedAt: NOW + 2000,
      }),
      ev({ type: "plan_usage_unavailable" }),
      ev({ type: "plan_usage_unavailable", reason: "ignored" }),
      ev({ type: "plan_usage", subscriptionType: "pro", rateLimitsAvailable: false, fetchedAt: NOW + 5000 }),
      A("pu-1", M("msg_PU1", [{ type: "text", text: "You've hit your session limit \u00b7 resets 3pm (America/New_York)" }]), { at: NOW + 6000, extra: { error: "rate_limit" } }),
      ev({ type: "plan_usage" }),
      ev({ type: "plan_usage_unavailable" }),
      ev({
        type: "plan_usage",
        subscriptionType: null,
        rateLimitsAvailable: "yes",
        rateLimits: null,
        modelScoped: 0,
        spendLimit: "",
        extraUsage: null,
        fetchedAt: "later",
      }),
      A("pu-2", M("msg_PU2", [{ type: "text", text: "Limit reached." }]), { at: NOW + 10000, extra: { error: "rate_limit" } }),
      ev({ type: "plan_usage", subscriptionType: 5, rateLimits: [], modelScoped: "x", spendLimit: 1, extraUsage: {}, fetchedAt: null }),
    ],
  },
  {
    name: "status-set model",
    routes: [
      [
        "POST",
        "^/api/sessions/[^/]+/model$",
        [
          { status: 200, body: { ok: true } },
          { status: 409, body: { error: "Model claude-fable-9 is not available", model: "claude-sonnet-4-5" } },
          { status: 409, body: { model: 5 } },
          { status: 500, text: "upstream exploded" },
          { status: 409, text: "null" },
          { reject: "Failed to fetch" },
          { status: 400, body: { error: null, model: null } },
          { status: 422, body: { error: 7, model: "" } },
          { status: 409, body: "just text" },
          { status: 409, text: "\ufeff{\"error\":\"bom\",\"model\":\"m\"}" },
          { status: 204, text: "" },
        ],
      ],
    ],
    steps: [
      ev(READY),
      call("setModel", "claude-opus-4-5"),
      call("setModel", "claude-fable-9", "chat_command"),
      call("setModel", "claude-x"),
      call("setModel", null),
      call("setModel", "claude-y", "picker"),
      call("setModel", "claude-z"),
      call("setModel", "claude-w"),
      call("setModel", "caf\u00e9"),
      call("setModel", "claude-v"),
      call("setModel", "claude-u"),
      call("setModel", "claude-t"),
      A("sm-1", M("msg_SM1", [{ type: "text", text: "priced" }], { model: "claude-unknown" }), { at: NOW + 13000 }),
      call("setModel", "claude-opus-4-5"),
      // No `message.model`: priced on the picked model (the model ref).
      A("sm-2", M("msg_SM2", [{ type: "text", text: "priced by the pick" }], { model: undefined }), { at: NOW + 15000 }),
    ],
  },
  {
    name: "status-set effort",
    routes: [["POST", "^/api/sessions/[^/]+/effort$", [{ status: 200, body: { ok: true } }, { reject: "Failed to fetch" }, { status: 500, body: { error: "no" } }, { status: 200, body: { ok: true } }]]],
    steps: [
      ev(READY),
      ev({ type: "replay_done", hasMoreAbove: false }),
      call("setEffort", "high"),
      A("se-1", M("msg_SE1", [{ type: "text", text: "working" }]), { at: NOW + 4000 }),
      call("setEffort", "low"),
      call("setEffort", "max", { sessionOnly: true }),
      call("setEffort", "high"),
      call("setEffort", "medium", {}),
      E("se-2", { type: "message_start", message: { id: "msg_SE2" } }),
      call("setUltracode", true),
      call("setEffort", "xhigh", { sessionOnly: false }),
      R({ uuid: "se-res-1" }),
      call("setEffort", "auto"),
      A("se-3", M("msg_SE3", [{ type: "text", text: "again" }]), { at: NOW + 13000 }),
      call("setEffort", "auto"),
      call("setEffort", "low"),
      ev(IDLE),
    ],
  },
  {
    name: "status-ultracode, fast and advisor",
    routes: [
      ["POST", "^/api/sessions/[^/]+/ultracode$", [{ status: 200, body: { ok: true } }, { status: 500, body: { error: "no" } }]],
      ["POST", "^/api/sessions/[^/]+/fast$", [{ status: 200, body: { ok: true } }, { reject: "Failed to fetch" }]],
      ["POST", "^/api/sessions/[^/]+/advisor$", [{ status: 200, body: { ok: true } }, { status: 409, body: { error: "no advisor" } }]],
    ],
    steps: [
      ev(READY),
      call("setUltracode", true),
      call("setUltracode", false),
      call("setFast", true),
      call("setFast", false),
      call("setAdvisorModel", "claude-opus-4-5"),
      call("setAdvisorModel", null),
      call("reEnableAdvisor", "claude-sonnet-4-5"),
      call("setEffort", "high"),
      call("setUltracode", true),
    ],
  },
  {
    name: "status-set agent",
    routes: [["POST", "^/api/sessions/[^/]+/agent$", [{ status: 200, body: { ok: true } }, { reject: "Failed to fetch" }, { status: 404, body: { error: "unknown agent" } }]]],
    steps: [
      ev(READY),
      call("setAgent", "reviewer"),
      ev({ type: "agent_changed", agent: "planner" }),
      call("setAgent", null),
      call("setAgent", "caf\u00e9 agent"),
      ev({ type: "agent_changed" }),
    ],
  },
  {
    name: "status-dismiss notices",
    routes: [["POST", "^/api/sessions/[^/]+/model$", { status: 409, body: { error: "nope", model: "claude-sonnet-4-5" } }]],
    steps: [
      ev(READY),
      ev({ type: "replay_done", hasMoreAbove: false }),
      ev({ type: "feedback_survey", sessionId: "sess-1", surface: "post_turn" }),
      ev({ type: "opus_overload_nudge", model: "claude-opus-4-5", count: 2 }),
      ev({ type: "long_context_credits_required", model: "claude-sonnet-4-5[1m]" }),
      ev({ type: "auth_failed_required", model: "claude-opus-4-5", reason: "oauth_revoked" }),
      ev({ type: "token_expiring_required", expiresAt: NOW + 3_600_000 }),
      R({ uuid: "dn-1", fast_mode_state: "on" }),
      R({ uuid: "dn-2", fast_mode_state: "cooldown", fast_mode_disabled_reason: "rate_limit" }),
      call("setModel", "claude-fable-9"),
      ev({ type: "model_changed", model: "claude-opus-4-5", source: "chat_command", autoModeOffFor: "claude-opus-4-5" }),
      ev({ type: "advisor_disabled_on_model_change", previousAdvisor: "claude-opus-4-5", newModel: "claude-haiku-4-5" }),
      call("dismissFeedback"),
      call("dismissOpusOverloadNudge"),
      call("dismissLongContextCreditsNudge"),
      call("dismissAuthFailedNudge"),
      call("dismissTokenExpiringNudge"),
      call("dismissFastModeNotice"),
      call("dismissModelSwitchNotice"),
      call("dismissChatCommandModelNotice"),
      call("dismissAdvisorDisabledNotice"),
      call("dismissAutoModeOffNotice"),
      call("dismissFastModeNotice"),
      call("dismissModelSwitchNotice"),
    ],
  },
  {
    name: "status-model_changed and the advisor",
    steps: [
      ev(READY),
      ev({ type: "model_changed", model: "claude-sonnet-4-5", source: "resume", autoModeOffFor: "claude-sonnet-4-5" }),
      ev({ type: "model_changed", model: "claude-opus-4-5", source: "chat_command", fastModeNowSupported: true }),
      ev({ type: "replay_done", hasMoreAbove: false }),
      ev({ type: "model_changed", model: "claude-fable-5", source: "chat_command" }),
      ev({ type: "model_changed", model: "claude-sonnet-4-5", source: "auto", fastModeNowSupported: false, autoModeOffFor: "claude-sonnet-4-5" }),
      ev({ type: "model_changed", model: "", source: "chat_command", fastModeNowSupported: true, autoModeOffFor: "" }),
      ev({ type: "model_changed", source: "auto", fastModeNowSupported: true }),
      ev({ type: "model_changed", model: 5, source: "auto", fastModeNowSupported: null, autoModeOffFor: 7 }),
      ev({ type: "model_changed", model: "claude-haiku-4-5", source: "sdk" }),
      ev({ type: "model_changed", model: null, source: "picker", autoModeOffFor: { m: 1 } }),
      ev({ type: "model_changed", model: { id: "m" }, source: 3 }),
      ev({ type: "advisor_disabled_on_model_change", previousAdvisor: "claude-opus-4-5", newModel: "claude-haiku-4-5" }),
      call("reEnableAdvisor", "claude-opus-4-5"),
      ev({ type: "advisor_disabled_on_model_change" }),
      ev({ type: "advisor_disabled_on_model_change", previousAdvisor: null, newModel: 4 }),
      A("mc-1", M("msg_MC1", [{ type: "text", text: "priced" }], { model: "claude-unknown" }), { at: NOW + 16000 }),
    ],
  },
  {
    name: "status-effort_applied and the wait note",
    routes: [["POST", "^/api/sessions/[^/]+/effort$", { status: 200, body: { ok: true } }]],
    steps: [
      ev(READY),
      ev({ type: "effort_applied", effort: "high" }),
      ev({ type: "replay_done", hasMoreAbove: false }),
      A("ea-1", M("msg_EA1", [{ type: "text", text: "working" }]), { at: NOW + 4000 }),
      call("setEffort", "low"),
      ev({ type: "effort_applied", effort: "low" }),
      E("ea-2", { type: "message_start", message: { id: "msg_EA2" } }),
      call("setEffort", "max"),
      ev({ type: "effort_applied", effort: "low" }),
      call("setEffort", "high"),
      ev({ type: "effort_applied", effort: null }),
      call("setEffort", "medium"),
      ev({ type: "effort_applied" }),
      call("setEffort", "xhigh"),
      ev({ type: "effort_applied", effort: 5 }),
      ev({ type: "effort_applied", effort: "xhigh" }),
      call("setEffort", "low"),
      ev({ type: "effort_applied", effort: "medium" }),
      E("ea-3", { type: "message_start", message: { id: "msg_EA3" }, parent: "toolu_sub" }, { parent: "toolu_sub" }),
      E("ea-4", { type: "message_start", message: { id: "msg_EA4" } }),
      ev({ type: "effort_applied", effort: null }),
      call("setEffort", "max"),
      R({ uuid: "ea-res-1" }),
      ev({ type: "effort_applied", effort: "max" }),
    ],
  }
);

const results = [];
for (const sc of scenarios) results.push(await runScenario(sc));

writeFileSync(
  join(ROOT_DIR, "out.json"),
  `${JSON.stringify(
    { node: process.version, react: React.version, tz: process.env.TZ, now: NOW, scenarios: results },
    null,
    1,
  )}\n`,
);
process.exit(0);
