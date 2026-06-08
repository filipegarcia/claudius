/**
 * Test the `ws`-package Node path that production runs (Electron's
 * standalone server uses ELECTRON_RUN_AS_NODE=1 → Node 22 ABI, which
 * skips Bun's WebSocket shim entirely). The earlier Bun probe never
 * exercised this — Bun shims `ws.WebSocket` to its native socket and
 * logs "ws.WebSocket 'upgrade' event is not implemented in bun".
 *
 * Looking for: does the real `ws` package emit `unexpected-response`
 * on a 101? The CLI binary contains a log line
 *     "[voice_stream] unexpected-response fired with 101; ignoring"
 * which strongly implies it does, AND that the CLI explicitly
 * ignores it. Our server-side voice-stream needs the same handling
 * or the production Node path will treat a successful 101 as fatal.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

import WebSocket from "ws";

const accounts = JSON.parse(
  await readFile(join(homedir(), ".claude", ".claudius", "accounts.json"), "utf8"),
);
const profile =
  accounts.profiles.find((p) => p.id === accounts.activeProfileId) ?? accounts.profiles[0];

const params = new URLSearchParams({
  encoding: "linear16",
  sample_rate: "16000",
  channels: "1",
  endpointing_ms: "300",
  utterance_end_ms: "1000",
  language: "en",
  use_conversation_engine: "true",
  forward_interims: "typed",
  stt_provider: "deepgram-nova3",
});
const url = `wss://api.anthropic.com/api/ws/speech_to_text/voice_stream?${params}`;

console.log("[node-ws] runtime:", process.versions);
console.log("[node-ws] connecting…");

const ws = new WebSocket(url, {
  headers: { Authorization: `Bearer ${profile.secret}` },
  perMessageDeflate: false,
});

ws.on("upgrade", (res) => {
  console.log("[node-ws] upgrade statusCode:", res.statusCode);
});

ws.on("open", () => {
  console.log("[node-ws] OPEN");
  ws.send(JSON.stringify({ type: "KeepAlive" }));
  setTimeout(() => ws.send(JSON.stringify({ type: "CloseStream" })), 500);
});

ws.on("message", (data, isBinary) => {
  console.log(`[node-ws] msg (binary=${isBinary}):`, data.toString());
});

ws.on("error", (err) => {
  console.log("[node-ws] ERROR:", err.message);
});

ws.on("unexpected-response", (_req, res) => {
  console.log("[node-ws] unexpected-response statusCode=", res.statusCode);
  console.log("  headers:", res.headers);
  res.resume();
});

ws.on("close", (code, reason) => {
  console.log(`[node-ws] close code=${code} reason=${reason}`);
  process.exit(0);
});

setTimeout(() => {
  console.log("[node-ws] timeout");
  process.exit(0);
}, 5000);
