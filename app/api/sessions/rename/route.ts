import { NextResponse } from "next/server";
import { rename } from "@/lib/server/sessions-store";
import { sessionManager } from "@/lib/server/session-manager";
import { retitleIndexedSession } from "@/lib/server/sessions-db";

export const runtime = "nodejs";

type Body = { sessionId: string; title: string; dir?: string };

export async function POST(req: Request) {
  const body = (await req.json()) as Body;
  const title = typeof body?.title === "string" ? body.title.trim() : "";
  if (!body?.sessionId || !title) {
    return NextResponse.json({ error: "sessionId and title required" }, { status: 400 });
  }
  // If the session is live in-memory, route through Session.rename so the
  // new title is broadcast to all SSE subscribers immediately. Otherwise
  // fall back to the SDK-only path (writes JSONL but no live update — fine
  // for sessions that aren't currently bound).
  const live = sessionManager.get(body.sessionId);
  if (live) {
    const r = await live.rename(title);
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 500 });
    return NextResponse.json({ ok: true });
  }
  // CC 2.1.309 parity — a rename must win over a generated name after a
  // reload or resume. Every title reader prefers the sessions-index title
  // over the JSONL `customTitle`, so this path used to leave a stale (often
  // engine-generated) index title shadowing the rename. Update the index
  // row first, same order as `Session.rename`; then the JSONL write is
  // best-effort when a row was updated (the JSONL may not exist yet) and
  // required when none exists (then it's the only place the name lives).
  let indexed = 0;
  try {
    indexed = await retitleIndexedSession(body.sessionId, title);
  } catch {
    indexed = 0;
  }
  try {
    await rename(body.sessionId, title, body.dir);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (indexed > 0) return NextResponse.json({ ok: true });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
