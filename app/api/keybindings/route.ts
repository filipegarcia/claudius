import { NextResponse } from "next/server";
import { readKeybindings, writeKeybindings, type KeybindingsFile } from "@/lib/server/keybindings";

export const runtime = "nodejs";

export async function GET() {
  const data = await readKeybindings();
  return NextResponse.json(data);
}

export async function PUT(req: Request) {
  const body = (await req.json()) as { data: KeybindingsFile };
  if (!body?.data || typeof body.data !== "object")
    return NextResponse.json({ error: "data required" }, { status: 400 });
  await writeKeybindings(body.data);
  return NextResponse.json({ ok: true });
}
