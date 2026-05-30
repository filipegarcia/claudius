import { NextResponse } from "next/server";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { sessionManager } from "@/lib/server/session-manager";

export const runtime = "nodejs";

/**
 * Dynamically set this session's SDK-added MCP servers (B4.8) — wraps
 * Query.setMcpServers. Lets a user try a server config in one live session
 * without writing it to settings files.
 *
 * Body: `{ servers: Record<string, McpServerConfig> }`. Pass an empty object
 * to remove all dynamically-added servers. Returns the SDK's add/remove/error
 * report as `result`. 404 unknown session, 400 malformed body, 503 inactive
 * session or SDK throw.
 *
 * Only affects servers added via this method — file-configured servers are
 * untouched.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = sessionManager.get(id);
  if (!session) return NextResponse.json({ error: "session not found" }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as { servers?: Record<string, McpServerConfig> };
  if (!body || typeof body.servers !== "object" || body.servers === null || Array.isArray(body.servers)) {
    return NextResponse.json({ error: "servers object required" }, { status: 400 });
  }

  const result = await session.setMcpServers(body.servers);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 503 });
  return NextResponse.json({ result: result.data });
}
