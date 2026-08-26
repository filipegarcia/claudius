import { NextResponse } from "next/server";
import { listLoopBreakdown } from "@/lib/server/loop-ticks-db";
import { resolveTrustedCwd } from "@/lib/server/trusted-cwd";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/cost/loops
 *
 * Loops breakdown (Claude Code 2.1.243 parity) — per-session dynamic-`/loop`
 * tick history: run count, total tokens, tokens per run, and last run. See
 * `lib/server/loop-ticks-db.ts` for the persistence this reads and the
 * 2.1.245 run-notes for why it's grouped by session rather than by
 * individual loop invocation.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const cwd = await resolveTrustedCwd(url.searchParams.get("cwd"));
  if (!cwd) return NextResponse.json({ error: "unknown cwd" }, { status: 400 });
  try {
    const loops = await listLoopBreakdown(cwd);
    return NextResponse.json({ loops });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
