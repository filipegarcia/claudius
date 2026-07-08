import { NextResponse } from "next/server";
import { sessionManager } from "@/lib/server/session-manager";

export const runtime = "nodejs";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = sessionManager.get(id);
  if (!session) return NextResponse.json({ error: "session not found" }, { status: 404 });
  // `stillQueued`: uuids of async user messages (SDK 0.3.205 interrupt
  // receipt) that will still run despite this Stop — e.g. a mid-turn
  // follow-up already handed to the SDK before the interrupt landed. Empty
  // on older CLIs or when there's nothing left in flight.
  const { stillQueued } = await session.interrupt();
  return NextResponse.json({ ok: true, stillQueued });
}
