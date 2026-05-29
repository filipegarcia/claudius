import { NextResponse } from "next/server";
import { listDbAgents, upsertDbAgent, deleteDbAgent } from "@/lib/server/db-agents";

export const runtime = "nodejs";

/**
 * CRUD for DB-backed programmatic subagents (A-P3.8), scoped to the cwd's
 * `.claudius.db`. Distinct from `/api/agents` (file-based markdown agents).
 * These are fed to the SDK via Options.agents at session start.
 */

export async function GET(req: Request) {
  const cwd = new URL(req.url).searchParams.get("cwd") || process.cwd();
  const agents = await listDbAgents(cwd);
  return NextResponse.json({ cwd, agents });
}

type PutBody = { cwd?: string; name?: string; definition?: unknown };

export async function PUT(req: Request) {
  let body: PutBody;
  try {
    body = (await req.json()) as PutBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!body?.name) return NextResponse.json({ error: "name required" }, { status: 400 });
  const cwd = body.cwd || process.cwd();
  try {
    const row = await upsertDbAgent(cwd, body.name, body.definition);
    return NextResponse.json({ ok: true, agent: row });
  } catch (err) {
    // invalid name / missing description+prompt → 400 (caller error)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}

export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const cwd = url.searchParams.get("cwd") || process.cwd();
  const name = url.searchParams.get("name");
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
  try {
    const deleted = await deleteDbAgent(cwd, name);
    return NextResponse.json({ ok: true, deleted });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}
