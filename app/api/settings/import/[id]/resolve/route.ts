import { NextResponse } from "next/server";

import { resolve as resolveImport } from "@/lib/server/settings-import";
import type { ImportDecision } from "@/lib/shared/settings-bundle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  wsIndex?: number;
  decision?: ImportDecision;
};

/**
 * `POST /api/settings/import/:id/resolve` — record the user's answer to the
 * current pause and advance.
 *
 * Body: `{ wsIndex, decision }`.
 *   - `decision.kind === "heal"`     → new rootPath provided by the picker
 *   - `decision.kind === "skip"`     → drop this workspace, move on
 *   - `decision.kind === "overwrite"`→ collision resolved by writing through
 *                                      the existing local row
 *   - `decision.kind === "rename"`   → collision resolved by creating a new
 *                                      workspace under `newName`
 *
 * Returns the next `ImportProgress` — either another `paused` payload
 * (different workspace, different hazard) or `done`.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch (err) {
    return NextResponse.json(
      { error: `invalid JSON: ${err instanceof Error ? err.message : String(err)}` },
      { status: 400 },
    );
  }

  if (typeof body.wsIndex !== "number" || !Number.isInteger(body.wsIndex) || body.wsIndex < 0) {
    return NextResponse.json({ error: "wsIndex (non-negative integer) required" }, { status: 400 });
  }
  if (!body.decision || typeof body.decision !== "object") {
    return NextResponse.json({ error: "decision required" }, { status: 400 });
  }
  const kind = (body.decision as { kind?: string }).kind;
  if (kind !== "heal" && kind !== "skip" && kind !== "overwrite" && kind !== "rename") {
    return NextResponse.json({ error: `unknown decision.kind ${String(kind)}` }, { status: 400 });
  }

  const progress = await resolveImport(id, { wsIndex: body.wsIndex, decision: body.decision });
  if (progress.state === "error" && progress.error === "import session not found") {
    return NextResponse.json(progress, { status: 404 });
  }
  return NextResponse.json(progress);
}
