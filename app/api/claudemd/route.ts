import { NextResponse } from "next/server";
import {
  pathFor,
  readScope,
  readAllScopes,
  resolveHierarchy,
  writeScope,
  type ClaudeMdScope,
} from "@/lib/server/claudemd";

export const runtime = "nodejs";

const SCOPES: ClaudeMdScope[] = ["user", "project", "project-claude", "local"];

export async function GET(req: Request) {
  const url = new URL(req.url);
  const cwd = url.searchParams.get("cwd") || process.cwd();
  const scope = url.searchParams.get("scope") as ClaudeMdScope | null;
  const resolved = url.searchParams.get("resolved") === "1";

  if (resolved) {
    const data = await resolveHierarchy(cwd);
    return NextResponse.json(data);
  }
  if (scope) {
    if (!SCOPES.includes(scope)) return NextResponse.json({ error: "invalid scope" }, { status: 400 });
    const file = await readScope(scope, cwd);
    return NextResponse.json(file);
  }
  const all = await readAllScopes(cwd);
  return NextResponse.json({ cwd, scopes: all });
}

type PutBody = {
  scope: ClaudeMdScope;
  cwd?: string;
  content: string;
};

export async function PUT(req: Request) {
  const body = (await req.json()) as PutBody;
  if (!body?.scope || !SCOPES.includes(body.scope)) {
    return NextResponse.json({ error: "invalid scope" }, { status: 400 });
  }
  if (typeof body.content !== "string") {
    return NextResponse.json({ error: "content required" }, { status: 400 });
  }
  const cwd = body.cwd || process.cwd();
  await writeScope(body.scope, cwd, body.content);
  return NextResponse.json({ ok: true, path: pathFor(body.scope, cwd) });
}
