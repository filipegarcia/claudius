import { NextResponse } from "next/server";
import { aggregate } from "@/lib/server/cost-aggregate";
import { resolveTrustedCwd } from "@/lib/server/trusted-cwd";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const cwd = await resolveTrustedCwd(url.searchParams.get("cwd"));
  if (!cwd) return NextResponse.json({ error: "unknown cwd" }, { status: 400 });
  try {
    const data = await aggregate(cwd);
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
