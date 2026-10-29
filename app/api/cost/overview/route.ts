import { NextResponse } from "next/server";
import { getCostOverview } from "@/lib/server/cost-overview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Spend across every project and account on this machine, for the Account
 * page's overview. Takes no input: it covers every `~/.claude/projects` dir,
 * not one workspace (that's `GET /api/cost?cwd=`).
 */
export async function GET() {
  try {
    return NextResponse.json(await getCostOverview());
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
