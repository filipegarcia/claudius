import { NextResponse } from "next/server";
import { rename } from "@/lib/server/sessions-store";
import { sessionManager } from "@/lib/server/session-manager";

export const runtime = "nodejs";

type Body = { sessionId: string; title: string; dir?: string };

export async function POST(req: Request) {
  const body = (await req.json()) as Body;
  if (!body?.sessionId || !body?.title) {
    return NextResponse.json({ error: "sessionId and title required" }, { status: 400 });
  }
  // If the session is live in-memory, route through Session.rename so the
  // new title is broadcast to all SSE subscribers immediately. Otherwise
  // fall back to the SDK-only path (writes JSONL but no live update — fine
  // for sessions that aren't currently bound).
  const live = sessionManager.get(body.sessionId);
  if (live) {
    const r = await live.rename(body.title);
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 500 });
    return NextResponse.json({ ok: true });
  }
  try {
    await rename(body.sessionId, body.title, body.dir);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
