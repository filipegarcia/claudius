import { NextResponse } from "next/server";
import { getWorkspace, setActiveId } from "@/lib/server/workspaces-store";
import { writeActiveCookie } from "@/lib/server/active-workspace";

export const runtime = "nodejs";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not found" }, { status: 404 });
  await setActiveId(id);
  await writeActiveCookie(id);
  return NextResponse.json({ ok: true, id });
}
