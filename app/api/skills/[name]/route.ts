import { NextResponse } from "next/server";
import { deleteSkill, type SkillScope } from "@/lib/server/skills";

export const runtime = "nodejs";

const SCOPES: SkillScope[] = ["user", "project"];

export async function DELETE(req: Request, ctx: { params: Promise<{ name: string }> }) {
  const { name } = await ctx.params;
  const url = new URL(req.url);
  const scope = url.searchParams.get("scope") as SkillScope | null;
  const cwd = url.searchParams.get("cwd") || process.cwd();
  if (!scope || !SCOPES.includes(scope))
    return NextResponse.json({ error: "invalid scope" }, { status: 400 });
  try {
    const ok = await deleteSkill(scope, cwd, name);
    if (!ok) return NextResponse.json({ error: "not found" }, { status: 404 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
  return NextResponse.json({ ok: true });
}
