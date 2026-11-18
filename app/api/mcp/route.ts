import { NextResponse } from "next/server";
import {
  listConfigured,
  McpJsonShapeError,
  upsertServer,
  type McpScope,
  type McpServerConfig,
} from "@/lib/server/mcp";
import { sessionManager } from "@/lib/server/session-manager";
import { resolveTrustedCwd } from "@/lib/server/trusted-cwd";

export const runtime = "nodejs";

const SCOPES: McpScope[] = ["user", "project", "local"];

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const cwd = await resolveTrustedCwd(url.searchParams.get("cwd"));
  if (!cwd) return NextResponse.json({ error: "unknown cwd" }, { status: 400 });
  const sessionId = url.searchParams.get("sessionId");

  let configured;
  try {
    configured = await listConfigured(cwd);
  } catch (err) {
    return NextResponse.json({ error: errorMessage(err) }, { status: 500 });
  }

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
  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!body?.scope || !SCOPES.includes(body.scope))
    return NextResponse.json({ error: "invalid scope" }, { status: 400 });
  if (!body?.name || !body?.config)
    return NextResponse.json({ error: "name and config required" }, { status: 400 });
  const cwd = await resolveTrustedCwd(body.cwd);
  if (!cwd) return NextResponse.json({ error: "unknown cwd" }, { status: 400 });
  try {
    await upsertServer(body.scope, cwd, body.name, body.config);
  } catch (err) {
    // CC 2.1.327 — a flat .mcp.json is refused rather than rewritten.
    if (err instanceof McpJsonShapeError) return NextResponse.json({ error: err.message }, { status: 409 });
    return NextResponse.json({ error: errorMessage(err) }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
