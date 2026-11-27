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
//   `onmessage`, exactly what the SSE route sends, or fires its `onopen` /
//   `onerror` with a scripted `readyState`);
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
// SSE message (`data`), or a hook action (`action` with `args`; with
// `resolve`, the step also records what its promise resolved to, as
// `resolved`). Later slices add scenarios (and step kinds) to `scenarios`
// below; U01k's block documents the page, storage and stream inputs it
// added (a scenario that sets none of them gets the prelude above).
//
// The prelude also records the stream URL (`eventSource`, which carries the
// tab id, when the boot bound a session) and the uuids used so far
// (`uuids`). After the prelude and after each step it records:
// - `state`: the hook's return value minus its functions, as the client's
//   snapshot JSON (see `enc`). The prelude has every key; a step has only
//   the keys that changed.
// - `fetches`: each `fetch` call in order, `{ method, url, headers?, body?,
//   response: { status, body } | reject }` (`body` is the text sent or
//   received);
// - `timers`: `{ op: "set", id, kind, ms }`, `{ op: "clear", id }` (only of
//   a live timer) and `{ op: "fire", id }`, in order;
// - `streams`: `{ op: "open", es, url }` (`new EventSource`, `es` counts
//   them from 0) and `{ op: "close", es }`, in order;
// - `windowEvents` (`dispatchEvent`), `history` (`replaceState` /
//   `pushState`, and `assign` for `location.assign`), `storage`
//   (sessionStorage after the step, when it changed) and `logs` (console
//   output; an Error prints as `<name>: <message>`).
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
  return { fetches: [], timers: [], windowEvents: [], history: [], logs: [], streams: [] };
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
/**
 * The null-body statuses `new Response` accepts (the Fetch spec's 101 and
 * 103 are below its 200-599 range, so no scenario can script them).
 */
const NULL_BODY_STATUSES = new Set([204, 205, 304]);
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
  // A null-body status (204, 205, 304) takes no body: undici's
  // `new Response("", { status: 204 })` throws "Invalid response status
  // code 204", which reached the hook as a rejected fetch (U01p).
  const body = NULL_BODY_STATUSES.has(spec.status) ? null : text;
  return new Response(body, { status: spec.status, headers: { "content-type": "application/json" } });
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
    this.index = sources.length;
    sources.push(this);
    rec.streams.push({ op: "open", es: this.index, url });
  }
  close() {
    this.readyState = 2;
    rec.streams.push({ op: "close", es: this.index });
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
// The same module instance the hook reads (U01k's URL writer).
const { markNavigating } = await import(pathToFileURL(join(repo, "lib/client/nav-intent.ts")).href);
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
/** The scenario's `useSession` options (U01k: `defaultCwd`). */
let probeOpts;
function Probe() {
  latest = useSession(probeOpts);
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
  // "Open anyway" loads the page anew (U01k).
  locationObj.assign = (url) => rec.history.push({ op: "assign", url: String(url) });
  history.state = null;
  document.hidden = false;
  document.visibilityState = "visible";
  for (const [k, v] of Object.entries(sc.storage ?? {})) sessionStorage.setItem(k, v);
  probeOpts = sc.defaultCwd !== undefined ? { defaultCwd: sc.defaultCwd } : undefined;
  setRoutes(sc.bootRoutes);
  rec = freshRec();

  let prevState = {};
  let prevStorage = JSON.stringify(sessionStorage.dump());
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
  // A boot that binds nothing (U01k: `noStream`) opens no EventSource;
  // `noOpen` leaves the one it opened connecting.
  const es = sources.at(-1);
  if (!es && !sc.noStream) throw new Error(`${sc.name}: the prelude opened no EventSource`);
  if (es && !sc.noOpen) {
    await act(async () => {
      es.open();
      await drain();
    });
  }
  const tabId = es ? new URL(es.url, "http://localhost:3000").searchParams.get("tabId") : null;
  const prelude = record({ ...(es ? { eventSource: es.url } : {}), uuids: uuidN });
  setRoutes(sc.routes);
  // The step's EventSource: `source` (its index), else the newest.
  const src = (i) => sources[i ?? sources.length - 1];

  const steps = [];
  for (const raw of sc.steps) {
    const st = typeof raw === "function" ? raw({ tabId }) : raw;
    const dt = st.dt ?? 1000;
    if (st.hidden !== undefined) document.hidden = st.hidden;
    await advance(dt);
    const input = {};
    if (st.source !== undefined) input.source = st.source;
    if (st.data !== undefined) {
      input.data = st.data;
      await act(async () => {
        src(st.source).send(st.data);
        await drain();
      });
    } else if (st.es !== undefined) {
      // U01k: the browser's `open` / `error` on an EventSource, with the
      // readyState it has when `onerror` runs.
      input.es = st.es;
      const s = src(st.source);
      if (st.es === "error") input.readyState = st.readyState;
      await act(async () => {
        if (st.es === "open") s.open();
        else {
          s.readyState = st.readyState;
          s.onerror?.({ type: "error" });
        }
        await drain();
      });
    } else if (st.pathname !== undefined) {
      // U01k: a render with another committed route (the scenario must
      // have set `pathname`, so the tree keeps its shape).
      if (sc.pathname === undefined) throw new Error(`${sc.name}: a pathname step needs sc.pathname`);
      input.pathname = st.pathname;
      await act(async () => {
        root.render(React.createElement(PathnameContext.Provider, { value: st.pathname }, React.createElement(Probe)));
        await drain();
      });
    } else if (st.navIntent) {
      // U01k: a programmatic push (`useNavIntentRouter`) is about to start.
      input.navIntent = true;
      await act(async () => {
        markNavigating();
        await drain();
      });
    } else if (st.pushState !== undefined) {
      // U01k: the router moved the page.
      input.pushState = st.pushState;
      await act(async () => {
        history.pushState(null, "", st.pushState);
        await drain();
      });
    } else if (st.visibility !== undefined) {
      // U01k: the tab is hidden or shown (`visibilitychange`).
      input.visibility = st.visibility;
      document.hidden = st.visibility === "hidden";
      document.visibilityState = st.visibility;
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
        await drain();
      });
    } else if (st.action) {
      input.action = st.action;
      input.args = st.args ?? [];
      let ret;
      await act(async () => {
        ret = latest[st.action](...input.args);
        await drain();
      });
      // What the action's promise resolved to, for a step that asks (U01g).
      if (st.resolve) input.resolved = enc(await ret);
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
  const boot = {};
  for (const k of ["url", "pathname", "defaultCwd", "storage", "bootRoutes", "noOpen", "noStream"]) {
    if (sc[k] !== undefined) boot[k] = sc[k];
  }
  return { name: sc.name, ...(sc.routes ? { routes: sc.routes } : {}), ...boot, prelude, steps };
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

// ---- U01e: user messages and tool results (`user-` scenarios) ----

/** `SDKUserMessage` (`uuid` left out when undefined). */
const UM = (uuid, content, o = {}) =>
  S(
    {
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: o.parent ?? null,
      ...(uuid === undefined ? {} : { uuid }),
      ...(o.extra ?? {}),
    },
    o.at,
  );
/** A `tool_result` block. */
const TR = (id, content, extra = {}) => ({ type: "tool_result", tool_use_id: id, content, ...extra });
/** A user message carrying one tool result (`o.block` goes on the block). */
const RES = (uuid, id, content, o = {}) => UM(uuid, [TR(id, content, o.block ?? {})], o);
const TU = (id, name, input) => ({ type: "tool_use", id, name, input });
/** `SDKToolProgressMessage`. */
const TP = (id, name, secs, extra = {}) =>
  S({
    type: "tool_progress",
    tool_use_id: id,
    tool_name: name,
    parent_tool_use_id: null,
    elapsed_time_seconds: secs,
    uuid: `tp-${id}-${secs}`,
    ...extra,
  });
/** `SDKThinkingTokensMessage`. */
const TT = (tokens, extra = {}) =>
  S({ type: "system", subtype: "thinking_tokens", estimated_tokens: tokens, estimated_tokens_delta: 10, uuid: `tt-${tokens}`, ...extra });
const REPLAYED = { type: "replay_done", hasMoreAbove: false };
const AUTO_MODE_OFF = (id) => ({ tool_result_meta: [{ id: "toolu_other", non_execution_kind: "automode-unavailable" }, { id, non_execution_kind: "automode-unavailable" }] });
const SUMMARY =
  "This session is being continued from a previous conversation that ran out of context. The conversation is summarized below:\nThe user asked for a fix.";

scenarios.push(
  {
    name: "user-tool results on the transcript",
    steps: [
      ev(READY),
      ev(REPLAYED),
      A(
        "tr-1",
        M("msg_TR1", [
          { type: "text", text: "Reading" },
          TU("toolu_r1", "Read", { file_path: "/work/proj/a.ts" }),
          TU("toolu_r2", "Grep", { pattern: "foo" }),
        ]),
        { at: NOW + 3000 },
      ),
      TP("toolu_r1", "Read", 1),
      TP("toolu_r2", "Grep", 2),
      RES("u-tr-1", "toolu_r1", "file body", { at: NOW + 5000 }),
      RES("u-tr-2", "toolu_r2", [{ type: "text", text: "a.ts:1" }, { type: "text", text: " b.ts:2" }, { type: "image" }, { text: null }, { text: 7 }, 5, null], {
        block: { is_error: true },
      }),
      RES("u-tr-3", "toolu_unknown", "no such tool"),
      RES("u-tr-1", "toolu_r1", "again"),
      A("tr-2", M("msg_TR2", [TU("toolu_r3", "Edit", { file_path: "/work/proj/b.ts", old_string: "a", new_string: "b" })])),
      RES("u-tr-4", "toolu_r3", "Staged for review", { extra: { tool_use_result: { staged: true, detachedToolCall: true } } }),
      A("tr-3", M("msg_TR3", [TU("toolu_r4", "Bash", { command: "rm -rf build" })])),
      RES("u-tr-5", "toolu_r4", "auto mode could not check this", { block: { is_error: true }, extra: AUTO_MODE_OFF("toolu_r4") }),
      RES("u-tr-6", "toolu_r4", "ran after all", { block: { is_error: false } }),
      RES("u-tr-7", "toolu_r2", "no flag"),
      RES("u-tr-8", "toolu_r3", "not staged", { extra: { tool_use_result: { staged: "yes", detachedToolCall: 1 } } }),
      RES("u-tr-9", "toolu_r1", "not run without the error", { extra: AUTO_MODE_OFF("toolu_r1") }),
      UM("u-tr-10", [{ type: "text", text: "before" }, TR("toolu_r2", "first wins"), TR("toolu_r1", "second ignored")]),
      UM("u-tr-11", [TR("toolu_r3", "string meta")], { extra: { tool_use_result: "staged", tool_result_meta: "x" } }),
      TP("toolu_r5", "Glob", 1),
      R({ uuid: "tr-res" }),
    ],
  },
  {
    name: "user-subagent trails and results",
    steps: [
      ev(READY),
      ev(REPLAYED),
      A("sa-0", M("msg_SA0", [TU("toolu_task", "Task", { description: "Explore", prompt: "look", subagent_type: "Explore" })]), { at: NOW + 2000 }),
      UM("sa-u1", "Look around the repo", { parent: "toolu_task", at: NOW + 3000 }),
      UM("sa-u1", "Look around the repo", { parent: "toolu_task" }),
      UM(
        "sa-u2",
        [{ type: "text", text: "part one " }, { type: "text", text: "part two" }, { type: "image" }, { type: "TEXT", text: "x" }, { type: "text", text: "" }, { type: "text", text: null }, { type: "text" }, { type: "text", text: 42 }],
        { parent: "toolu_task", at: "later" },
      ),
      UM(undefined, "a prompt without a uuid", { parent: "toolu_task" }),
      UM("sa-u3", "", { parent: "toolu_task" }),
      UM("sa-u3b", [], { parent: "toolu_task" }),
      S({ type: "user", uuid: "sa-u4", parent_tool_use_id: "toolu_task" }),
      A("sa-1", M("msg_SA1", [TU("toolu_sub1", "Read", { file_path: "x" })]), { parent: "toolu_task", at: NOW + 6000 }),
      RES("sa-r1", "toolu_sub1", "sub result", { parent: "toolu_task" }),
      RES("sa-r2", "toolu_task", "Explored: found 3 files"),
      UM("sa-u5", "another trail", { parent: "toolu_other", at: NOW + 9000 }),
      UM("sa-u6", "an empty parent is the main thread", { parent: "", at: NOW + 10000 }),
      UM("sa-u7", "synthetic, but a subagent's", { parent: "toolu_task", extra: { isSynthetic: true } }),
      UM("sa-u8", "<system-reminder>kept as text</system-reminder>", { parent: "toolu_task" }),
      UM("sa-u9", [{ type: "text", text: "a" }, null], { parent: "toolu_task" }),
    ],
  },
  {
    name: "user-bubbles, images, reminders and peers",
    steps: [
      ev(READY),
      UM("ub-1", "Hello there", { at: NOW + 1000 }),
      UM("ub-1", "Hello there, edited"),
      UM(
        "ub-2",
        [
          { type: "text", text: "See " },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
          { type: "text", text: " please" },
          { type: "image", source: { type: "url", url: "https://example.com/x.png" } },
        ],
        { at: NOW + 2000 },
      ),
      UM("ub-3", [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "/9j/4AAQ" } }]),
      UM("ub-4", "<system-reminder>\nTodos are empty\n</system-reminder>\n<system-reminder>Stale</system-reminder>\nReal question"),
      UM("ub-4", "<system-reminder>\nTodos are empty\n</system-reminder>\n<system-reminder>Stale</system-reminder>\nReal question"),
      UM("ub-5", "<system-reminder>only a reminder</system-reminder>"),
      UM(undefined, "no uuid"),
      UM(undefined, []),
      UM("ub-6", "   "),
      UM("ub-7", "from a peer", {
        extra: { origin: { kind: "peer", from: "local_abc", name: "Other session", body: "The real body", verifiedPeerPid: 4242, msg_id: "m-1" } },
      }),
      UM("ub-8", "peer without a body", { extra: { origin: { kind: "peer", from: "local_abc", body: "", verifiedPeerPid: 1.5 } } }),
      UM("ub-9", "human origin", { extra: { origin: { kind: "human" } } }),
      UM("ub-9b", "", { extra: { origin: { kind: "peer", from: "local_abc", body: "only the body" } } }),
      UM("ub-10", "synthetic", { extra: { isSynthetic: true } }),
      UM("ub-11", "synthetic as a string", { extra: { isSynthetic: "true" } }),
      UM("ub-12", []),
      UM("ub-13", 42),
      S({ type: "user", uuid: "ub-14" }),
      S({ type: "user", uuid: "ub-15", message: null }),
      S({ type: "user", uuid: "ub-16", message: "text" }),
      S({ type: "user", uuid: null, message: { content: "a null uuid" } }),
      A("ub-a", M("msg_UBA", [{ type: "text", text: "answer" }]), { at: NOW + 20000 }),
      UM("ub-17", "<system-reminder>after the answer</system-reminder>\nnext", { at: NOW + 21000 }),
      UM("ub-18", `<session-goal>Ship it</session-goal>\nkeep going ${LONE_HI}`),
      UM("ub-19", [
        { type: "text", text: "<system-reminder>look at " },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
        { type: "text", text: "</system-reminder>" },
      ]),
    ],
  },
  {
    name: "user-filters and pills",
    steps: [
      ev(READY),
      A("fp-a", M("msg_FPA", [{ type: "text", text: "ok" }])),
      UM("fp-1", SUMMARY),
      UM("fp-2", [{ type: "text", text: "  Summary B  " }, { type: "image" }], { extra: { isCompactSummary: true } }),
      A("fp-b", M("msg_FPB", [{ type: "text", text: "later" }])),
      UM("fp-2b", [{ type: "text", text: "" }], { extra: { isCompactSummary: true } }),
      UM(undefined, SUMMARY),
      UM("fp-3", "meta record", { extra: { isMeta: true } }),
      UM("fp-4", "visible only", { extra: { isVisibleInTranscriptOnly: true } }),
      UM("fp-4b", "flag as a string", { extra: { isMeta: "true", isCompactSummary: 1 } }),
      UM("fp-5", "<local-command-caveat>Caveat: the messages below were generated by the user</local-command-caveat>"),
      UM("fp-6", [
        { type: "text", text: "[Image: original 3000x2000, displayed at 1500x1000. Multiply coordinates by 2.00 to map to original image.]" },
      ]),
      UM("fp-7", "<task-notification><task-id>t1</task-id></task-notification>"),
      UM("fp-8", "/compact focus on the tests"),
      UM("fp-8", "/compact focus on the tests"),
      UM("fp-9", [{ type: "text", text: "/review" }]),
      UM(undefined, "/compact"),
      UM("fp-10", "/not-a-real-command"),
      UM("fp-10b", [{ type: "text", text: "/compact" }, { type: "image" }]),
      UM("fp-11", "<command-name>/review</command-name><command-message>review</command-message><command-args>  PR 12 </command-args>"),
      UM("fp-12", "<command-name>/clear</command-name>"),
      UM("fp-13", "<local-command-stdout>Compacted the thread</local-command-stdout>"),
      UM("fp-14", "<local-command-stdout></local-command-stdout>"),
      UM("fp-15", "<local-command-stderr>No such skill</local-command-stderr>"),
      UM("fp-16", "<local-command-stderr>  </local-command-stderr>"),
      UM("fp-17", "<command-name>/model</command-name><command-args>opus</command-args> and then explain the diff", { at: NOW + 30000 }),
      UM("fp-17", "<command-name>/model</command-name><command-args>opus</command-args> and then explain the diff"),
      UM("fp-18", "<local-command-stdout>Set model to claude-opus-4-5[1m] [high effort]</local-command-stdout>"),
      UM("fp-19", "<local-command-stdout>SET MODEL TO\tclaude-sonnet-4-5</local-command-stdout>"),
      UM("fp-20", "<local-command-stdout>Set model to [high]</local-command-stdout>"),
      UM("fp-21", "<local-command-stdout>Set model tosonnet</local-command-stdout>"),
      UM("fp-22", [{ type: "text", text: "<local-command-stdout>Set model to haiku</local-command-stdout>" }]),
      UM(undefined, "<local-command-stdout>Set model to claude-haiku-4-5</local-command-stdout>"),
      UM("fp-23", "<local-command-stderr>oops</local-command-stderr> <b>not prose</b>"),
    ],
  },
  {
    name: "user-recent edits",
    steps: [
      ev(READY),
      ev(REPLAYED),
      A(
        "re-1",
        M("msg_RE1", [
          TU("toolu_e1", "Edit", { file_path: "/work/proj/a.ts", old_string: "x", new_string: "y" }),
          TU("toolu_e2", "Write", { file_path: "/work/proj/new.ts", content: "x" }),
          TU("toolu_e3", "MultiEdit", { file_path: "/work/proj/m.ts", edits: [] }),
        ]),
        { at: NOW + 2000 },
      ),
      A("re-1b", M("msg_RE1", [TU("toolu_e1", "Edit", { file_path: "/work/proj/a.ts" })])),
      A(
        "re-2",
        M("msg_RE2", [
          TU("toolu_e4", "Edit", { file_path: "" }),
          TU("toolu_e5", "Write", { file_path: 5 }),
          TU("toolu_e6", "Edit", {}),
          TU("toolu_e7", "Edit", "not an object"),
          TU("toolu_e8", "NotebookEdit", { notebook_path: "/n.ipynb" }),
          TU("toolu_e9", "Edit", null),
          TU("toolu_e10", "edit", { file_path: "/lower.ts" }),
        ]),
      ),
      RES("re-r1", "toolu_e1", "ok"),
      RES("re-r2", "toolu_e2", "denied", { block: { is_error: true } }),
      RES("re-r3", "toolu_e3", "not run", { block: { is_error: true }, extra: AUTO_MODE_OFF("toolu_e3") }),
      RES("re-r3b", "toolu_e3", "ran", { block: { is_error: false } }),
      RES("re-r2b", "toolu_e2", "retried"),
      A("re-3", M("msg_RE3", [TU("toolu_e11", "Edit", { file_path: "/sub.ts" })]), { parent: "toolu_task" }),
      A("re-4", M("msg_RE4", Array.from({ length: 21 }, (_, i) => TU(`toolu_w${i}`, "Write", { file_path: `/work/proj/f${i}.ts` })))),
      RES("re-r4", "toolu_w0", "dropped from the list"),
      RES("re-r5", "toolu_w20", "newest"),
      R({ uuid: "re-res" }),
    ],
  },
  {
    name: "user-background bashes",
    steps: [
      ev(READY),
      ev(REPLAYED),
      A("bb-1", M("msg_BB1", [TU("toolu_b1", "Bash", { command: "npm run dev", run_in_background: true })]), { at: NOW + 2000 }),
      A("bb-1b", M("msg_BB1", [TU("toolu_b1", "Bash", { command: "npm run dev", run_in_background: true })]), { at: NOW + 9000 }),
      A(
        "bb-2",
        M("msg_BB2", [
          TU("toolu_b2", "Bash", { command: "sleep 100", run_in_background: "true" }),
          TU("toolu_b3", "Bash", { run_in_background: true }),
          TU("toolu_b4", "Bash", { command: "tail -f log", run_in_background: true }),
          TU("toolu_b4z", "Bash", { command: 7, run_in_background: true }),
          TU("42", "Bash", { command: "an index-like id", run_in_background: true }),
        ]),
      ),
      A("bb-2b", M("msg_BB2B", [TU("toolu_b0", "Bash", { command: "at zero", run_in_background: true })]), { at: 0 }),
      RES("bb-r1", "toolu_b1", "Command running in background with ID: bash_1"),
      RES("bb-r4", "toolu_b4", "Running. bash_id: shell-42 more"),
      RES("bb-r4b", "toolu_b4", "bash_id: other"),
      A("bb-3", M("msg_BB3", [TU("toolu_b5", "Bash", { command: "pytest", run_in_background: true })]), { at: NOW + 12000 }),
      RES("bb-r5", "toolu_b5", "BASH ID: Abc_9"),
      A("bb-3b", M("msg_BB3B", [TU("toolu_b5b", "Bash", { command: "go test", run_in_background: true }), TU("toolu_b5c", "Bash", { command: "x", run_in_background: true })])),
      RES("bb-r5b", "toolu_b5b", "Started bashid:xyz-1 (bash-7: no)"),
      RES("bb-r5c", "toolu_b5c", "bash-7: no match", { block: { is_error: true } }),
      A("bb-4", M("msg_BB4", [TU("toolu_b6", "Bash", { command: "make build" })]), { at: NOW + 14000 }),
      RES("bb-r6", "toolu_b6", "Command timed out; moved to the background", {
        extra: { tool_use_result: { stdout: "", stderr: "", interrupted: false, backgroundTaskId: "bg_77", timedOutAfterMs: 120000 } },
        at: NOW + 15500,
      }),
      A("bb-5", M("msg_BB5", [TU("toolu_b7", "Bash", { command: "cargo test" }), TU("toolu_b8", "Bash", { command: "slow" }), TU("toolu_b9", "Bash", {})])),
      RES("bb-r7", "toolu_b7", "done", { extra: { tool_use_result: { stdout: "ok", stderr: "", interrupted: false } } }),
      RES("bb-r8", "toolu_b8", "timed out", { extra: { tool_use_result: { timedOutAfterMs: 5000, backgroundEndsWithFinalResponse: true } } }),
      RES("bb-r9", "toolu_b9", "bash_id: from-text", { extra: { tool_use_result: { backgroundTaskId: "bg_9" } } }),
      RES("bb-r1b", "toolu_b1", "more", { extra: { tool_use_result: { backgroundTaskId: "bg_1", backgroundEndsWithFinalResponse: true } } }),
      RES("bb-r4c", "toolu_b4", "no change", { extra: { tool_use_result: { backgroundTaskId: null, timedOutAfterMs: null } } }),
      A("bb-5b", M("msg_BB5B", [TU("toolu_b11", "Bash", { command: "quiet" }), TU("toolu_r9", "Read", { file_path: "z" })])),
      RES("bb-r11", "toolu_b11", "timed out", { extra: { tool_use_result: { backgroundTaskId: "", timedOutAfterMs: 1000 } } }),
      RES("bb-r11b", "toolu_b11", "bash_id: later"),
      RES("bb-r12", "toolu_r9", "not a shell", { extra: { tool_use_result: { backgroundTaskId: "bg_r", timedOutAfterMs: 1 } } }),
      A(
        "bb-6",
        M("msg_BB6", [
          TU("toolu_k1", "KillBash", { shell_id: "toolu_b1" }),
          TU("toolu_k2", "KillBash", { bash_id: "toolu_b4" }),
          TU("toolu_k3", "KillBash", { shell_id: null, bash_id: "toolu_b5" }),
          TU("toolu_k4", "KillBash", { shell_id: 5, bash_id: "toolu_b6" }),
          TU("toolu_k5", "KillBash", { shell_id: "bg_77" }),
          TU("toolu_k6", "KillBash", {}),
        ]),
      ),
      A("bb-6b", M("msg_BB6B", [TU("toolu_k7", "KillBash", { shell_id: "toolu_b1" })])),
      A("bb-7", M("msg_BB7", [TU("toolu_b10", "Bash", { command: "sub", run_in_background: true })]), { parent: "toolu_task" }),
      R({ uuid: "bb-res" }),
      ev(IDLE),
    ],
  },
  {
    name: "user-tool progress",
    steps: [
      ev(READY),
      ev(REPLAYED),
      A("tp-a", M("msg_TPA", [TU("toolu_p1", "Bash", { command: "npm test" }), TU("toolu_p2", "WebFetch", { url: "https://example.com" })])),
      TP("toolu_p1", "Bash", 1),
      TP("toolu_p1", "Bash", 2.5),
      TP("toolu_p2", "WebFetch", 3, { task_id: "t1", heartbeat: true }),
      TP("toolu_sub9", "Task", 4, {
        parent_tool_use_id: "toolu_task",
        subagent_type: "Explore",
        subagent_retry: { agent_id: "a1", attempt: 2, max_retries: 5, retry_delay_ms: 2000, error_status: 529, error_category: "overloaded" },
      }),
      TP("toolu_sub9", "Task", 5, {
        parent_tool_use_id: "toolu_task",
        subagent_type: "Explore",
        subagent_retry: { agent_id: "a1", attempt: 3, max_retries: 5, retry_delay_ms: 4000, error_status: null, error_category: "network" },
      }),
      TP("123", "Bash", 1),
      TP("7", "Bash", 1),
      TP("toolu_p4", "Read", 0, { subagent_retry: null }),
      RES("tp-r1", "toolu_p1", "passed"),
      RES("tp-r7", "7", "index key"),
      ev(IDLE),
      TP("toolu_p3", "Read", 1),
      R({ uuid: "tp-res" }),
      TP("toolu_p5", "Read", 1),
      ev(RUNNING),
      ev({ type: "turn_status", status: "needs_input" }),
    ],
  },
  {
    name: "user-thinking tokens",
    steps: [
      ev(READY),
      ev(REPLAYED),
      TT(10),
      E("th-1", { type: "message_start", message: { id: "msg_TH1" } }),
      E("th-2", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
      TT(120),
      TT(240, { user_message_uuid: "client-1" }),
      TT(300, { user_message_uuid: "client-1" }),
      TT("400"),
      TT(null),
      E("th-3", { type: "content_block_stop", index: 0, content_block: { type: "thinking", thinking: "pondered" } }),
      E("th-4", { type: "content_block_start", index: 1, content_block: { type: "redacted_thinking", data: "xyz" } }),
      TT(50, { user_message_uuid: "client-2" }),
      TT(60, { user_message_uuid: "client-1" }),
      TT(65, { user_message_uuid: "" }),
      raw('{"type":"sdk","message":{"type":"system","subtype":"thinking_tokens","estimated_tokens":-0,"uuid":"tt-neg"}}'),
      TT(0.5),
      E("th-5", { type: "message_stop" }),
      TT(70),
      A("th-6", M("msg_TH6", [{ type: "thinking", thinking: "done already", signature: "s" }])),
      TT(80),
      S({ type: "system", subtype: "thinking_tokens", uuid: "tt-x" }),
      E("th-7", { type: "message_start", message: { id: "msg_TH7" } }),
      E("th-8", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
      TT(90, { user_message_uuid: "client-3" }),
      R({ uuid: "th-res" }),
      TT(100),
    ],
  },
  {
    name: "user-a rebuild keeps the result",
    steps: [
      ev(READY),
      ev(REPLAYED),
      E("rb-1", { type: "message_start", message: { id: "msg_RB" } }, { at: NOW + 2000 }),
      E("rb-2", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_rb", name: "Read", input: {} } }, { at: NOW + 3000 }),
      E("rb-3", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"file_path":' } }),
      RES("rb-r", "toolu_rb", "contents"),
      E("rb-4", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"/a.ts"}' } }),
      E("rb-5", { type: "content_block_stop", index: 0 }),
      E("rb-6", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
      E("rb-7", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "done" } }),
      E("rb-8", { type: "message_stop" }),
      A("rb-9", M("msg_RB", [TU("toolu_rb", "Read", { file_path: "/a.ts" }), { type: "text", text: "done" }])),
      E("rb-s1", { type: "message_start", message: { id: "msg_RBS" } }, { parent: "toolu_task" }),
      E("rb-s2", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_rbs", name: "Grep", input: {} } }, { parent: "toolu_task" }),
      RES("rb-sr", "toolu_rbs", "match", { parent: "toolu_task" }),
      E("rb-s3", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"pattern":"x"}' } }, { parent: "toolu_task" }),
      E("rb-s4", { type: "message_stop" }, { parent: "toolu_task" }),
      R({ uuid: "rb-res" }),
    ],
  },
  {
    name: "user-tasks and workflows from results",
    steps: [
      ev(READY),
      ev(REPLAYED),
      A(
        "wf-1",
        M("msg_WF1", [
          TU("toolu_wf1", "Workflow", { script: "export const meta = { name: 'nightly', description: 'Run the nightly checks' };\nawait agent('x');" }),
        ]),
        { at: NOW + 2000 },
      ),
      RES("wf-r1", "toolu_wf1", "Started in the background: run_1"),
      RES("wf-r1b", "toolu_wf1", "again"),
      A(
        "wf-2",
        M("msg_WF2", [
          TU("toolu_wf2", "Workflow", { script: 'export const meta = { name: "lint" }' }),
          TU("toolu_wf3", "Workflow", { script: 5 }),
          TU("toolu_wf4", "Workflow", { script: "export const meta = {name: 'x', description: ''}" }),
          TU("toolu_wf5", "Workflow", {}),
          TU("toolu_wf7", "Workflow", "a string input"),
          TU("toolu_wf8", "Workflow", { script: "export const meta = {name: ''}" }),
          TU("toolu_wf9", "Workflow", { script: "const meta = {name: 'not exported'}" }),
        ]),
      ),
      RES("wf-r2", "toolu_wf2", "ok"),
      RES("wf-r3", "toolu_wf3", "ok"),
      RES("wf-r4", "toolu_wf4", "ok"),
      RES("wf-r5", "toolu_wf5", "failed", { block: { is_error: true } }),
      RES("wf-r7", "toolu_wf7", "ok", { block: { is_error: false } }),
      RES("wf-r8", "toolu_wf8", "ok"),
      RES("wf-r8b", "toolu_wf9", "ok"),
      A("wf-3", M("msg_WF3", [TU("toolu_t1", "Task", { description: "Explore", prompt: "p" }), TU("toolu_t2", "Task", { description: "Bg", prompt: "p", run_in_background: true })])),
      RES("wf-r9", "toolu_t1", "done"),
      RES("wf-r10", "toolu_t2", "started"),
      A("wf-4", M("msg_WF4", [TU("toolu_wf6", "Workflow", { script: "const meta = {name:'sub'}" })]), { parent: "toolu_t1" }),
      RES("wf-r11", "toolu_wf6", "ok", { parent: "toolu_t1" }),
      // `messagesRef.current` is the sorted list: the earlier bubble's
      // tool_use of a shared id decides.
      A("wf-5", M("msg_WF5", [TU("toolu_dup", "Read", { file_path: "x" })]), { at: NOW + 50000 }),
      A("wf-6", M("msg_WF6", [TU("toolu_dup", "Workflow", { script: "const meta = {name:'dup'}" })]), { at: NOW + 1000 }),
      RES("wf-r12", "toolu_dup", "ok"),
      A("wf-7", M("msg_WF7", [TU("toolu_dup2", "Workflow", { script: "const meta = {name:'late'}" })]), { at: NOW + 60000 }),
      A("wf-8", M("msg_WF8", [TU("toolu_dup2", "Read", { file_path: "y" })]), { at: NOW + 500 }),
      RES("wf-r13", "toolu_dup2", "ok"),
    ],
  },
  {
    name: "user-odd payloads",
    steps: [
      ev(READY),
      S({ type: "user", uuid: "od-1", message: { content: [null] } }),
      S({ type: "user", uuid: "od-1b", message: { content: [{ type: "text", text: "a" }, null] } }),
      S({ type: "user", uuid: "od-2", message: { content: [{ type: "tool_result" }] } }),
      S({ type: "user", uuid: "od-3", message: { content: [{ type: "text", text: "hi" }, { type: "tool_result", tool_use_id: "toolu_x", content: { text: "obj" } }] } }),
      S({ type: "user", uuid: "od-4", message: { content: [{ type: "tool_result", tool_use_id: "toolu_y", content: [{ text: "a" }, null, {}, { text: false }] }] } }),
      S({ type: "user", uuid: "od-5", message: [{ content: "an array message" }] }),
      S({ type: "user", uuid: "od-6", message: { content: "x" }, isSynthetic: true, parent_tool_use_id: "toolu_q" }),
      S({ type: "user", message: { content: [{ type: "text", text: "no uuid, no parent key" }] } }),
      S({ type: "tool_progress", tool_use_id: "toolu_z", tool_name: "Read", parent_tool_use_id: null }),
      S({ type: "tool_progress", tool_use_id: "toolu_z", tool_name: "Read", parent_tool_use_id: null, elapsed_time_seconds: 3, subagent_retry: 0 }),
      S({ type: "system", subtype: "thinking_tokens", estimated_tokens: 5 }),
      S({ type: "user", uuid: "od-7", isCompactSummary: true }),
      S({ type: "user", isCompactSummary: true, message: 0 }),
      S({ type: "user", message: null }),
      UM(undefined, "the next random uuid"),
    ],
  },
);

// ---- U01h: system entries, compaction and paging (`system-` scenarios).
// Shapes are the SDK's (0.3.312) `SDKSystemMessage` subtypes,
// `SDKConversationResetMessage` and `SDKRateLimitEvent`, the server's
// `slash_invoked` breadcrumb and `session_snapshot`, and JSONL records for
// the `/transcript` pages `loadOlder` reads.

/** A `system` message of `subtype`. */
const SYS = (subtype, uuid, extra = {}) => S({ type: "system", subtype, uuid, ...extra });
const INIT = (uuid, extra = {}) =>
  SYS("init", uuid, {
    agents: ["general-purpose", "Explore"],
    apiKeySource: "none",
    claude_code_version: "2.1.312",
    cwd: "/work/proj",
    tools: ["Bash", "Read", "Edit", "advisor"],
    mcp_servers: [{ name: "linear", status: "connected" }],
    model: "claude-opus-4-5",
    permissionMode: "default",
    slash_commands: ["compact", "review", "init"],
    output_style: "default",
    skills: ["pdf"],
    plugins: [],
    fast_mode_state: "off",
    effort: "high",
    ...extra,
  });
const HOOK_START = (uuid, id, name, event) => SYS("hook_started", uuid, { hook_id: id, hook_name: name, hook_event: event });
const HOOK_DONE = (uuid, id, name, event, extra = {}) =>
  SYS("hook_response", uuid, {
    hook_id: id,
    hook_name: name,
    hook_event: event,
    output: "",
    stdout: "",
    stderr: "",
    exit_code: 0,
    outcome: "success",
    ...extra,
  });
const SLASH = (uuid, command, args = "") => SYS("slash_invoked", uuid, { command, args });
const RESET = (uuid, extra = {}) => S({ type: "conversation_reset", new_conversation_id: "conv-2", uuid, ...extra });
const RATE = (uuid, info) => S({ type: "rate_limit_event", rate_limit_info: info, uuid });
const CREDITS = "fast-mode-overage-rejected";
/** JSONL records, as `/transcript` pages carry them. */
const JU = (uuid, content, extra = {}) => ({ type: "user", uuid, message: { role: "user", content }, ...extra });
const JA = (uuid, id, content, extra = {}) => ({ type: "assistant", uuid, message: { id, role: "assistant", content }, ...extra });
const PAGE_URL = "^/api/sessions/[^/]+/transcript";
const page = (messages, hasMore) => ({ status: 200, body: { messages, hasMore } });
/** `jumpToUuid(uuid)`, recording what it resolved to (U01o). */
const jump = (uuid) => ({ ...call("jumpToUuid", uuid), resolve: true });

scenarios.push(
  {
    name: "system-init",
    steps: [
      ev(READY),
      INIT("init-1"),
      INIT("init-2"),
      A("in-1", M("msg_IN1", [{ type: "text", text: "hello" }]), { at: NOW + 4000 }),
      INIT("init-3", {
        tools: "Bash",
        slash_commands: [],
        agents: [5, null],
        skills: [],
        cwd: "",
        model: 7,
        permissionMode: "",
        fast_mode_state: "warm",
        fast_mode_disabled_reason: "",
        effort: null,
      }),
      INIT("init-4", {
        slash_commands: ["compact", 3, "context"],
        model: "claude-sonnet-4-5",
        permissionMode: "plan",
        fast_mode_state: "cooldown",
        fast_mode_disabled_reason: "rate_limit",
        effort: "max",
        tools: [],
      }),
      INIT("init-5", { effort: "auto", cwd: "/work/other", fast_mode_state: "on" }),
      SYS("init", "init-6"),
      SYS("init", 9, { model: "claude-opus-4-5", tools: ["advisor"] }),
    ],
  },
  {
    name: "system-init keeps a known advisor",
    routes: [["POST", "^/api/sessions/[^/]+/advisor$", { status: 200, body: { ok: true } }]],
    steps: [ev(READY), call("setAdvisorModel", "claude-opus-4-5"), INIT("ia-1"), call("setAdvisorModel", null), INIT("ia-2", { tools: ["Read"] }), INIT("ia-3")],
  },
  {
    name: "system-hooks",
    steps: [
      ev(READY),
      HOOK_START("h-1", "hk-1", "SessionStart:startup", "SessionStart"),
      HOOK_DONE("h-2", "hk-1", "SessionStart:startup", "SessionStart"),
      HOOK_START("h-3", "hk-2", "PreToolUse:Bash", "PreToolUse"),
      HOOK_DONE("h-4", "hk-9", "PreToolUse:Bash", "PreToolUse"),
      HOOK_DONE("h-5", "hk-2", "PreToolUse:Bash", "PreToolUse"),
      HOOK_START("h-6", "hk-3", "UserPromptSubmit", "UserPromptSubmit"),
      HOOK_DONE("h-7", "hk-3", "UserPromptSubmit", "UserPromptSubmit", { outcome: "error", exit_code: 2, stderr: "  blocked: no secrets \n" }),
      HOOK_DONE("h-8", "hk-4", "UserPromptSubmit", "UserPromptSubmit", { outcome: "error", exit_code: 2, stderr: "other text" }),
      HOOK_DONE("h-9", "hk-5", "PostToolUse:Edit", "PostToolUse", { outcome: "cancelled", exit_code: undefined, stderr: "   " }),
      A("hk-a", M("msg_HK", [{ type: "text", text: "next" }]), { at: NOW + 9000 }),
      HOOK_DONE("h-10", "hk-6", "UserPromptSubmit", "UserPromptSubmit", { outcome: "error", exit_code: 2, stderr: "again" }),
      SYS("hook_response", "h-11", { hook_event: "SessionEnd" }),
      HOOK_DONE("h-11b", "hk-1", "SessionStart:resume", "SessionStart", { exit_code: 1e21 }),
      SYS("hook_started", "h-12", { hook_name: "Setup" }),
      SYS("hook_started", "h-12b", { hook_id: "hk-8", hook_event: "SubagentStart" }),
      SYS("hook_started", "h-13", { hook_id: "hk-7" }),
      SYS("hook_started", "h-14", { hook_id: 5, hook_event: 7 }),
      SYS("hook_response", "h-15", { hook_id: 5, hook_event: 7, hook_name: 3, outcome: "error", exit_code: "2" }),
      SYS("hook_started", "h-16", { hook_id: "", hook_event: "Stop", hook_name: null }),
      SYS("hook_response", "h-17", { hook_id: "", outcome: "success", exit_code: 1.5 }),
      SYS("hook_response", "h-18", { hook_event: "Stop", outcome: "error", stderr: 5 }),
      SYS("hook_response", "h-19", { hook_event: "Stop", outcome: "error", stderr: null, hook_name: "Stop" }),
      SYS("hook_response", "h-20", { hook_event: "Setup", outcome: "ok?", stderr: 5 }),
    ],
  },
  {
    name: "system-status, compaction and slash commands",
    steps: [
      ev(READY),
      ev({ type: "replay_done", hasMoreAbove: false }),
      SYS("status", "st-1", { status: "compacting" }),
      SYS("status", "st-2", { status: "compacting" }),
      SYS("status", "st-3", { status: null }),
      SYS("status", "st-4", { status: 5 }),
      SYS("status", "st-5"),
      SLASH("sl-1", "/compact"),
      SYS("compact_boundary", "cb-1", { compact_metadata: { trigger: "manual", pre_tokens: 120000, post_tokens: 9000, duration_ms: 4200 } }),
      R({ uuid: "res-1", subtype: "error_during_execution", is_error: true, errors: ["late"] }),
      SLASH("sl-2", "  /compact  ", "  keep the API notes "),
      R({ uuid: "res-2", subtype: "error_during_execution", is_error: true, errors: ["Conversation too long"] }),
      SLASH("sl-2", "/compact"),
      R({ uuid: "res-3", subtype: "error_during_execution", is_error: true, errors: ["again"] }),
      SLASH("sl-3", "/compact"),
      R({ uuid: "res-4", subtype: "error_max_turns", is_error: true, errors: [] }),
      SLASH("sl-4", "/compact"),
      R({ uuid: "res-5" }),
      ev(RUNNING),
      SLASH("sl-5", "/compact"),
      R({ uuid: "res-6", subtype: "error_during_execution", is_error: true, errors: ["mid-turn"] }),
      SLASH("sl-6", "/review", "src/auth.ts"),
      SLASH("sl-7", ""),
      SYS("slash_invoked", "sl-8"),
      SYS("slash_invoked", "sl-9", { command: null, args: null }),
      SYS("slash_invoked", "sl-10", { command: 5 }),
      SYS("slash_invoked", "sl-11", { command: "/x", args: ["a"] }),
      R({ uuid: "res-7" }),
      SLASH("sl-12", "/review"),
      R({ uuid: "res-8", subtype: "error_during_execution", is_error: true, errors: ["not a compaction"] }),
      A("cb-a", M("msg_CB", [{ type: "text", text: "after" }]), { at: NOW + 30000 }),
      SYS("compact_boundary", "cb-2", { compactMetadata: { trigger: "auto", preTokens: 150000 } }),
      SYS("compact_boundary", "cb-3", { compact_metadata: { post_tokens: 8000, duration_ms: 3100 } }),
      SYS("compact_boundary", "cb-1", { compact_metadata: null, compactMetadata: { trigger: "x" } }),
      A("cb-b", M("msg_CB2", [{ type: "text", text: "later" }]), { at: NOW + 40000 }),
      SYS("compact_boundary", "cb-4"),
      SYS("compact_boundary", "cb-5", { compact_metadata: { pre_tokens: "many" } }),
    ],
  },
  {
    name: "system-api retry",
    steps: [
      ev(READY),
      SYS("api_retry", "ar-1", { attempt: 2, max_retries: 10, retry_delay_ms: 4000, error_status: 529, error: "overloaded" }),
      A("ar-a", M("msg_AR", [{ type: "text", text: "through" }]), { at: NOW + 3000 }),
      SYS("api_retry", "ar-2", {
        attempt: 1,
        max_retries: 1,
        retry_delay_ms: 0,
        error_status: null,
        error: "unknown",
        no_response: { waited_ms: 30000, retry_wait_ms: 60000 },
      }),
      R({ uuid: "ar-res" }),
      SYS("api_retry", "ar-3"),
      SYS("api_retry", "ar-4", { attempt: "2", max_retries: null, retry_delay_ms: 1.5, error: null, no_response: { waited_ms: 5 } }),
      SYS("api_retry", "ar-5", { attempt: 0, error: "rate_limit", no_response: null }),
      SYS("api_retry", "ar-6", { attempt: -1, error_status: 503, error: "server_error", no_response: { waited_ms: 0, retry_wait_ms: 0 } }),
      E("ar-s", { type: "message_start", message: { id: "msg_AR2" } }),
      A("ar-b", M("msg_AR2", [{ type: "text", text: "ok" }]), { at: NOW + 9000 }),
    ],
  },
  {
    name: "system-pills",
    steps: [
      ev(READY),
      SYS("model_fallback", "mf-1", {
        trigger: "overloaded",
        original_model: "claude-opus-4-5",
        fallback_model: "claude-sonnet-4-5",
        content: "  Switched to Sonnet 4.5 because Opus 4.5 is overloaded  ",
      }),
      SYS("model_fallback", "mf-2", { trigger: "last_resort", original_model: "claude-opus-4-5", fallback_model: "claude-sonnet-4-5", content: "   " }),
      SYS("model_fallback", "mf-3", { original_model: "claude-opus-4-5", content: 5 }),
      SYS("model_fallback", "mf-4", { original_model: 4, fallback_model: true }),
      SYS("permission_denied", "pd-1", { tool_name: "Bash", tool_use_id: "toolu_pd", decision_reason_type: "classifier", decision_reason: "risky", message: "denied" }),
      SYS("permission_denied", "pd-2", { tool_name: "Write", decision_reason: "a deny rule" }),
      SYS("permission_denied", "pd-3", { decision_reason_type: null, decision_reason: "fallback" }),
      SYS("permission_denied", "pd-4", { tool_name: null }),
      A("pl-a", M("msg_PL", [{ type: "text", text: "hi" }]), { at: NOW + 6000 }),
      SYS("informational", "if-1", { content: "  Stop hook said no  ", level: "warning", prevent_continuation: true }),
      SYS("informational", "if-2", { content: "notice text", level: "notice" }),
      SYS("informational", "if-3", { content: "a tip", level: "suggestion", prevent_continuation: false }),
      SYS("informational", "if-4", { content: "transcript only", level: "info" }),
      SYS("informational", "if-5", { content: "loud", level: "LOUD" }),
      SYS("informational", "if-6", { content: "no level" }),
      SYS("informational", "if-7", { content: "   ", level: "warning" }),
      SYS("informational", "if-8", { content: 5, level: "warning" }),
      SYS("informational", "if-9", { content: "odd level", level: 5, prevent_continuation: "yes" }),
      SYS("worker_shutting_down", "ws-1", { reason: "host_exit" }),
      SYS("worker_shutting_down", "ws-2"),
      SYS("worker_shutting_down", "ws-3", { reason: "" }),
      SYS("elicitation_complete", "ec-1", { mcp_server_name: "linear", elicitation_id: "el-1" }),
      SYS("elicitation_complete", "ec-2", { mcp_server_name: "" }),
      SYS("model_refusal_fallback", "mr-1", {
        content: "  Answered by a fallback model.  ",
        api_refusal_explanation: "  policy  ",
        refused_user_message_uuid: "u-refused",
      }),
      SYS("model_refusal_no_fallback", "mr-2", { content: "", api_refusal_explanation: null, refused_user_message_uuid: "" }),
      SYS("model_refusal_no_fallback", "mr-3", { content: 5, api_refusal_explanation: "   ", refused_user_message_uuid: 7 }),
      SYS("notification", "nt-1", { key: "loop", text: "  Loop finished  ", priority: "high" }),
      SYS("notification", "nt-2", { key: "x", text: "quiet", priority: "" }),
      SYS("notification", "nt-3", { key: "x", text: "   " }),
      SYS("notification", "nt-4", { key: "x", text: 5, priority: "low" }),
      SYS("local_command_output", "lc-1", { content: "  Context: 12k / 200k  " }),
      SYS("local_command_output", "lc-2", { content: "" }),
      SYS("local_command_output", "lc-3", { content: ["x"] }),
      SYS("files_persisted", "fp-1", { files: [] }),
      SYS("stop_hook_summary", "sh-1"),
      SYS("hook_progress", "hp-1"),
      SYS(undefined, "un-1"),
      SYS(null, "un-2"),
      SYS("", "un-3"),
      SYS(5, "un-4"),
      SYS({ a: 1 }, "un-5"),
      SYS(["a", "b"], "un-6"),
    ],
  },
  {
    name: "system-commands_changed",
    steps: [
      ev(READY),
      INIT("cc-0"),
      SYS("commands_changed", "cc-1", { commands: [{ name: "compact", description: "" }, { name: "deploy", description: "Ship it" }] }),
      SYS("commands_changed", "cc-2", { commands: [] }),
      SYS("commands_changed", "cc-3", { commands: [{ name: "" }, { name: 5 }, null, "x", [1], { name: "review" }] }),
      SYS("commands_changed", "cc-4"),
      SYS("commands_changed", "cc-5", { commands: null }),
      SYS("commands_changed", "cc-6", { commands: [{ name: "" }] }),
      SYS("commands_changed", "cc-7", { commands: "deploy" }),
      SYS("commands_changed", "cc-8", { commands: { name: "deploy" } }),
      SYS("commands_changed", "cc-9", { commands: 3 }),
    ],
  },
  {
    name: "system-fast credits notice",
    routes: [["POST", "^/api/sessions/[^/]+/fast$", { status: 200, body: { ok: true } }]],
    steps: [
      ev(READY),
      call("setFast", true),
      SYS("notification", "fc-0", { key: CREDITS, text: "Fast mode off: out of credits", priority: "immediate" }),
      ev({ type: "replay_done", hasMoreAbove: false }),
      SYS("notification", "fc-0", { key: CREDITS, text: "replayed", priority: "immediate" }),
      call("setFast", true),
      SYS("notification", "fc-1", { key: CREDITS, text: "Fast mode off: out of credits", priority: "immediate" }),
      call("setFast", true),
      SYS("notification", "fc-1", { key: CREDITS, text: "again" }),
      SYS("notification", undefined, { key: CREDITS, text: "" }),
      call("setFast", true),
      SYS("notification", undefined, { key: CREDITS }),
      call("setFast", true),
      SYS("notification", 7, { key: CREDITS }),
      call("setFast", true),
      SYS("notification", "fc-2", { key: "other", text: "not it" }),
    ],
  },
  {
    name: "system-conversation_reset",
    steps: [
      ev(READY),
      RESET("cr-1", { trigger: "clear", user_message_uuid: "u-clear", timestamp: "2025-11-16T13:33:20.000Z" }),
      A("cr-a", M("msg_CR", [{ type: "text", text: "planned" }]), { at: NOW + 3000 }),
      RESET("cr-2", { trigger: "plan_mode_exit" }),
      RESET("cr-3", { trigger: "fresh_session" }),
      RESET("cr-4", { trigger: "onboarding" }),
      RESET("cr-5"),
      RESET("cr-6", { trigger: "bogus" }),
      RESET("cr-8", { trigger: "" }),
    ],
  },
  {
    name: "system-rate_limit_event",
    steps: [
      ev(READY),
      RATE("rl-1", { status: "allowed", rateLimitType: "five_hour", resetsAt: 1763317000, utilization: 0.4, isUsingOverage: false }),
      A("rl-a", M("msg_RL", [{ type: "text", text: "working" }]), { at: NOW + 3000 }),
      RATE("rl-2", { status: "allowed_warning", rateLimitType: "five_hour", resetsAt: 1763317000, utilization: 0.9, surpassedThreshold: 0.8 }),
      RATE("rl-3", {
        status: "rejected",
        rateLimitType: "seven_day_opus",
        resetsAt: 1763900000,
        overageStatus: "rejected",
        overageResetsAt: 1763950000,
        overageDisabledReason: "out_of_credits",
        overageInUse: false,
        overageEnabled: true,
        errorCode: "credits_required",
        canUserPurchaseCredits: true,
        hasChargeableSavedPaymentMethod: false,
        limitScope: "group_pool",
      }),
      SYS("status", "rl-st", { status: "requesting" }),
      RATE("rl-4", {}),
      RATE("rl-5", { status: "allowed" }),
      RATE("rl-6", { status: "allowed", rateLimitType: "__no_type__" }),
      S({ type: "rate_limit_event", uuid: "rl-7" }),
      A("rl-b", M("msg_RLB", [{ type: "text", text: "You've hit your limit \u00b7 resets 5pm" }]), { at: NOW + 9000, extra: { error: "rate_limit" } }),
      RATE("rl-8", { status: "allowed", rateLimitType: "seven_day" }),
      A("rl-c", M("msg_RLC", [{ type: "text", text: "x" }]), { at: NOW + 11000, extra: { error: "rate_limit" } }),
    ],
  },
  {
    name: "system-session_snapshot",
    steps: [
      ev(READY),
      ev({
        type: "session_snapshot",
        todos: [
          { content: "Read the code", status: "completed", activeForm: "Reading the code" },
          { content: "Fix the bug", status: "in_progress", activeForm: "Fixing the bug" },
        ],
        todosStale: true,
        lastUserPrompt: { uuid: "u-last", text: "fix the login bug", at: NOW + 2000 },
        init: { slashCommands: ["compact", "review"], agents: ["Explore"], skills: ["pdf"], cwd: "/work/proj" },
      }),
      A("ss-a", M("msg_SSA", [{ type: "text", text: "first" }]), { at: NOW + 1000 }),
      A("ss-b", M("msg_SSB", [{ type: "text", text: "third" }]), { at: NOW + 5000 }),
      A("ss-c", M("msg_SSC", [{ type: "text", text: "untimed" }])),
      ev({ type: "session_snapshot", lastUserPrompt: { uuid: "u-mid", text: "middle", at: NOW + 3000 } }),
      ev({ type: "session_snapshot", lastUserPrompt: { uuid: "u-late", text: "latest", at: NOW + 99000 } }),
      ev({ type: "session_snapshot", lastUserPrompt: { uuid: "u-tie", text: "same time as third", at: NOW + 5000 } }),
      ev({ type: "session_snapshot", lastUserPrompt: { uuid: "u-old", text: "no time" } }),
      ev({ type: "session_snapshot", lastUserPrompt: { uuid: "u-mid", text: "again", at: 1 } }),
      ev({ type: "session_snapshot", lastUserPrompt: { uuid: "u-x", text: "" } }),
      ev({ type: "session_snapshot", lastUserPrompt: { uuid: "", text: "x" } }),
      ev({ type: "session_snapshot", lastUserPrompt: null }),
      ev({ type: "session_snapshot", lastUserPrompt: { uuid: "u-str", text: "string at", at: "5" } }),
      ev({ type: "session_snapshot", todos: [], todosStale: false }),
      ev({ type: "session_snapshot", todos: "x", todosStale: "yes" }),
      ev({ type: "session_snapshot", todos: [{ subject: "From TaskCreate", status: "pending" }, { content: 5 }] }),
      ev({ type: "session_snapshot", init: { slashCommands: [], agents: [], skills: [], cwd: "" } }),
      ev({ type: "session_snapshot", init: { slashCommands: ["context"], agents: 5, skills: {}, cwd: 7 } }),
      ev({ type: "session_snapshot", init: null, todosStale: true }),
      ev({ type: "session_snapshot", todos: [{ content: "kept before the throw" }], init: {}, todosStale: false }),
      ev({ type: "session_snapshot", init: { slashCommands: null } }),
      ev({ type: "session_snapshot", init: { slashCommands: ["a"], agents: undefined } }),
      ev({ type: "session_snapshot", init: 5 }),
      ev({ type: "session_snapshot" }),
    ],
  },
  {
    name: "system-loadOlder",
    routes: [
      [
        "GET",
        PAGE_URL,
        [
          page(
            [
              JU("j-sum", "This session is being continued from a previous conversation. Summary: a middle compaction.", {
                isCompactSummary: true,
                timestamp: "2025-11-16T12:59:00.000Z",
              }),
              JU("j-u1", "list files", { timestamp: "2025-11-16T13:00:00.000Z" }),
              JA("j-a1", "msg_J1", [{ type: "text", text: "Sure" }]),
              JA("j-a2", "msg_J1", [{ type: "tool_use", id: "toolu_J", name: "Bash", input: { command: "ls" } }]),
              JU("j-u2", [{ type: "tool_result", tool_use_id: "toolu_J", content: "a\nb" }]),
            ],
            true,
          ),
          page([JU("j-u0", "earlier", { timestamp: "2025-11-16T12:00:00.000Z" })], undefined),
          page([JU("j-u0", "earlier", { timestamp: "2025-11-16T12:00:00.000Z" })], true),
        ],
      ],
    ],
    steps: [
      call("loadOlder"),
      ev(READY),
      ev({ type: "replay_done", hasMoreAbove: true }),
      call("loadOlder"),
      call("loadOlder"),
      ev({ type: "replay_done", hasMoreAbove: 1 }),
      call("loadOlder"),
      call("loadOlder"),
    ],
  },
  {
    name: "system-loadOlder reaches a compaction",
    routes: [
      [
        "GET",
        PAGE_URL,
        [
          page(
            [
              JU("c-sum", "This session is being continued from a previous conversation that ran out of context. Summary: fixed auth.", {
                isCompactSummary: true,
                timestamp: "2025-11-16T11:00:00.000Z",
              }),
              { type: "system", subtype: "compact_boundary", uuid: "c-bnd", compactMetadata: { trigger: "auto", preTokens: 160000 } },
              JU("c-u1", "carry on", { timestamp: "2025-11-16T11:01:00.000Z" }),
              JA("c-a1", "msg_C1", [{ type: "text", text: "On it" }]),
            ],
            false,
          ),
        ],
      ],
    ],
    steps: [
      ev(READY),
      A("c-live", M("msg_CL", [{ type: "text", text: "live" }]), { at: NOW + 3000 }),
      ev({ type: "replay_done", hasMoreAbove: true }),
      call("loadOlder"),
      ev({ type: "replay_done", hasMoreAbove: true }),
      call("loadOlder"),
    ],
  },
  {
    name: "system-loadOlder failures",
    routes: [
      [
        "GET",
        PAGE_URL,
        [
          { status: 400, body: { error: "before uuid not found" } },
          { reject: "Failed to fetch" },
          { status: 200, text: "not json" },
          { status: 200, text: "null" },
          { status: 200, body: { messages: {}, hasMore: true } },
          { status: 500, body: { error: "boom" } },
          { status: 200, text: "\ufeff{\"messages\":[],\"hasMore\":true}" },
        ],
      ],
    ],
    steps: [
      ev(READY),
      A("f-a", M("msg_F", [{ type: "text", text: "head" }]), { at: NOW + 2000 }),
      ev({ type: "replay_done", hasMoreAbove: true }),
      call("loadOlder"),
      ev({ type: "replay_done", hasMoreAbove: true }),
      call("loadOlder"),
      call("loadOlder"),
      call("loadOlder"),
      call("loadOlder"),
      call("loadOlder"),
      ev({ type: "replay_done", hasMoreAbove: true }),
      call("loadOlder"),
    ],
  },
  // U01o: `jumpToUuid` pages older history in until a bubble holds the uuid
  // (its own, or a folded SDK uuid), each page resolved once it's merged
  // and the next cursor taken from it.
  {
    name: "system-jumpToUuid",
    routes: [
      [
        "GET",
        PAGE_URL,
        [
          page(
            [
              JU("k-u3", "third", { timestamp: "2025-11-16T12:30:00.000Z" }),
              JA("k-a3", "msg_K3", [{ type: "text", text: "three" }]),
            ],
            true,
          ),
          page(
            [
              JU("k-u2", "second", { timestamp: "2025-11-16T12:20:00.000Z" }),
              JA("k-a2a", "msg_K2", [{ type: "text", text: "two" }]),
              JA("k-a2b", "msg_K2", [{ type: "tool_use", id: "toolu_K", name: "Bash", input: { command: "ls" } }]),
              JU("k-r2", [{ type: "tool_result", tool_use_id: "toolu_K", content: "a" }]),
            ],
            true,
          ),
          page([JU("k-u1", "first", { timestamp: "2025-11-16T12:10:00.000Z" })], false),
        ],
      ],
    ],
    steps: [
      ev(READY),
      A("k-live", M("msg_KL", [{ type: "text", text: "live" }]), { at: NOW + 3000 }),
      ev({ type: "replay_done", hasMoreAbove: true }),
      jump("msg_KL"),
      jump("k-a2b"),
      jump("msg_K3"),
      jump("nope"),
      jump("nope"),
      jump("k-u1"),
    ],
  },
  {
    name: "system-jumpToUuid stops when the cursor can't move",
    routes: [["GET", PAGE_URL, [{ status: 400, body: { error: "before uuid not found" } }]]],
    steps: [
      jump("gone"),
      ev(READY),
      A("g-a", M("msg_G", [{ type: "text", text: "head" }]), { at: NOW + 2000 }),
      ev({ type: "replay_done", hasMoreAbove: true }),
      jump("gone"),
      jump("gone"),
    ],
  },
);

// ---- U01g: tasks, todos and loops (`task-` scenarios). Shapes are the
// SDK's (0.3.312) `SDKTaskStartedMessage` / `SDKTaskUpdatedMessage` /
// `SDKTaskProgressMessage` / `SDKTaskNotificationMessage` /
// `SDKBackgroundTasksChangedMessage`, the TodoWrite / TaskCreate /
// TaskUpdate / TaskList / CronCreate / CronDelete / ScheduleWakeup calls and
// results the CLI writes, and the server's `task_snapshot` (session-tasks-db's
// `TaskSnapshotEntry`) and `todos_auto_cleared`. Typed fields only get the
// types the server sends (see task_events.rs for the odd ones).

const callR = (action, ...args) => ({ action, args, resolve: true });
/** A main-thread assistant split with one tool_use (`at` left out when undefined). */
const TOOL = (uuid, id, name, input, at) =>
  A(uuid, M(`msg_${uuid.replace(/-/g, "_")}`, [TU(id, name, input)]), at === undefined ? {} : { at });
const SNAP = (tasks) => ev({ type: "task_snapshot", tasks });
/** A subagent's conversation as `task_snapshot` carries it. */
const INNER = (parent) => [
  { at: NOW + 1100, message: { type: "user", uuid: `${parent}-u1`, parent_tool_use_id: parent, message: { role: "user", content: "Find the config" } } },
  {
    at: NOW + 1200,
    message: { type: "assistant", uuid: `${parent}-a1`, parent_tool_use_id: parent, message: { id: `msg_${parent}_1`, role: "assistant", content: [{ type: "text", text: "Looking" }] } },
  },
  {
    at: NOW + 1300,
    message: {
      type: "assistant",
      uuid: `${parent}-a2`,
      parent_tool_use_id: parent,
      message: { id: `msg_${parent}_1`, role: "assistant", content: [{ type: "tool_use", id: `${parent}-read`, name: "Read", input: { file_path: "/a" } }] },
    },
  },
  { message: { type: "user", parent_tool_use_id: parent, message: { role: "user", content: [{ type: "text", text: "no uuid" }] } } },
  { message: { type: "system", subtype: "init" } },
];
const CRON_TEXT =
  "Scheduled recurring job 1545ddb6 (Every minute). Session-only (not written to disk, dies when Claude exits). Auto-expires after 7 days. Use CronDelete to cancel sooner.";

scenarios.push(
  {
    name: "task-todos from tool calls",
    steps: [
      ev(READY),
      TOOL(
        "td-1",
        "toolu_tw1",
        "TodoWrite",
        {
          todos: [
            { content: "Read the code", status: "completed", activeForm: "Reading the code" },
            { id: "x2", content: "Fix the bug", status: "in_progress", activeForm: "Fixing the bug" },
            { subject: "From subject" },
            null,
            5,
            { content: 7, status: 3, activeForm: 1, id: 9 },
          ],
        },
        NOW + 1000,
      ),
      TOOL("td-2", "toolu_tw2", "TodoWrite", { todos: "not a list" }),
      TOOL("td-3", "toolu_tw3", "TodoWrite", {}),
      TOOL("td-4", "toolu_tc1", "TaskCreate", { subject: "Write tests", description: "d", activeForm: "Writing tests" }),
      TOOL("td-5", "toolu_tc2", "TaskCreate", { subject: 5, activeForm: 7 }),
      TOOL("td-4b", "toolu_tc1", "TaskCreate", { subject: "a replay" }),
      RES("tdr-1", "toolu_tc1", JSON.stringify({ task: { id: "1", subject: "Write tests" } })),
      RES("tdr-2", "toolu_tc2", "Task #2 created successfully: 5"),
      TOOL("td-6", "toolu_tc3", "TaskCreate", { subject: "Will fail" }),
      RES("tdr-3", "toolu_tc3", "boom", { block: { is_error: true } }),
      TOOL("td-7", "toolu_tc4", "TaskCreate", { subject: "Empty id" }),
      RES("tdr-4", "toolu_tc4", JSON.stringify({ task: { id: "" } })),
      TOOL("td-8", "toolu_tc5", "TaskCreate", { subject: "null payload" }),
      RES("tdr-5", "toolu_tc5", "null"),
      TOOL("td-8b", "toolu_tc6", "TaskCreate", { subject: "From a subagent's result" }),
      RES("tdr-5b", "toolu_tc6", JSON.stringify({ task: { id: "6" } }), { parent: "toolu_t1" }),
      TOOL("td-9", "toolu_tu1", "TaskUpdate", { taskId: "1", status: "in_progress" }),
      TOOL("td-10", "toolu_tu2", "TaskUpdate", { taskId: "1", subject: "Write more tests", status: "" }),
      TOOL("td-11", "toolu_tu3", "TaskUpdate", { taskId: "x2", subject: "", status: "completed" }),
      TOOL("td-12", "toolu_tu4", "TaskUpdate", { taskId: "nope", status: "completed" }),
      TOOL("td-13", "toolu_tu5", "TaskUpdate", { taskId: 1, status: "completed" }),
      TOOL("td-14", "toolu_tu6", "TaskUpdate", { taskId: "", status: "completed" }),
      TOOL("td-15", "toolu_tu7", "TaskUpdate", { taskId: "t0", status: "deleted" }),
      TOOL("td-16", "toolu_tu8", "TaskUpdate", { taskId: "x2", status: 5, subject: 6 }),
      // A subagent's todo calls don't touch the rail.
      A("td-17", M("msg_TD17", [TU("toolu_sub_tw", "TodoWrite", { todos: [{ content: "sub" }] })]), { parent: "toolu_t1" }),
      TOOL("td-18", "toolu_tl1", "TaskList", {}),
      RES("tdr-6", "toolu_tl1", "#1 [completed] Write tests\n#2 [pending] Ship it"),
      TOOL("td-19", "toolu_tl2", "TaskList", {}),
      RES("tdr-7", "toolu_tl2", "No tasks found"),
      TOOL("td-20", "toolu_tl3", "TaskList", {}),
      RES("tdr-8", "toolu_tl3", "#9 [pending] x", { block: { is_error: true } }),
      RES("tdr-9", "toolu_nope", "#9 [pending] not a TaskList result"),
      TOOL("td-21", "toolu_tl4", "TaskList", {}),
      RES("tdr-10", "toolu_tl4", "   "),
      TOOL("td-22", "toolu_tw4", "TodoWrite", { todos: [{ id: "", content: "an empty id" }, { content: "second" }] }),
      TOOL("td-23", "toolu_tu9", "TaskUpdate", { taskId: "", status: "completed" }),
      TOOL("td-24", "toolu_tu10", "TaskUpdate", { taskId: "t1", status: "deleted", subject: "gone" }),
    ],
  },
  {
    name: "task-cron loops",
    steps: [
      ev(READY),
      TOOL("cr-1", "toolu_cr1", "CronCreate", { cron: "* * * * *", prompt: "check the build", recurring: true }, NOW + 500),
      TOOL("cr-1r", "toolu_cr1", "CronCreate", { cron: "* * * * *", prompt: "a replay" }, NOW + 900),
      RES("crr-1", "toolu_cr1", CRON_TEXT, {
        extra: { tool_use_result: { id: "1545ddb6", humanSchedule: "Every minute", recurring: true, durable: false, nextFireAt: NOW + 60000 } },
      }),
      TOOL("cr-1s", "toolu_cr1", "CronCreate", { cron: "* * * * *", prompt: "replayed after the promotion" }, NOW + 500),
      TOOL("cr-2", "toolu_cr2", "CronCreate", { cron: "0 9 * * 1", prompt: 5, recurring: "yes" }),
      RES("crr-2", "toolu_cr2", "Scheduled job ABC123 (Every Monday at 9am). Written to .claude/scheduled_tasks.json.", {
        extra: { tool_use_result: { nextFireAt: "soon" } },
      }),
      TOOL("cr-3", "toolu_cr3", "CronCreate", { cron: "*/5 * * * *", prompt: "p" }),
      RES("crr-3", "toolu_cr3", "Created a SESSION ONLY loop"),
      TOOL("cr-4", "toolu_cr4", "CronCreate", { cron: "0 0 * * *", prompt: "fail" }),
      RES("crr-4", "toolu_cr4", "Invalid cron", { block: { is_error: true } }),
      TOOL("cr-5", "toolu_cr5", "CronCreate", { cron: "", prompt: "no cron" }),
      TOOL("cr-6", "toolu_cr6", "CronCreate", { cron: 5 }),
      RES("crr-6", "toolu_cr6", "job zz (x)"),
      TOOL("cr-7", "toolu_cd1", "CronDelete", { id: "1545ddb6" }),
      TOOL("cr-8", "toolu_cd2", "CronDelete", { id: "nope" }),
      TOOL("cr-9", "toolu_cd3", "CronDelete", { id: 5 }),
      TOOL("cr-10", "toolu_cd4", "CronDelete", { id: "ABC123" }),
      TOOL("cr-11", "toolu_cr7", "CronCreate", { cron: "1 1 * * *", prompt: "multi" }),
      RES("crr-7", "toolu_cr7", "Scheduled JOB\tq9 (Every\nday) session only"),
      TOOL("cr-12", "toolu_cr8", "CronCreate", { cron: "2 2 * * *", prompt: "collide" }),
      RES("crr-8", "toolu_cr8", "Scheduled job ABC123 (Again)"),
      TOOL("cr-13", "toolu_cr9", "CronCreate", { cron: "3 3 * * *", prompt: "numeric" }),
      RES("crr-9", "toolu_cr9", "Scheduled job 42 (Hourly)"),
      TOOL("cr-14", "toolu_cr10", "CronCreate", { cron: "4 4 * * *", prompt: "no at" }),
      RES("crr-10", "toolu_cr10", "Scheduled job 7 (Daily)", { extra: { tool_use_result: { nextFireAt: NOW + 3600000 } } }),
      // A loop under an empty tool_use id: `CronDelete` needs a non-empty id.
      TOOL("cr-15", "", "CronCreate", { cron: "5 5 * * *", prompt: "empty id" }),
      TOOL("cr-16", "toolu_cd5", "CronDelete", { id: "" }),
      // A CronCreate whose tool_use id is another loop's cron id.
      TOOL("cr-17", "zz1", "CronCreate", { cron: "6 6 * * *", prompt: "first" }),
      RES("crr-17", "zz1", "Scheduled job zz9 (Weekly)"),
      TOOL("cr-18", "zz9", "CronCreate", { cron: "7 7 * * *", prompt: "second" }),
      TOOL("cr-19", "toolu_cr19", "CronCreate", { cron: "8 8 * * *", prompt: "tab" }),
      RES("crr-19", "toolu_cr19", "Scheduled job k7\t(Hourly)"),
    ],
  },
  {
    name: "task-wake-ups",
    steps: [
      ev(READY),
      TOOL("wk-1", "toolu_wk1", "ScheduleWakeup", { delaySeconds: 60, reason: "poll CI", prompt: "check CI" }, NOW + 1000),
      TOOL("wk-1r", "toolu_wk1", "ScheduleWakeup", { delaySeconds: 99 }, NOW + 5000),
      TOOL("wk-2", "toolu_wk2", "ScheduleWakeup", { delaySeconds: 120, noop: true, prompt: "again" }, NOW + 2000),
      TOOL("wk-3", "toolu_wk3", "ScheduleWakeup", { delaySeconds: 120, noop: true }, NOW + 3000),
      TOOL("wk-4", "toolu_wk4", "ScheduleWakeup", { delaySeconds: "5", reason: 7, prompt: 8, noop: "yes" }, NOW + 4000),
      RES("wkr-4", "toolu_wk4", "Scheduled job 9 (x)"),
      TOOL("wk-5", "toolu_cr1", "CronCreate", { cron: "* * * * *", prompt: "a cron beside" }, NOW + 4500),
      TOOL("wk-6", "toolu_stop1", "ScheduleWakeup", { stop: true }, NOW + 4600),
      TOOL("wk-7", "toolu_wk5", "ScheduleWakeup", { delaySeconds: 30, noop: true }, NOW + 7000),
      // An older wake-up armed again: the replayed stop below doesn't apply twice.
      TOOL("wk-7b", "toolu_wk9", "ScheduleWakeup", { delaySeconds: 15 }, NOW + 4000),
      TOOL("wk-6r", "toolu_stop1", "ScheduleWakeup", { stop: true }, NOW + 4600),
      TOOL("wk-8", "toolu_stop2", "ScheduleWakeup", { stop: true }, NOW + 6000),
      TOOL("wk-8b", "toolu_wk6", "ScheduleWakeup", { delaySeconds: 10, stop: "yes" }, NOW + 6500),
      TOOL("wk-9", "toolu_stop3", "ScheduleWakeup", { stop: true }),
      TOOL("wk-10", "toolu_wk7", "ScheduleWakeup", {}),
      TOOL("wk-11", "toolu_wk8", "ScheduleWakeup", { delaySeconds: 0, noop: true }),
    ],
  },
  {
    name: "task-task lifecycle",
    steps: [
      ev(READY),
      A("tk-a", M("msg_TKA", [TU("toolu_T1", "Task", { description: "Explore the repo", prompt: "look around", subagent_type: "Explore" })]), { at: NOW + 1000 }),
      SYS("task_started", "ts-1", {
        task_id: "task-1",
        tool_use_id: "toolu_T1",
        description: "Explore the repo",
        task_type: "local_agent",
        subagent_type: "Explore",
        spawn_depth: 1,
        prompt: "look around",
      }),
      A("tk-s1", M("msg_TKS1", [{ type: "text", text: "Looking" }], { model: "claude-haiku-4-5" }), { parent: "toolu_T1" }),
      A("tk-s2", M("msg_TKS2", [{ type: "text", text: "More" }], { model: "claude-opus-4-5" }), { parent: "toolu_T1" }),
      SYS("task_progress", "tp-1", {
        task_id: "task-1",
        tool_use_id: "toolu_T1",
        description: "Reading files",
        usage: { total_tokens: 1200, tool_uses: 3, duration_ms: 4000 },
        last_tool_name: "Read",
        summary: "Read 3 files",
      }),
      SYS("task_progress", "tp-2", { task_id: "task-1", usage: null }),
      SYS("task_progress", "tp-3", { task_id: "task-1", description: null, usage: { total_tokens: 1500 }, summary: null }),
      SYS("task_progress", "tp-4", { task_id: "task-unknown", description: "x", usage: { total_tokens: 1 } }),
      SYS("task_updated", "tu-1", { task_id: "task-1", patch: { status: "paused", total_paused_ms: 1500 } }),
      SYS("task_updated", "tu-2", { task_id: "task-1", patch: { status: "running", description: "Exploring", error: "warn", is_backgrounded: false } }),
      SYS("task_updated", "tu-3", { task_id: "task-1", patch: { status: null, end_time: NOW } }),
      SYS("task_updated", "tu-4", { task_id: "nope", patch: { status: "failed" } }),
      SYS("task_updated", "tu-5", { task_id: "nope" }),
      RES("tk-r1", "toolu_T1", "Found 12 files"),
      SYS("task_notification", "tn-1", {
        task_id: "task-1",
        tool_use_id: "toolu_T1",
        status: "completed",
        summary: "Explored",
        output_file: "/tmp/out.txt",
        usage: { total_tokens: 2000, tool_uses: 5, duration_ms: 9000 },
      }),
      // A repeat without usage keeps the counts.
      SYS("task_notification", "tn-1b", { task_id: "task-1", status: "completed" }),
      A("tk-b", M("msg_TKB", [TU("toolu_T2", "Task", { description: "Long job", prompt: "p", run_in_background: true })]), { at: NOW + 2000 }),
      SYS("task_started", "ts-2", {
        task_id: "task-2",
        tool_use_id: "toolu_T2",
        description: "Long job",
        task_type: "local_agent",
        is_backgrounded: true,
        ambient: false,
        skip_transcript: false,
      }),
      RES("tk-r2", "toolu_T2", "Started in background"),
      SYS("background_tasks_changed", "bg-1", {
        tasks: [
          { task_id: "task-2", task_type: "local_agent", description: "Long job" },
          { task_id: "task-ghost", task_type: "local_bash", description: "x", ambient: true },
          { task_id: "" },
          { task_id: 5 },
          { task_id: "task-2", task_type: "local_agent", description: "dup" },
        ],
      }),
      SYS("background_tasks_changed", "bg-2", { tasks: [{ task_id: "task-2", task_type: "local_agent", description: "Long job", ambient: true }] }),
      SYS("background_tasks_changed", "bg-3", { tasks: [{ task_id: "task-2", ambient: "yes" }, { task_id: "task-1", ambient: false }] }),
      SYS("background_tasks_changed", "bg-4", { tasks: [] }),
      SYS("background_tasks_changed", "bg-5", {}),
      SYS("background_tasks_changed", "bg-6", { tasks: {} }),
      SYS("background_tasks_changed", "bg-7", { tasks: [{ task_id: "task-2" }, null] }),
      SYS("background_tasks_changed", "bg-8", { tasks: null }),
      SYS("task_notification", "tn-2", {
        task_id: "task-2",
        status: "stopped",
        reason: "worker_restart",
        summary: "Stopped",
        ambient: true,
        resource_links: [{ uri: "file:///tmp/a.txt", name: "a.txt", mimeType: "text/plain", size: 12 }],
        output_file: "/tmp/2.txt",
      }),
      // A later notification without them keeps what the task has.
      SYS("task_notification", "tn-2b", { task_id: "task-2", status: "killed" }),
      SYS("task_notification", "tn-3", { task_id: "task-3", tool_use_id: "toolu_T3", status: "failed", output_file: "/tmp/3.txt" }),
      SYS("task_notification", "tn-4", { task_id: "task-4", status: "completed", summary: "Monitor said hi", ambient: true, usage: null }),
      // The Task's result landed before its task_started: the status is seeded.
      A("tk-c", M("msg_TKC", [TU("toolu_T5", "Agent", { description: "Quick", prompt: "q" })]), { at: NOW + 3000 }),
      RES("tk-r5", "toolu_T5", "Gave up", { block: { is_error: true } }),
      SYS("task_started", "ts-5", { task_id: "task-5", tool_use_id: "toolu_T5", description: "Quick" }),
      A("tk-d", M("msg_TKD", [TU("toolu_T6", "Agent", { description: "Bg", prompt: "q", run_in_background: true })]), { at: NOW + 3500 }),
      RES("tk-r6", "toolu_T6", "Started"),
      SYS("task_started", "ts-6", { task_id: "task-6", tool_use_id: "toolu_T6" }),
      // A Workflow's provisional row hands over to the real task.
      A("tk-w", M("msg_TKW", [TU("toolu_W1", "Workflow", { script: "export const meta = { name: 'nightly', description: 'Nightly checks' };" })]), { at: NOW + 4000 }),
      RES("tk-rw", "toolu_W1", "Workflow started in background. runId: run-1"),
      SYS("task_started", "ts-w", {
        task_id: "task-w",
        tool_use_id: "toolu_W1",
        description: "Nightly checks",
        task_type: "local_workflow",
        workflow_name: "nightly",
        is_backgrounded: true,
      }),
      TOOL("tk-w2", "toolu_W2", "Workflow", { script: "export const meta = { name: 'lint' };" }),
      RES("tk-rw2", "toolu_W2", "started"),
      SYS("task_notification", "tn-w2", { task_id: "task-w2", tool_use_id: "toolu_W2", status: "completed", summary: "Lint clean" }),
      SYS("task_started", "ts-1b", { task_id: "task-1", tool_use_id: "toolu_T1", description: null }),
      SYS("task_started", "ts-7", { task_id: "7", description: "an index-like id" }),
      // An empty `tool_use_id` looks nothing up, even with a settled block.
      TOOL("tk-e", "", "Agent", { description: "empty id", prompt: "q" }),
      RES("tk-re", "", "done"),
      SYS("task_started", "ts-e", { task_id: "task-e", tool_use_id: "", description: "empty id" }),
      INIT("tk-init"),
    ],
  },
  {
    name: "task-task_snapshot",
    steps: [
      ev(READY),
      A("sn-a", M("msg_SNA", [TU("toolu_S1", "Task", { description: "Live task", prompt: "p" })]), { at: NOW + 1000 }),
      SYS("task_started", "sn-ts", { task_id: "task-live", tool_use_id: "toolu_S1", description: "Live task" }),
      A("sn-sub", M("msg_SNSUB", [{ type: "text", text: "live inner" }]), { parent: "toolu_S1" }),
      A("sn-w", M("msg_SNW", [TU("toolu_SW", "Workflow", { script: "export const meta = { name: 'w' };" })]), { at: NOW + 1500 }),
      RES("sn-rw", "toolu_SW", "started"),
      // An empty trail (a subagent `message_stop` on an unknown scope).
      E("sn-stop", { type: "message_stop" }, { parent: "toolu_EMPTY" }),
      // A bubble that already has a stand-in's uuid.
      UM("recovered-task-toolu_Z", "a clash", { at: NOW + 1600 }),
      // A Workflow ack under the empty tool_use id seeds a placeholder that
      // the empty-`toolUseId` entry below leaves alone.
      A("sn-we", M("msg_SNWE", [TU("", "Workflow", { script: "export const meta = { name: 'e' };" })]), { at: NOW + 1700 }),
      RES("sn-rwe", "", "started"),
      ev(REPLAYED),
      SNAP([
        { taskId: "task-live", toolUseId: "toolu_S1", description: "Stale copy", status: "completed", innerMessages: INNER("toolu_S1") },
        {
          taskId: "task-sw",
          toolUseId: "toolu_SW",
          description: "Workflow w",
          taskType: "local_workflow",
          workflowName: "w",
          status: "running",
          isBackgrounded: true,
          innerMessages: [],
        },
        {
          taskId: "task-old",
          toolUseId: "toolu_OLD",
          description: "Compacted away",
          taskType: "local_agent",
          status: "completed",
          totalTokens: 900,
          toolUses: 2,
          durationMs: 3000,
          summary: "Did it",
          outputFile: "/tmp/o.txt",
          spawnDepth: 1,
          ambient: false,
          innerMessages: INNER("toolu_OLD"),
        },
        {
          taskId: "task-oldwf",
          toolUseId: "toolu_OLDWF",
          taskType: "local_workflow",
          workflowName: "nightly",
          status: "failed",
          error: "boom",
          summary: "Failed",
          innerMessages: [],
        },
        { taskId: "task-oldwf2", toolUseId: "toolu_OLDWF2", taskType: "local_workflow", status: "stopped", reason: "worker_restart", innerMessages: [] },
        { taskId: "task-run", toolUseId: "toolu_RUN", description: "Still running", status: "running", innerMessages: INNER("toolu_RUN") },
        { taskId: "task-bare", status: "completed", innerMessages: INNER("toolu_BARE") },
        { taskId: "task-nostatus", toolUseId: "toolu_NS", description: null, innerMessages: [] },
        {
          taskId: "task-links",
          toolUseId: "toolu_S1",
          status: "completed",
          resourceLinks: [{ uri: "file:///x", name: "x", title: "X", description: "an x", mimeType: "text/plain", size: 3 }],
          innerMessages: INNER("toolu_LINK"),
        },
        { taskId: "task-dup", toolUseId: "toolu_OLD", status: "killed", summary: "dup pill", innerMessages: [] },
        { taskId: "5", toolUseId: "toolu_IDX", status: "completed", description: "an index-like id", innerMessages: [{ message: { type: "user", uuid: "x", message: { content: "" } } }] },
        { taskId: "task-empty-id", toolUseId: "", status: "completed", innerMessages: INNER("toolu_E") },
        { taskId: "task-empty-trail", toolUseId: "toolu_EMPTY", status: "running", innerMessages: INNER("toolu_EMPTY") },
        { taskId: "task-z", toolUseId: "toolu_Z", status: "completed", innerMessages: [] },
      ]),
      SNAP([{ taskId: "task-old", toolUseId: "toolu_OLD", status: "completed", innerMessages: INNER("toolu_OLD") }]),
      SNAP([]),
      RES("sn-r-old", "toolu_OLD", "late result"),
    ],
  },
  {
    name: "task-todos_auto_cleared and the todo actions",
    routes: [
      [
        "POST",
        "^/api/sessions/[^/]+/clear-todos$",
        [
          { status: 200, body: { ok: true } },
          { status: 503, body: { error: "stale session instance" } },
          { status: 500, text: "not json" },
          { status: 500, text: "null" },
          { status: 500, body: { error: 5 } },
          { status: 500, body: { error: null } },
          { reject: "Failed to fetch" },
          { status: 404, body: { error: { code: 1 } } },
          { status: 500, body: { error: ["a", null, "b"] } },
          { status: 500, body: { error: { toString: 5 } } },
          { status: 500, text: "\ufeff{\"error\":\"bom\"}" },
          { status: 500, text: "\"just a string\"" },
        ],
      ],
      [
        "POST",
        "^/api/sessions/[^/]+/todos/",
        [
          { status: 200, body: { ok: true } },
          { status: 422, body: { error: "stale list" } },
          { status: 500, text: "" },
          { status: 500, body: { error: 7 } },
          { status: 500, text: "null" },
          { reject: "Failed to fetch" },
          { status: 201, text: "" },
          { status: 400, body: { error: { why: "x" } } },
          { status: 400, body: { error: { toString: 1 } } },
          { status: 500, body: { error: false } },
        ],
      ],
    ],
    steps: [
      ev(READY),
      ev({ type: "todos_auto_cleared", reason: "completed", count: 3 }),
      { ...ev({ type: "todos_auto_cleared", reason: "stale", count: 5 }), dt: 0 },
      { ...ev({ type: "todos_auto_cleared" }), dt: 0 },
      ev({ type: "todos_auto_cleared", reason: 5, count: "x" }),
      call("dismissTodosAutoCleared"),
      call("dismissTodosAutoCleared"),
      { ...ev({ type: "todos_auto_cleared", reason: "completed", count: 1 }), dt: 0 },
      call("clearTodos"),
      call("clearTodos"),
      call("clearTodos"),
      call("clearTodos"),
      call("clearTodos"),
      call("clearTodos"),
      call("clearTodos"),
      call("clearTodos"),
      call("clearTodos"),
      call("clearTodos"),
      call("clearTodos"),
      call("clearTodos"),
      callR("updateTodoItem", "t0", "complete"),
      callR("updateTodoItem", "1", "reopen"),
      callR("updateTodoItem", "1", "in_progress"),
      callR("updateTodoItem", "a b/c?d#e", "delete"),
      callR("updateTodoItem", "t1", "complete"),
      callR("updateTodoItem", "t1", "complete"),
      callR("updateTodoItem", "t1", "complete"),
      callR("updateTodoItem", "t1", "complete"),
      callR("updateTodoItem", "t1", "complete"),
      callR("updateTodoItem", "t1", "complete"),
      callR("updateTodoItem", LONE_HI, "reopen"),
      ev({ type: "session_snapshot", todos: [] }),
    ],
  },
);

// ---- U01n / U01j: account move, the effort-wait read, the queue mirror and
// the send actions (`queue-` scenarios). A promise-valued action's step
// (`callR`) records what it resolved to as `resolved`.

const Q = (queue, extra = {}) => ev({ type: "queue:updated", sessionId: SID, queue, ...extra });
const QROW = (uuid, text, extra = {}) => ({ uuid, text, createdAtMs: NOW, ...extra });
const PNG = { data: "iVBORw0KGgo=", mediaType: "image/png" };
const ACCOUNT_URL = "^/api/sessions/[^/]+/account$";
const INPUT_URL = "^/api/sessions/[^/]+/input$";
const QUEUE_ROW_URL = "^/api/sessions/[^/]+/queue/[^/]+$";

scenarios.push(
  {
    name: "queue-moveToActiveAccount",
    routes: [
      [
        "POST",
        ACCOUNT_URL,
        [
          { status: 200, body: { ok: true, account: { id: "acc_2", label: "Work" }, restarted: true } },
          { status: 400, body: { error: "no active account profile configured" } },
          { status: 404, body: { error: "session not found" } },
          { status: 500, text: "oops" },
          { status: 409, body: { error: 5 } },
          { status: 409, body: { error: { code: "x" } } },
          { status: 503, body: { error: null } },
          { status: 502, text: "null" },
          { status: 500, text: "\"just a string\"" },
          { reject: "Failed to fetch" },
          { status: 201, text: "" },
          { status: 200, text: "not json" },
        ],
      ],
    ],
    steps: [
      ev({ ...READY, account: ACCOUNT }),
      ...Array.from({ length: 12 }, () => callR("moveToActiveAccount")),
      // The server restarts the query: the fresh `ready` carries the account.
      ev({ ...READY, account: { id: "acc_2", label: "Work" } }),
    ],
  },
  {
    name: "queue-effortChangeWouldWait",
    routes: [["POST", "^/api/sessions/[^/]+/effort$", { status: 200, body: { ok: true } }]],
    steps: [
      ev(READY),
      callR("effortChangeWouldWait", "high"),
      ev(RUNNING),
      callR("effortChangeWouldWait", "high"),
      callR("effortChangeWouldWait", "auto"),
      ev({ type: "effort_applied", effort: "high" }),
      callR("effortChangeWouldWait", "high"),
      callR("effortChangeWouldWait", "low"),
      call("setEffort", "low"),
      callR("effortChangeWouldWait", "low"),
      callR("effortChangeWouldWait", "high"),
      callR("effortChangeWouldWait", "max"),
      ev({ type: "effort_applied", effort: null }),
      callR("effortChangeWouldWait", "max"),
      ev(IDLE),
      callR("effortChangeWouldWait", "max"),
    ],
  },
  {
    name: "queue-queue:updated snapshots",
    steps: [
      Q([QROW("q-0", "before ready")], { sdkQueuedTurns: 1 }),
      ev(READY),
      Q(
        [
          QROW("q-1", "first"),
          QROW("q-2", "second \u00e9 \u2713", { hasImages: true, slash: true, fromSuggestion: true, fromGoal: true }),
          QROW("q-3", "falsy flags", { hasImages: 0, slash: "", fromSuggestion: "yes", fromGoal: null }),
        ],
        { sdkQueuedTurns: 2 },
      ),
      Q([QROW("q-1", "first")]),
      Q([QROW("q-1", "first")], { sdkQueuedTurns: null }),
      Q([QROW("q-1", "first")], { sdkQueuedTurns: "3" }),
      Q([5, "s", [], {}, { uuid: 7, text: null }, { text: "no id" }, { uuid: "only-id" }]),
      Q([QROW("q-4", "kept")], { sdkQueuedTurns: 4 }),
      ev({ type: "queue:updated", sessionId: SID }),
      ev({ type: "queue:updated", sessionId: SID, queue: null, sdkQueuedTurns: 9 }),
      ev({ type: "queue:updated", sessionId: SID, queue: "abc" }),
      ev({ type: "queue:updated", sessionId: SID, queue: { 0: QROW("q-5", "obj") } }),
      Q([QROW("q-6", "fine"), null], { sdkQueuedTurns: 9 }),
      Q([], { sdkQueuedTurns: 0 }),
    ],
  },
  {
    name: "queue-send runs or queues",
    routes: [
      [
        "POST",
        INPUT_URL,
        [
          { status: 200, body: { ok: true, queued: false, uuid: "x" } },
          { status: 200, body: { ok: true, queued: true, uuid: "x" } },
          { status: 200, body: { ok: true, queued: false } },
          { status: 200, body: { ok: true, queued: false } },
          { status: 200, body: { ok: true, queued: false } },
          { status: 200, body: { ok: true, queued: false } },
          { status: 200, body: { ok: true, queued: false } },
          { status: 200, body: { ok: true, queued: false } },
          { status: 200, text: "not json" },
          { status: 200, text: "null" },
          { status: 202, body: { queued: 1 } },
          { status: 200, body: { queued: "" } },
          { status: 200, text: "\ufeff{\"queued\":true}" },
          { status: 200, body: { ok: true, queued: true } },
        ],
      ],
    ],
    steps: [
      ev(READY),
      ev({ type: "session_recap", text: "We were fixing the build.", at: NOW, origin: "away" }),
      S({ type: "prompt_suggestion", suggestion: "Run the tests", uuid: "ps-1" }),
      ev({ type: "error", message: "boom", sessionEnded: true }),
      callR("send", "  hello  "),
      callR("send", "queued one"),
      Q([QROW("00000000-0000-4000-8000-000000000002", "queued one")]),
      callR("send", "/compact", null, { asSlashCommand: true }),
      callR("send", "with images", [PNG, { id: "img-2", ordinal: 7, data: "R0lGOD", mediaType: "image/gif" }]),
      callR("send", "", [{ ...PNG, ordinal: "3" }]),
      callR("send", "suggested", null, { fromSuggestion: true }),
      callR("send", "for the goal", null, { fromGoal: true, inlinePastes: ["pasted block"] }),
      callR("send", "no pastes", null, { inlinePastes: [], reportsFailureInline: true }),
      callR("send", "   "),
      callR("send", "", []),
      callR("send", " \n"),
      callR("send", "non-JSON reply"),
      callR("send", "null reply"),
      callR("send", "queued: 1"),
      callR("send", "queued: empty"),
      callR("send", "BOM reply"),
      callR("send", "/queued slash", null, { asSlashCommand: true }),
      ev(RUNNING),
    ],
  },
  {
    name: "queue-send failures",
    routes: [
      [
        "POST",
        INPUT_URL,
        [
          { reject: "Failed to fetch" },
          { reject: "Failed to fetch" },
          { reject: "Failed to fetch" },
          { status: 500, body: { error: "internal" } },
          { status: 503, body: { error: "The session's process ended and could not be restarted" } },
          { status: 503, text: "not json" },
          { status: 503, body: { error: "" } },
          { status: 503, body: { error: 5 } },
          { status: 503, text: "null" },
          { status: 503, body: { error: ["a", "b"] } },
          { status: 400, body: { error: "text or images required" } },
          { status: 404, text: "" },
        ],
      ],
    ],
    steps: [
      ev(READY),
      ev({ type: "error", message: "earlier", sessionEnded: true }),
      callR("send", "offline"),
      callR("send", "offline inline", null, { reportsFailureInline: true }),
      callR("send", "/offline slash", null, { asSlashCommand: true }),
      callR("send", "500"),
      callR("send", "503 with a reason"),
      callR("send", "503 non-JSON"),
      callR("send", "503 empty error"),
      callR("send", "503 numeric error"),
      callR("send", "503 null body"),
      callR("send", "503 array error"),
      callR("send", "400"),
      callR("send", "404", [PNG]),
    ],
  },
  {
    name: "queue-enqueue",
    routes: [
      [
        "POST",
        INPUT_URL,
        [
          { status: 200, body: { ok: true, queued: true, uuid: "srv-1" } },
          { status: 200, body: { ok: true, queued: true } },
          { status: 200, text: "not json" },
          { status: 500, body: { error: "x" } },
          { status: 404, body: { error: "session not found" } },
          { reject: "Failed to fetch" },
        ],
      ],
    ],
    steps: [
      ev(READY),
      ev(RUNNING),
      callR("enqueue", "  staged  "),
      callR("enqueue", "", [{ id: "img-1", ordinal: 1, ...PNG }]),
      callR("enqueue", "with images", [{ id: "img-1", ordinal: 1, ...PNG }, { id: "img-2", ordinal: 2, ...PNG }]),
      callR("enqueue", "500"),
      callR("enqueue", "404"),
      callR("enqueue", "offline"),
      callR("enqueue", "  "),
      callR("enqueue", "", []),
      Q([QROW("srv-1", "staged")]),
    ],
  },
  {
    name: "queue-cancel, edit, reorder and send now",
    routes: [
      [
        "DELETE",
        QUEUE_ROW_URL,
        [
          { status: 200, body: { text: "cancelled row" } },
          { reject: "Failed to fetch" },
          { status: 404, body: { error: "not found" } },
          { status: 200, body: { text: "edit me", images: [{ id: "img-1", ordinal: 1, ...PNG }] } },
          { status: 200, body: { text: "no images", images: [] } },
          { status: 200, body: { text: "string images", images: "ab" } },
          { status: 200, body: { text: "numeric images", images: 5 } },
          { status: 200, body: { text: "" } },
          { status: 200, body: { text: 5 } },
          { status: 200, text: "null" },
          { status: 200, text: "\"edit me\"" },
          { status: 200, text: "not json" },
          { status: 404, body: { text: "not found" } },
          { reject: "Failed to fetch" },
        ],
      ],
      [
        "POST",
        "^/api/sessions/[^/]+/queue/[^/]+/move$",
        [{ status: 200, body: { ok: true } }, { status: 200, body: { ok: true } }, { status: 404, body: { error: "x" } }, { reject: "Failed to fetch" }],
      ],
      ["POST", "^/api/sessions/[^/]+/queue/[^/]+/send-now$", [{ status: 200, body: { ok: true } }, { reject: "Failed to fetch" }]],
      ["POST", "^/api/sessions/[^/]+/queue/send-all$", [{ status: 200, body: { ok: true, sent: 2 } }, { reject: "Failed to fetch" }]],
    ],
    steps: [
      ev(READY),
      Q([QROW("q-1", "one"), QROW("q-2", "two"), QROW("q-3", "three")]),
      call("cancelQueued", "q-1"),
      call("cancelQueued", "q-1"),
      call("cancelQueued", "q 9"),
      Q([QROW("q-2", "two"), QROW("q-3", "three")]),
      ...[
        "q-2",
        "q-2",
        "q-2",
        "q-2",
        "q-3",
        "q-3",
        "q-3",
        "q-3",
        "q-3",
        "q-3",
        "q-3",
      ].map((q) => callR("editQueued", q)),
      call("reorderQueued", "q-3", -1),
      call("reorderQueued", "q-3", 1),
      call("reorderQueued", "q-3", 0),
      call("reorderQueued", "q-3", -1),
      call("sendQueuedNow", "q-3"),
      call("sendQueuedNow", "q-3"),
      call("sendAllQueuedNow"),
      call("sendAllQueuedNow"),
      Q([], { sdkQueuedTurns: 2 }),
    ],
  },
  {
    name: "queue-interrupt and takeOver",
    routes: [
      [
        "POST",
        "^/api/sessions/[^/]+/interrupt$",
        [
          { status: 200, body: { ok: true, stillQueued: [] } },
          { status: 200, body: { ok: true, stillQueued: ["u-1"] } },
          { status: 200, body: { ok: true, stillQueued: ["u-1", "u-2", 5, null] } },
          { status: 200, body: { ok: true, stillQueued: "u-1" } },
          { status: 500, body: { error: "x", stillQueued: ["u-1", "u-2"] } },
          { status: 200, text: "not json" },
          { status: 200, text: "null" },
          { status: 404, body: { error: "session not found" } },
          { reject: "Failed to fetch" },
        ],
      ],
      [
        "PATCH",
        "^/api/sessions/[^/]+/holder$",
        [{ status: 200, body: { ok: true, holderId: "x" } }, { reject: "Failed to fetch" }, { status: 400, body: { error: "tabId required" } }],
      ],
    ],
    steps: [
      ev(READY),
      A("int-1", M("msg_INT", [{ type: "text", text: "working" }]), { at: NOW + 2000 }),
      ...Array.from({ length: 9 }, () => [ev(RUNNING), call("interrupt")]).flat(),
      ev({ type: "holder_changed", holderId: "other-tab" }),
      call("takeOver"),
      ({ tabId }) => ev({ type: "holder_changed", holderId: tabId }),
      call("takeOver"),
      call("takeOver"),
    ],
  },
  {
    name: "queue-renameTitle",
    routes: [
      [
        "POST",
        "^/api/sessions/rename$",
        [
          { status: 200, body: { ok: true } },
          { status: 500, body: { error: "rename failed" } },
          { status: 400, body: { error: null } },
          { status: 500, text: "null" },
          { status: 500, text: "nope" },
          { reject: "Failed to fetch" },
          { status: 409, body: { error: 5 } },
          { status: 201, text: "" },
        ],
      ],
    ],
    steps: [
      ev(READY),
      ev({ type: "session_title", title: "Server title" }),
      callR("renameTitle", "  New name \u00e9 "),
      ev({ type: "session_title", title: "New name \u00e9" }),
      ...["500", "400", "null body", "non-JSON", "offline", "409"].map((t) => callR("renameTitle", t)),
      callR("renameTitle", "   "),
      callR("renameTitle", "\u00a0\ufeff\n"),
      callR("renameTitle", "201"),
    ],
  },
  {
    name: "queue-setGoal and clearGoal",
    routes: [
      [
        "POST",
        "^/api/sessions/[^/]+/goal$",
        [
          { status: 200, body: { ok: true, goal: "x" } },
          { status: 500, body: { error: "no" } },
          { status: 200, body: { ok: true } },
          { status: 404, body: { error: "session not found" } },
          { status: 200, body: { ok: true } },
          { status: 500, text: "null" },
          { reject: "Failed to fetch" },
          { status: 400, body: { error: 5 } },
          { status: 200, body: { ok: true } },
        ],
      ],
    ],
    steps: [
      ev(READY),
      ev({ type: "goal_changed", goal: "Ship it", achieved: true, summary: "done", setAt: NOW, achievedAt: NOW + 5 }),
      callR("setGoal", "  Fix the build  "),
      callR("setGoal", "fails"),
      callR("clearGoal"),
      callR("setGoal", "Restore"),
      callR("clearGoal"),
      callR("setGoal", "Again"),
      callR("setGoal", "   "),
      callR("setGoal", "offline"),
      callR("clearGoal"),
      callR("setGoal", "\n\t"),
      ev({ type: "goal_changed", goal: "Server goal", setAt: NOW + 9 }),
    ],
  },
  {
    name: "queue-submitFeedback",
    routes: [
      [
        "POST",
        "^/api/feedback$",
        [
          { status: 200, body: { ok: true, stored: true, forwarded: true } },
          { status: 200, body: { ok: true, stored: true, forwarded: false, reason: "Your organization doesn't accept feedback" } },
          { status: 200, body: { reason: "" } },
          { status: 200, body: { reason: 5, forwarded: "yes" } },
          { status: 200, text: "not json" },
          { status: 200, text: "null" },
          { status: 200, body: { ok: false, stored: 0, forwarded: null } },
          { status: 409, body: { ok: false, stored: false, forwarded: false, reason: "session-unavailable" } },
          { status: 400, body: { error: "empty feedback", stored: true, forwarded: "y" } },
          { status: 500, text: "x" },
          { status: 500, text: "null" },
          { reject: "Failed to fetch" },
        ],
      ],
    ],
    steps: [
      ev(READY),
      ev({ type: "feedback_survey", sessionId: "sess-1", surface: "post_turn" }),
      callR("submitFeedback", { rating: "up", comment: "great", attachTranscript: true }),
      callR("submitFeedback", { comment: "only a comment" }),
      callR("submitFeedback", { rating: "down", comment: "", attachTranscript: false }),
      ...Array.from({ length: 9 }, (_, i) => callR("submitFeedback", { rating: "up", comment: `try ${i}` })),
      call("dismissFeedback"),
    ],
  },
);

// ---- U01k: mount, boot, switch / create and the stream lifecycle ----
// A scenario may set the page `url`, preset `storage` (sessionStorage), a
// `defaultCwd`, `bootRoutes` (the prelude's routes, before the defaults),
// `noOpen` (the prelude's stream stays connecting) and `noStream` (the
// boot binds nothing). Steps add `es: "open" | "error"` (with the
// `readyState` `onerror` sees), `visibility: "hidden" | "visible"` (a
// `visibilitychange`), `source` (which EventSource, by index), `pathname`
// (a re-render on another route), `navIntent` (`markNavigating()`) and
// `pushState` (the router moved the page).
const POST_SESSIONS = "^/api/sessions$";
const created = (id, cwd) => ({ status: 200, body: cwd === undefined ? { id } : { id, cwd } });
const MARKER = "claudius:boot-pending";
const marker = (id, at, load) => JSON.stringify({ id, at, load });
const esOpen = (o = {}) => ({ es: "open", ...o });
const esError = (readyState, o = {}) => ({ es: "error", readyState, ...o });
const onSource = (source, step) => ({ ...step, source });
const FRESH_URL = "http://localhost:3000/";

scenarios.push(
  {
    name: "life-boot resumes ?session= at ?at=",
    url: "http://localhost:3000/?session=sess-1&at=u-7",
    steps: [ev(READY), ev(REPLAYED)],
  },
  {
    name: "life-boot asks for the last active tab",
    url: FRESH_URL,
    bootRoutes: [
      ["GET", "^/api/sessions/open-tabs$", { status: 200, body: { activeId: "sess-7" } }],
      ["POST", POST_SESSIONS, created("sess-7", "/work/seven")],
      ["GET", "^/api/sessions/sess-7/advisor$", { status: 200, body: { model: "claude-opus-4-5" } }],
      ["GET", "^/api/sessions/sess-7/suggested-messages$", { status: 200, body: { uuids: ["u-1", "u-2"] } }],
      ["GET", "^/api/sessions/sess-7/goal-messages$", { status: 200, body: { uuids: ["g-1"] } }],
    ],
    steps: [ev({ ...READY, sessionId: "sess-7" }), ev(REPLAYED)],
  },
  {
    name: "life-boot creates fresh without an active tab",
    url: FRESH_URL,
    defaultCwd: "/work/default",
    steps: [ev(READY), ev(REPLAYED)],
  },
  ...[
    ["a failed lookup", { reject: "Failed to fetch" }],
    ["a 500 lookup", { status: 500, body: { activeId: "sess-9" } }],
    ["a lookup that isn't JSON", { status: 200, text: "nope" }],
    ["a null lookup", { status: 200, text: "null" }],
    ["a numeric activeId", { status: 200, body: { activeId: 5 } }],
    ["an empty activeId", { status: 200, body: { activeId: "" } }],
  ].map(([what, reply]) => ({
    name: `life-boot creates fresh after ${what}`,
    url: FRESH_URL,
    bootRoutes: [["GET", "^/api/sessions/open-tabs$", reply]],
    steps: [],
  })),
  {
    name: "life-boot ?new=1 strips the session params",
    url: "http://localhost:3000/?new=1&session=sess-1&at=u-1&tab=a%20b&x=%E2%9C%93&y=1+2#frag",
    steps: [ev(READY)],
  },
  {
    name: "life-boot ?new=1 alone",
    url: "http://localhost:3000/wks_ab12?new=1",
    defaultCwd: "",
    steps: [],
  },
  {
    name: "life-boot guard skips a crash-looping session",
    url: "http://localhost:3000/?session=sess-1&at=u-3&keep=1",
    storage: { [MARKER]: marker("sess-1", NOW - 60_000, NOW - 900_000) },
    bootRoutes: [["POST", POST_SESSIONS, created("sess-2", "/work/proj")]],
    routes: [["POST", POST_SESSIONS, created("sess-x")]],
    steps: [
      ev({ ...READY, sessionId: "sess-2" }),
      // The marker names the skipped session, so the fresh replay keeps it.
      ev(REPLAYED),
      call("openSkippedBootSession"),
      call("switchSession", "sess-1"),
      esOpen(),
      ev(REPLAYED),
      // The notice went for good once another session was bound.
      call("switchSession", "sess-2"),
      call("openSkippedBootSession"),
    ],
  },
  {
    name: "life-boot guard is dismissed",
    storage: { [MARKER]: marker("sess-1", NOW - 60_000, NOW - 900_000) },
    bootRoutes: [["POST", POST_SESSIONS, created("sess-2")]],
    steps: [call("dismissSkippedBootSession"), call("openSkippedBootSession")],
  },
  {
    name: "life-boot guard is forced open",
    storage: { [MARKER]: marker("sess-1", NOW - 60_000, NOW - 900_000), "claudius:boot-force": "sess-1" },
    steps: [ev(READY), ev(REPLAYED)],
  },
  {
    name: "life-boot guard ignores an expired marker",
    storage: { [MARKER]: marker("sess-1", NOW - 31 * 60_000, NOW - 900_000) },
    steps: [ev(REPLAYED)],
  },
  {
    name: "life-boot guard drops the notice when the create fails",
    storage: { [MARKER]: marker("sess-1", NOW - 60_000, NOW - 900_000) },
    bootRoutes: [["POST", POST_SESSIONS, { reject: "Failed to fetch" }]],
    noStream: true,
    steps: [],
  },
  {
    name: "life-create failures",
    url: FRESH_URL,
    bootRoutes: [["POST", POST_SESSIONS, { reject: "Failed to fetch" }]],
    noStream: true,
    routes: [
      [
        "POST",
        POST_SESSIONS,
        [
          { status: 500, body: { error: "spawn failed", name: "Error" } },
          { status: 503, body: {} },
          { status: 502, body: { error: "  " } },
          { status: 404, body: { error: "  not here  " } },
          { status: 400, text: "nope" },
          { status: 409, body: { error: 5, name: "Conflict" } },
          { status: 422, body: { error: 5 } },
          { status: 403, body: { error: ["a", "b"], name: { n: 1 } } },
          { status: 401, text: "null" },
          { status: 200, text: "not json" },
          { status: 200, text: "" },
          { status: 200, text: "null" },
          { status: 201, body: { id: "sess-3", cwd: 7 } },
        ],
      ],
    ],
    steps: [
      ...Array.from({ length: 12 }, () => callR("createNewSession")),
      callR("createNewSession"),
      esOpen(),
      ev({ ...READY, sessionId: "sess-3" }),
    ],
  },
  {
    name: "life-createNewSession, createSessionAt and drafts",
    defaultCwd: "/work/default",
    routes: [
      [
        "POST",
        POST_SESSIONS,
        [created("sess-2", "/work/two"), created("sess-3", ""), created("sess-4"), created("sess-5", "/w/5")],
      ],
    ],
    steps: [
      ev(READY),
      ev(REPLAYED),
      callR("createNewSession"),
      esOpen(),
      ev({ ...READY, sessionId: "sess-2" }),
      call("createSessionAt", "/tmp/x"),
      call("createNewSessionWithDraft", "draft text"),
      call("createNewSessionWithDraft", ""),
      callR("refreshSessions"),
    ],
  },
  {
    name: "life-switchSession",
    routes: [["POST", POST_SESSIONS, [created("sess-ignored"), { reject: "Failed to fetch" }, { status: 500, text: "x" }]]],
    steps: [
      ev(READY),
      ev(RUNNING),
      ev(REPLAYED),
      call("switchSession", "sess-1"),
      call("switchSession", "sess-2"),
      esOpen(),
      ev({ ...READY, sessionId: "sess-2" }),
      // The old socket's late callbacks: its session isn't bound any more.
      onSource(0, ev({ type: "session_title", title: "from the old stream" })),
      onSource(0, esError(2)),
      onSource(0, esOpen()),
      ev(REPLAYED),
      // A failed wake POST still binds.
      call("switchSession", "sess-1"),
      call("switchSession", "sess-3"),
      esOpen(),
      ev(REPLAYED),
    ],
  },
  {
    name: "life-the browser reconnects a dropped stream",
    steps: [
      ev(READY),
      ev(REPLAYED),
      ev(RUNNING),
      esError(0),
      // Back within the badge's 4 s: no badge, no rebuild.
      esOpen(),
      esError(0),
      wait(5000),
      esError(0, { dt: 5000 }),
      esError(1),
      // Down 16 s: the transcript is rebuilt from the replay.
      esOpen({ dt: 5000 }),
      ev(READY),
      ev(REPLAYED),
      esError(0),
      esOpen({ dt: 14_000 }),
    ],
  },
  {
    name: "life-a closed stream is rebuilt with backoff",
    routes: [["POST", POST_SESSIONS, created("sess-2")]],
    steps: [
      ev(READY),
      ev(REPLAYED),
      ev(RUNNING),
      esError(2),
      // 1 s, then the rebind.
      wait(1000),
      esError(2),
      wait(2000),
      esError(2),
      wait(3000),
      wait(1000),
      esOpen(),
      ev(READY),
      ev(REPLAYED),
      // The backoff starts over once a socket opened.
      esError(2),
      esError(2),
      // A switch takes over: its bind disarms the retry.
      call("switchSession", "sess-2"),
      wait(2000),
      esOpen(),
    ],
  },
  {
    name: "life-visibility revives a dead stream",
    routes: [["GET", "^/api/sessions$", [sessionsAs("idle")]]],
    steps: [
      ev(READY),
      ev(REPLAYED),
      ev(RUNNING),
      { visibility: "visible" },
      ev(RUNNING),
      { visibility: "hidden" },
      esError(2),
      { visibility: "hidden", dt: 200 },
      { visibility: "visible", dt: 200 },
      esOpen(),
      esError(0),
      { visibility: "visible" },
      esOpen(),
    ],
  },
  {
    name: "life-a stale socket of the same session still applies",
    steps: [
      ev(READY),
      ev(REPLAYED),
      esError(2),
      wait(1000),
      onSource(0, ev({ type: "session_title", title: "late but applied" })),
      onSource(0, esOpen()),
      esOpen(),
      ev(READY),
      onSource(0, esError(0)),
      onSource(1, esError(2)),
    ],
  },
  {
    name: "life-a ?prompt= seed waits for the turn",
    url: "http://localhost:3000/?session=sess-1&prompt=hello%20there",
    routes: [["POST", "^/api/sessions/[^/]+/input$", { status: 200, body: { ok: true } }]],
    steps: [{ ...ev(RUNNING), dt: 100 }, wait(500), wait(500), ev(IDLE), wait(500)],
  },
  {
    name: "life-a ?prompt= seed whose POST fails",
    url: "http://localhost:3000/?prompt=go&new=1",
    routes: [["POST", "^/api/sessions/[^/]+/input$", { reject: "Failed to fetch" }]],
    steps: [wait(1000)],
  },
  {
    name: "life-the URL writer reflects ?session=",
    pathname: "/",
    url: "http://localhost:3000/?session=sess-1&at=u-3",
    steps: [
      wait(1000),
      call("switchSession", "sess-2"),
      wait(1000),
      call("switchSession", "sess-3"),
      { navIntent: true, dt: 100 },
      wait(1000),
      call("switchSession", "sess-4"),
      { pushState: "/wks_ab12/git", dt: 100 },
      wait(1000),
      { pushState: "/wks_ab12?x=1", dt: 100 },
      call("switchSession", "sess-5"),
      wait(1000),
      call("switchSession", "sess-6"),
      { pathname: "/settings", dt: 100 },
      wait(1000),
      { pathname: "/wks_ab12/" },
      wait(1000),
      { pathname: "/wks_AB12" },
      call("switchSession", "sess-7"),
      wait(1000),
    ],
  },
  {
    name: "life-the URL writer leaves a matching URL",
    pathname: "/",
    steps: [wait(1000), ev(READY)],
  },
  {
    name: "life-the URL writer on a customize chat",
    pathname: "/customize/cust_0f/chat",
    url: "http://localhost:3000/customize/cust_0f/chat",
    steps: [wait(1000)],
  },
  {
    name: "life-advisor and badge seeds",
    bootRoutes: [
      ["GET", "^/api/sessions/sess-1/advisor$", { status: 200, body: { model: "claude-opus-4-5" } }],
      ["GET", "^/api/sessions/sess-1/suggested-messages$", { status: 200, body: { uuids: ["u-1"] } }],
      ["GET", "^/api/sessions/sess-1/goal-messages$", { status: 200, body: { uuids: ["g-1", "g-2"] } }],
    ],
    routes: [
      [
        "GET",
        "^/api/sessions/[^/]+/advisor$",
        [
          { status: 500, body: { model: "claude-x" } },
          { status: 200, text: "nope" },
          { status: 200, text: "null" },
          { status: 200, text: "0" },
          { status: 200, body: { model: "" } },
          { status: 200, body: { model: 5 } },
          { status: 200, text: "true" },
          { status: 200, body: { model: "claude-sonnet-4-5" } },
        ],
      ],
      [
        "GET",
        "^/api/sessions/[^/]+/suggested-messages$",
        [{ reject: "Failed to fetch" }, { status: 500, body: { uuids: ["x"] } }, { status: 200, text: "nope" }, { status: 200, text: "null" }, { status: 200, body: { uuids: "u-9" } }, { status: 200, body: { uuids: [] } }, { status: 200, body: {} }, { status: 200, body: { uuids: ["s-8", "s-8", "s-9"] } }],
      ],
      ["GET", "^/api/sessions/[^/]+/goal-messages$", { status: 200, body: { uuids: ["g-3"] } }],
    ],
    steps: ["sess-2", "sess-3", "sess-4", "sess-5", "sess-6", "sess-7", "sess-8", "sess-9"].map((id) =>
      call("switchSession", id),
    ),
  },
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
