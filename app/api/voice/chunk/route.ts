/**
 * POST /api/voice/chunk?id=<sessionId>
 *
 * Body: raw 16 kHz mono linear16 PCM bytes. Forwarded straight to the
 * upstream voice_stream WebSocket for the session opened by
 * /api/voice/stream. Returns 200 even when the upstream is no longer
 * accepting frames — the renderer will see the actual error on the
 * SSE channel and stop sending.
 */
import { NextResponse } from "next/server";

import { pushAudioChunk } from "@/lib/server/voice-stream";

export const runtime = "nodejs";

// Audio frames are tiny by REST standards (the renderer batches into
// 1024-byte slices, ~32 ms each), but cap defensively to catch a
// buggy / malicious client trying to OOM the upstream. 1 MB is ~16 s
// of audio at 16-bit/16 kHz — well past any single frame we'd send.
const MAX_CHUNK_BYTES = 1_048_576;

export async function POST(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id || !/^[a-zA-Z0-9_-]{8,64}$/.test(id)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (contentLength > MAX_CHUNK_BYTES) {
    return NextResponse.json(
      { error: "chunk too large" },
      { status: 413 },
    );
  }

  const buf = new Uint8Array(await req.arrayBuffer());
  if (buf.byteLength === 0) {
    // Empty bodies are a programming error on the client — surface
    // it so it's not silently swallowed.
    return NextResponse.json({ error: "empty chunk" }, { status: 400 });
  }
  if (buf.byteLength > MAX_CHUNK_BYTES) {
    // Belt + suspenders: Content-Length can lie.
    return NextResponse.json({ error: "chunk too large" }, { status: 413 });
  }

  const ok = pushAudioChunk(id, buf);
  // 410 Gone is the right shape: the session existed but is no longer
  // accepting frames. The renderer treats this as "stop sending".
  if (!ok) {
    return NextResponse.json({ error: "session gone" }, { status: 410 });
  }
  return new Response(null, { status: 204 });
}
