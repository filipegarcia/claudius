#!/usr/bin/env node
// Golden fixture for claudius-transport's EventSource emulation (U02): the
// event sequences undici's WHATWG EventSource (node_modules/undici, the
// implementation node 22 ships behind --experimental-eventsource) sees for
// scripted server responses, and the headers it sends on each request.
//
//   node rust/crates/claudius-transport/scripts/eventsource-golden.mjs   (node@22)
//
// Each scenario is a list of connections: the n-th request gets the n-th
// response (status, content type, body chunks as hex, then the body ends,
// stays open, or the socket is destroyed); a request past the list gets a
// 500, which fails the source. The client records every event it
// dispatches (open, message with its type, data and lastEventId, error with
// readyState) until the source fails, or closes it after `closeAfter`
// events and waits to see that nothing more comes.
//
// undici follows the spec closely (its MIME essence check, its fail /
// reestablish split, a last event ID kept across reconnects). Where it
// differs from Chromium, which the emulation follows, the scenario is left
// out (see "non-ASCII data") or can't show it: undici applies `retry:` when
// the event block ends, Chromium at once, which changes only the timing.
//
// Written to rust/crates/claudius-transport/tests/fixtures/eventsource_golden.json
// and replayed by crates/claudius-transport/tests/event_source.rs
// (`replays_the_undici_golden`). Run it twice: the output is byte-identical
// (no ports, no times).
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const crateDir = resolve(here, "..");
const out = join(crateDir, "tests/fixtures/eventsource_golden.json");
const require = createRequire(import.meta.url);
const undici = require("undici");
const undiciVersion = require("undici/package.json").version;

/** Text as hex (ASCII-only source: non-ASCII goes through `u`). */
const t = (s) => Buffer.from(s, "utf8").toString("hex");
/** Raw bytes as hex. */
const raw = (bytes) => Buffer.from(bytes).toString("hex");
/** A code point as UTF-8, for building non-ASCII text. */
const u = (cp) => String.fromCodePoint(cp);

const SSE = "text/event-stream";
const ok = (chunks, end = "close", extra = {}) => ({ status: 200, contentType: SSE, chunks, end, waitBeforeEnd: 0, ...extra });
const status = (code) => ({ status: code, contentType: SSE, chunks: [], end: "close", waitBeforeEnd: 0 });
const typed = (contentType, chunks) => ({ status: 200, contentType, chunks, end: "close", waitBeforeEnd: 0 });

const scenarios = [
  { name: "one message then the end", conns: [ok([t("data: a\n\n")])] },
  {
    name: "retry and ids across reconnects",
    conns: [ok([t("retry: 30\nid: 1\ndata: a\n\n")]), ok([t("data: b\n\nid: 2\n\n")])],
  },
  {
    name: "framing",
    conns: [
      ok([
        raw([0xef, 0xbb]),
        raw([0xbf]),
        t(": hello\r"),
        t("\ndata: one\r\ndata: two\r\n\r"),
        t("\n"),
        t("event: custom\rdata\r\r"),
        t("id: 5\nid: no\u0000pe\ndata:x\n\n"),
        t("retry: soon\nretry:\nretry: 1.5\n"),
        t("data:\n\nevent: x\n\n"),
        t("unknown: field\ndata : not data\ndata: after\n\n"),
        t("id: 6\ndata: unfinished"),
      ]),
      ok([raw([0xef, 0xbb, 0xbf]), t("data: bom again\n\n")]),
    ],
  },
  {
    name: "line endings",
    conns: [ok([t("data: a\r\rdata: b\r\n\r\ndata: c\n\ndata: d\r\n\ndata: e\n\r\n")])],
  },
  {
    name: "a CRLF split across chunks",
    conns: [ok([t("data: a\r"), t("\n"), t("\r"), t("\ndata: b\r"), t("\r")])],
  },
  {
    name: "data lines and empty data",
    conns: [ok([t("data: one\ndata:two\ndata:  three\ndata\n\ndata\n\ndata:\ndata:\n\nevent: e\n\ndata: z\n\n")])],
  },
  {
    name: "event types",
    conns: [ok([t("event: add\ndata: 1\n\nevent:\ndata: 2\n\nevent:  sp\ndata: 3\n\nevent: a\nevent: b\ndata: 4\n\n")])],
  },
  {
    name: "ids",
    conns: [
      ok([t("id: 1\ndata: a\n\ndata: b\n\nid: 2\n\nid\ndata: c\n\nid: x\u0000y\ndata: d\n\nid: 3\n")]),
      ok([t("id: q\n\n")]),
      ok([t("data: after\n\n")]),
    ],
  },
  // Not here: a non-ASCII id. undici puts the id's UTF-16 string in the
  // header, which its fetch refuses as a ByteString, so the reconnect is a
  // network error forever. Chromium sends the id's UTF-8 bytes, and so does
  // the emulation (event_source.rs `last_event_id_is_sent_as_utf8`).
  {
    name: "non-ASCII data",
    conns: [ok([t("data: " + u(0xe9) + u(0x1f600) + "\n\n")])],
  },
  {
    name: "bad UTF-8",
    conns: [ok([raw([...Buffer.from("data: a"), 0xff, ...Buffer.from("b"), 0xe2, 0x82, 0x0a, ...Buffer.from("data: "), 0xf0, 0x9f, 0x98, 0x80, 0x0a, 0x0a])])],
  },
  {
    name: "a BOM only at the start",
    conns: [ok([raw([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf]), t("data: a\n\ndata: " + u(0xfeff) + "x\n\n")]), ok([raw([0xef, 0xbb]), t("data: c\n\ndata: d\n\n")])],
  },
  {
    name: "comments and unknown fields",
    conns: [ok([t(": ping\n:\ndata: a\n: mid\nfoo: bar\ndata : no\n data: no\nDATA: no\n\ndata:a:b\ndata:  c\ndata:\td\n\n")])],
  },
  { name: "retry 0", conns: [ok([t("retry: 0\ndata: a\n\n")]), ok([t("data: b\n\n")])] },
  { name: "an unfinished last event", conns: [ok([t("data: a\n\ndata: b\n")]), ok([t("data: c")])] },
  ...[500, 404, 204, 201, 301, 307].map((code) => ({ name: `status ${code}`, conns: [status(code)] })),
  ...["text/plain", null, "text/event-streamx", "application/json", "text/event"].map((ct) => ({
    name: `content type ${ct}`,
    conns: [typed(ct, [t("data: a\n\n")])],
  })),
  ...["TEXT/Event-Stream", "text/event-stream; charset=utf-8", "text/event-stream;charset=latin1", "text/event-stream ;x=y"].map((ct) => ({
    name: `content type ${ct}`,
    conns: [typed(ct, [t("data: a\n\n")])],
  })),
  { name: "close mid-stream", closeAfter: 2, conns: [ok([t("data: 1\n\n")], "hold")] },
  { name: "close after a reconnect error", closeAfter: 3, conns: [ok([t("data: 1\n\n")])] },
  {
    name: "a body that breaks off",
    conns: [ok([t("data: a\n\ndata: half")], "destroy", { waitBeforeEnd: 100 }), ok([t("data: b\n\n")])],
  },
];

const DEFAULT_RETRY = 20;

async function runScenario(sc) {
  const requests = [];
  const sockets = new Set();
  const server = createServer((req, res) => {
    const n = requests.length;
    const h = (k) => (req.headers[k] === undefined ? null : Buffer.from(req.headers[k], "latin1").toString("hex"));
    requests.push({ accept: h("accept"), cacheControl: h("cache-control"), pragma: h("pragma"), lastEventId: h("last-event-id") });
    const conn = sc.conns[n] ?? status(500);
    const headers = conn.contentType === null ? {} : { "content-type": conn.contentType };
    res.writeHead(conn.status, headers);
    const steps = [...conn.chunks];
    const next = () => {
      if (steps.length > 0) {
        res.write(Buffer.from(steps.shift(), "hex"));
        setTimeout(next, 5);
        return;
      }
      const end = () => {
        if (conn.end === "close") res.end();
        else if (conn.end === "destroy") res.socket.destroy();
      };
      if (conn.waitBeforeEnd > 0) setTimeout(end, conn.waitBeforeEnd);
      else end();
    };
    if (conn.status === 204 || conn.status === 304) res.end();
    else next();
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  const events = [];
  await new Promise((done) => {
    const es = new undici.EventSource(`http://127.0.0.1:${port}/es`, { node: { reconnectionTime: DEFAULT_RETRY } });
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(guard);
      setTimeout(done, 300);
    };
    const guard = setTimeout(() => {
      events.push({ type: "timeout" });
      es.close();
      finish();
    }, 8000);
    const orig = es.dispatchEvent.bind(es);
    es.dispatchEvent = (ev) => {
      if (!finished) {
        if (ev.type === "open") events.push({ type: "open", readyState: es.readyState });
        else if (ev.type === "error") events.push({ type: "error", readyState: es.readyState });
        else events.push({ type: "message", eventType: ev.type, data: ev.data, lastEventId: ev.lastEventId, readyState: es.readyState });
      } else {
        events.push({ type: "late " + ev.type });
      }
      const r = orig(ev);
      if (sc.closeAfter !== undefined && events.length === sc.closeAfter) {
        es.close();
        finish();
      } else if (ev.type === "error" && es.readyState === 2) {
        finish();
      }
      return r;
    };
  });
  for (const s of sockets) s.destroy();
  await new Promise((r) => server.close(r));
  return {
    name: sc.name,
    defaultRetry: DEFAULT_RETRY,
    closeAfter: sc.closeAfter ?? null,
    conns: sc.conns,
    requests,
    events,
  };
}

const results = [];
for (const sc of scenarios) results.push(await runScenario(sc));
const fixture = { node: process.version, undici: undiciVersion, scenarios: results };
writeFileSync(out, JSON.stringify(fixture, null, 1) + "\n");
console.log(`wrote ${out}: ${results.length} scenarios, ${results.reduce((n, s) => n + s.events.length, 0)} events`);
process.exit(0);
