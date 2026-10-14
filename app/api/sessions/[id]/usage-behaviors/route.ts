import { NextResponse } from "next/server";
import { getOrResumeSession } from "@/lib/server/session-resume";
import type { UsageBehaviorsResponse } from "@/lib/shared/usage-behaviors";

export const runtime = "nodejs";

/**
 * CC 2.1.299 parity — "Added /usage warnings for max effort, workflows,
 * always-on context and large tool results". On-demand read of the day/week
 * behaviour characteristics the Cost overlay renders as its "What's
 * contributing to your limits usage?" section. Fetched only when the overlay
 * opens (it triggers a local-transcript scan — never part of the idle poll).
 * `behaviors: null` (still a 200) when the SDK has nothing to report:
 * non-subscriber sessions, a failed scan, or the experimental API missing.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = await getOrResumeSession(id);
  if (!session) return NextResponse.json({ error: "session not found" }, { status: 404 });
  const body: UsageBehaviorsResponse = { behaviors: await session.getUsageBehaviors() };
  return NextResponse.json(body);
}
