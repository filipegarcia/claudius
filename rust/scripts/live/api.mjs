// Live API smoke against the Rust backend and the REAL `claude` CLI.
// Run by rust/scripts/live-smoke.sh; usage: node api.mjs <baseUrl> <projectCwd>
//
// Checks, over plain HTTP + SSE (no browser, no Next):
//   1. create a session, subscribe to its stream, send a prompt, and get the
//      model's reply back as a successful `result` ("PONG")
//   2. a permission round trip: the model asks to run Bash, the request shows
//      up as `permission_request`, we allow it once, the command really runs
//      (proof file appears) and the turn finishes
import { existsSync } from "node:fs";
import { join } from "node:path";

const [base, cwd] = process.argv.slice(2);
if (!base || !cwd) {
  console.error("usage: node api.mjs <baseUrl> <projectCwd>");
  process.exit(2);
}
const TURN_TIMEOUT_MS = 120_000;

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
  return json;
}

/**
 * Subscribe to a session's SSE stream. `next(pred)` resolves with the first
 * matching event *after the previous match*: events can arrive before the
 * caller asks for them (e.g. `usage_snapshot` lands in the same chunk as the
 * `result`), so matching scans the backlog from a cursor, not just the future.
 */
function subscribe(id) {
  const ctrl = new AbortController();
  const events = [];
  const waiters = [];
  let cursor = 0;
  let failed = null;
  (async () => {
    const res = await fetch(`${base}/api/sessions/${id}/stream?tabId=live-smoke`, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`stream → ${res.status}`);
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (!frame.startsWith("data: ")) continue; // `: ping` keep-alives
        events.push(JSON.parse(frame.slice(6)));
        drain();
      }
    }
  })().catch((err) => {
    if (ctrl.signal.aborted) return;
    failed = err;
    for (const w of waiters) w.reject(err);
  });
  // Waiters are served in order, each consuming the backlog from the cursor.
  function drain() {
    while (waiters.length) {
      const w = waiters[0];
      const i = events.findIndex((ev, idx) => idx >= cursor && w.pred(ev));
      if (i < 0) return;
      cursor = i + 1;
      waiters.shift();
      w.resolve(events[i]);
    }
  }
  return {
    events,
    next(pred, label, timeoutMs = TURN_TIMEOUT_MS) {
      if (failed) return Promise.reject(failed);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
        waiters.push({
          pred,
          resolve: (ev) => (clearTimeout(timer), resolve(ev)),
          reject: (err) => (clearTimeout(timer), reject(err)),
        });
        drain();
      });
    },
    close: () => ctrl.abort(),
  };
}

const isResult = (e) => e.type === "sdk" && e.message?.type === "result";
const ok = (msg) => console.log(`  ✓ ${msg}`);

const created = await call("POST", "/api/sessions", { cwd });
ok(`created session ${created.id} (model ${created.model ?? "default"})`);
const sse = subscribe(created.id);
try {
  await sse.next((e) => e.type === "replay_done", "replay_done", 30_000);

  // 1. PONG
  await call("POST", `/api/sessions/${created.id}/input`, {
    text: "Reply with exactly the word PONG and nothing else.",
  });
  const r1 = await sse.next(isResult, "PONG result");
  if (r1.message.subtype !== "success" || !/\bPONG\b/.test(String(r1.message.result))) {
    throw new Error(`unexpected result: ${JSON.stringify(r1.message).slice(0, 300)}`);
  }
  const usage = await sse.next((e) => e.type === "usage_snapshot" && e.usage?.numTurns >= 1, "usage_snapshot", 10_000);
  ok(`PONG turn: result "${r1.message.result}", cost $${usage.usage.totalCostUsd}`);

  // 2. permission round trip
  const proof = join(cwd, "rs-perm-proof.txt");
  await call("POST", `/api/sessions/${created.id}/input`, {
    text: "Use the Bash tool to run exactly: touch rs-perm-proof.txt — then reply DONE.",
  });
  const req = await sse.next((e) => e.type === "permission_request", "permission_request");
  if (existsSync(proof)) throw new Error("proof file exists before the permission was granted");
  ok(`permission_request for ${req.toolName ?? req.tool_name ?? "tool"} (${req.requestId})`);
  await call("POST", `/api/sessions/${created.id}/permission`, {
    requestId: req.requestId,
    decision: { kind: "allow_once" },
  });
  const r2 = await sse.next(isResult, "post-permission result");
  if (r2.message.subtype !== "success") throw new Error(`turn failed: ${JSON.stringify(r2.message).slice(0, 300)}`);
  if (!existsSync(proof)) throw new Error("permission was allowed but the command did not run");
  ok(`allowed once → Bash ran (proof file exists), turn finished: "${String(r2.message.result).slice(0, 60)}"`);
} finally {
  sse.close();
}
console.log("API smoke passed");
process.exit(0);
