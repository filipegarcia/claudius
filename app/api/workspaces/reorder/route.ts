import { NextResponse } from "next/server";
import { reorderWorkspaces } from "@/lib/server/workspaces-store";

export const runtime = "nodejs";

type Body = { ids?: string[] };

export async function POST(req: Request) {
  const body = (await req.json()) as Body;
  if (!Array.isArray(body?.ids)) return NextResponse.json({ error: "ids array required" }, { status: 400 });
  const result = await reorderWorkspaces(body.ids);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({ ok: true });
}
