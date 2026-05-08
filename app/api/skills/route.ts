import { NextResponse } from "next/server";
import { listSkills, readSkill, writeSkill, type SkillScope } from "@/lib/server/skills";

export const runtime = "nodejs";

const SCOPES: SkillScope[] = ["user", "project"];

export async function GET(req: Request) {
  const url = new URL(req.url);
  const cwd = url.searchParams.get("cwd") || process.cwd();
  const scope = url.searchParams.get("scope") as SkillScope | null;
  const name = url.searchParams.get("name");
  if (scope && name) {
    if (!SCOPES.includes(scope)) {
      return NextResponse.json({ error: "invalid scope" }, { status: 400 });
    }
    const file = await readSkill(scope, cwd, name);
    if (!file) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json(file);
  }
  const out = await Promise.all(SCOPES.map((s) => listSkills(s, cwd)));
  return NextResponse.json({
    cwd,
    scopes: out.map((files, i) => ({ scope: SCOPES[i], files })),
  });
}

type PutBody = { scope: SkillScope; cwd?: string; name: string; raw: string };

export async function PUT(req: Request) {
  const body = (await req.json()) as PutBody;
  if (!body?.scope || !SCOPES.includes(body.scope))
    return NextResponse.json({ error: "invalid scope" }, { status: 400 });
  if (!body?.name) return NextResponse.json({ error: "name required" }, { status: 400 });
  if (typeof body.raw !== "string")
    return NextResponse.json({ error: "raw content required" }, { status: 400 });
  const cwd = body.cwd || process.cwd();
  try {
    await writeSkill(body.scope, cwd, body.name, body.raw);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
  return NextResponse.json({ ok: true });
}
