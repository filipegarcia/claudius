import { NextResponse } from "next/server";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { sessionManager } from "@/lib/server/session-manager";

export const runtime = "nodejs";

const MODES: PermissionMode[] = [
  "default",
  "acceptEdits",
  "auto",
  "dontAsk",
  "bypassPermissions",
  "plan",
];

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = sessionManager.get(id);
  if (!session) return NextResponse.json({ error: "session not found" }, { status: 404 });
  // Guarded parse — an empty or truncated body (a request the browser
  // aborted on navigation, say) threw an unhandled SyntaxError here and
  // surfaced as a 500 with a stack trace in the server log. Same
  // `.catch(() => null)` shape as the sibling holder route; a bad body is
  // just an invalid mode.
  const body = (await req.json().catch(() => null)) as { mode?: string } | null;
  if (!body?.mode || !MODES.includes(body.mode as PermissionMode)) {
    return NextResponse.json({ error: "invalid mode" }, { status: 400 });
  }
  await session.setPermissionMode(body.mode as PermissionMode);
  return NextResponse.json({ ok: true, mode: body.mode });
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = sessionManager.get(id);
  if (!session) return NextResponse.json({ error: "session not found" }, { status: 404 });
  return NextResponse.json({ mode: session.getPermissionMode() });
}
