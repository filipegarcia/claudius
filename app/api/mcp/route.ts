import { NextResponse } from "next/server";
import {
  listConfigured,
  upsertServer,
  type McpScope,
  type McpServerConfig,
} from "@/lib/server/mcp";
import { sessionManager } from "@/lib/server/session-manager";

export const runtime = "nodejs";

const SCOPES: McpScope[] = ["user", "project", "local"];

export async function GET(req: Request) {
  const url = new URL(req.url);
  const cwd = url.searchParams.get("cwd") || process.cwd();
  const sessionId = url.searchParams.get("sessionId");

  const configured = await listConfigured(cwd);

  let status: unknown[] | null = null;
  let statusError: string | null = null;
  if (sessionId) {
    const session = sessionManager.get(sessionId);
    if (session) {
      const r = await session.mcpServerStatus();
      if (r.ok) status = r.data as unknown[];
      else statusError = r.error;
    }
  }

  return NextResponse.json({ cwd, configured, status, statusError });
}

type PostBody = {
  scope: McpScope;
  cwd?: string;
  name: string;
  config: McpServerConfig;
};

export async function POST(req: Request) {
  const body = (await req.json()) as PostBody;
  if (!body?.scope || !SCOPES.includes(body.scope))
    return NextResponse.json({ error: "invalid scope" }, { status: 400 });
  if (!body?.name || !body?.config)
    return NextResponse.json({ error: "name and config required" }, { status: 400 });
  const cwd = body.cwd || process.cwd();
  await upsertServer(body.scope, cwd, body.name, body.config);
  return NextResponse.json({ ok: true });
}
