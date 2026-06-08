/**
 * Debug: minimal ws-package probe to figure out why the server-side
 * proxy reports "Unexpected server response: 101" while Bun's built-in
 * WebSocket connects cleanly. Helps isolate which header / option
 * needs to change.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

import WebSocket from "ws";

const accounts = JSON.parse(
  await readFile(join(homedir(), ".claude", ".claudius", "accounts.json"), "utf8"),
);
const profile =
  accounts.profiles.find((p: { id: string }) => p.id === accounts.activeProfileId) ?? accounts.profiles[0];

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

console.log("[ws-debug] connecting", url.slice(0, 80) + "…");

const ws = new WebSocket(url, {
  headers: {
    Authorization: `Bearer ${profile.secret}`,
  },
  perMessageDeflate: false,
  followRedirects: true,
});

ws.on("upgrade", (res) => {
  console.log("[ws-debug] upgrade response");
  console.log("  statusCode:", res.statusCode);
  console.log("  headers:", res.headers);
});

ws.on("open", () => {
  console.log("[ws-debug] OPEN");
  ws.send(JSON.stringify({ type: "KeepAlive" }));
  setTimeout(() => {
    ws.send(JSON.stringify({ type: "CloseStream" }));
  }, 500);
});

ws.on("message", (data, isBinary) => {
  console.log(`[ws-debug] msg (binary=${isBinary}):`, data.toString());
});

ws.on("error", (err) => {
  console.log("[ws-debug] ERROR:", err.message);
});

ws.on("unexpected-response", (_req, res) => {
  console.log("[ws-debug] unexpected-response statusCode=", res.statusCode);
  console.log("  headers:", res.headers);
  res.resume();
});

ws.on("close", (code, reason) => {
  console.log(`[ws-debug] close code=${code} reason=${reason}`);
  process.exit(0);
});

setTimeout(() => {
  console.log("[ws-debug] timeout");
  process.exit(0);
}, 5000);
