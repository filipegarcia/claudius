/**
 * POST /api/voice/close?id=<sessionId>
 *
 * Tells the upstream voice_stream WebSocket we're done speaking. The
 * server replies with a final `TranscriptText` + `TranscriptEndpoint`,
 * then closes with code 1000. The renderer can keep its SSE open
 * until it receives the `close` event.
 */
import { NextResponse } from "next/server";

import { finalizeVoiceSession } from "@/lib/server/voice-stream";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id || !/^[a-zA-Z0-9_-]{8,64}$/.test(id)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  const ok = finalizeVoiceSession(id);
  if (!ok) {
    return NextResponse.json({ error: "session gone" }, { status: 410 });
  }
  return new Response(null, { status: 204 });
}
