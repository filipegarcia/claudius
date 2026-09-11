import { NextResponse } from "next/server";
import { sessionManager } from "@/lib/server/session-manager";
import { isForceReload } from "@/lib/shared/reload-plugins";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const url = new URL(req.url);
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) return NextResponse.json({ error: "sessionId required" }, { status: 400 });
  const session = sessionManager.get(sessionId);
  if (!session) return NextResponse.json({ error: "session not found" }, { status: 404 });
  // `?force=1` — the escape hatch for a reload the SDK held on cache impact
  // (SDK 0.3.268). Wired to the `/reload-plugins force` chat command.
  const force = isForceReload(url.searchParams.get("force"));
  const r = await session.reloadPlugins({ holdOnCacheImpact: !force });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 500 });
  return NextResponse.json(r.data);
}
