/**
 * End-to-end probe against Claudius's local voice routes.
 *
 *   GET  /api/voice/stream?id=<sid>&lang=en   — SSE
 *   POST /api/voice/chunk?id=<sid>            — audio bytes
 *   POST /api/voice/close?id=<sid>            — finalize
 *
 * The "open" SSE event comes first (upstream WS opened), then we send
 * chunks, then close. The route handlers should yield the same
 * transcript events the direct probe did.
 */
import { readFile } from "node:fs/promises";

const BASE = process.argv[2] ?? "http://localhost:58579";
const WAV = process.argv[3] ?? "/tmp/voice-probe.wav";

function newSessionId(): string {
  // crypto.randomUUID minus dashes — matches the renderer
  return crypto.randomUUID().replace(/-/g, "");
}

async function loadWavSamples(path: string): Promise<Buffer> {
  const file = await readFile(path);
  if (file.toString("ascii", 0, 4) !== "RIFF" || file.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("not a RIFF/WAVE file");
  }
  let offset = 12;
  while (offset < file.length - 8) {
    const tag = file.toString("ascii", offset, offset + 4);
    const size = file.readUInt32LE(offset + 4);
    if (tag === "data") return file.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size;
  }
  throw new Error("no `data` chunk in WAV");
}

async function main(): Promise<void> {
  const sid = newSessionId();
  console.log(`[e2e] base=${BASE} sid=${sid}`);
  const pcm = await loadWavSamples(WAV);
  console.log(`[e2e] audio: ${pcm.byteLength} bytes`);

  // Open the SSE first — the route handler opens the upstream WS as
  // part of the GET. Subsequent POSTs wait for the `open` event.
  const sseRes = await fetch(`${BASE}/api/voice/stream?id=${sid}&lang=en`, {
    headers: { Accept: "text/event-stream" },
  });
  if (!sseRes.ok || !sseRes.body) {
    throw new Error(`SSE open failed: ${sseRes.status}`);
  }

  const reader = sseRes.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let upstreamReady = false;

  // Read SSE in the background. We don't await this — the main flow
  // drives uploads while events stream in.
  const readerPromise = (async () => {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        console.log("[e2e] SSE stream closed by server");
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      // SSE frames are separated by blank line — split on "\n\n".
      while ((nl = buffer.indexOf("\n\n")) >= 0) {
        const raw = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        const lines = raw.split("\n").filter((l) => l && !l.startsWith(":"));
        if (lines.length === 0) continue;
        let event = "message";
        const datas: string[] = [];
        for (const line of lines) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) datas.push(line.slice(5).trim());
        }
        const data = datas.join("\n");
        if (event === "ready") {
          // Renamed from "open" so it doesn't collide with EventSource's
          // native open lifecycle event (which fires the instant the
          // HTTP 200 lands, before upstream WS is actually ready).
          console.log("[e2e] <-- event: ready", data);
          upstreamReady = true;
        } else {
          console.log(`[e2e] <-- event: ${event}`, data);
        }
      }
    }
  })().catch((err) => {
    console.error("[e2e] reader error:", err);
  });

  // Wait up to 5 s for the upstream to confirm open.
  const waitOpen = Date.now();
  while (!upstreamReady && Date.now() - waitOpen < 5_000) {
    await new Promise((r) => setTimeout(r, 20));
  }
  if (!upstreamReady) throw new Error("upstream never sent open event");
  console.log(`[e2e] upstream ready in ${Date.now() - waitOpen}ms`);

  // Upload in 6400-byte batches (200 ms of audio), pacing at 200 ms.
  const BATCH = 6_400;
  for (let off = 0; off < pcm.byteLength; off += BATCH) {
    const slice = pcm.subarray(off, Math.min(off + BATCH, pcm.byteLength));
    const res = await fetch(`${BASE}/api/voice/chunk?id=${sid}`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: new Uint8Array(slice),
    });
    if (!res.ok && res.status !== 204) {
      console.log(`[e2e] chunk POST got ${res.status}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log("[e2e] all chunks uploaded — sending close");
  await fetch(`${BASE}/api/voice/close?id=${sid}`, { method: "POST" });

  // Give the upstream ~3 s to send the final TranscriptText +
  // TranscriptEndpoint + close.
  await new Promise((r) => setTimeout(r, 3_000));
  try { await reader.cancel(); } catch { /* ignore */ }
  await readerPromise;
  console.log("[e2e] done");
}

main().catch((err) => {
  console.error("[e2e] fatal:", err);
  process.exit(1);
});
