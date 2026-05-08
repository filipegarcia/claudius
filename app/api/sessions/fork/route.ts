import { NextResponse } from "next/server";
import { fork } from "@/lib/server/sessions-store";

export const runtime = "nodejs";

type Body = {
  sessionId: string;
  upToMessageId?: string;
  title?: string;
  dir?: string;
};

export async function POST(req: Request) {
  const body = (await req.json()) as Body;
  if (!body?.sessionId) return NextResponse.json({ error: "sessionId required" }, { status: 400 });
  try {
    const result = await fork(body.sessionId, {
      upToMessageId: body.upToMessageId,
      title: body.title,
      dir: body.dir,
    });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
