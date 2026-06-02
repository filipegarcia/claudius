import { NextResponse } from "next/server";
import { sessionManager } from "@/lib/server/session-manager";

export const runtime = "nodejs";

/**
 * Live-switch the main-thread agent for a running session (SDK 0.3.161+).
 *
 * POST body: `{ agent: string | null }`
 *   - `agent: "code-reviewer"` — switches to the named agent; its system
 *     prompt, tool restrictions, and model apply to the next turn.
 *   - `agent: null` — resets to the default general-purpose agent.
 *
 * Delegates to `Session.setAgent()` which calls
 * `query.applyFlagSettings({ agent })` and broadcasts an `agent_changed`
 * SSE event to all connected tabs. If the session has no active query yet
 * (resume in flight, reaped), the call is a no-op — the SDK's flag layer
 * will be applied on the next query start.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = sessionManager.get(id);
  if (!session) return NextResponse.json({ error: "session not found" }, { status: 404 });

  let body: { agent?: unknown };
  try {
    body = (await req.json()) as { agent?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  // Accept explicit null (reset) or a string (switch). Reject other types.
  const { agent } = body;
  if (agent !== null && agent !== undefined && typeof agent !== "string") {
    return NextResponse.json({ error: "agent must be a string or null" }, { status: 400 });
  }
  if (agent === undefined) {
    return NextResponse.json(
      { error: "agent field is required (pass null to reset to default)" },
      { status: 400 },
    );
  }

  await session.setAgent(agent as string | null);
  return NextResponse.json({ ok: true, agent: agent ?? null });
}

/**
 * Return the current main-thread agent name for this session, or null if the
 * session is running as the default general-purpose agent.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = sessionManager.get(id);
  if (!session) return NextResponse.json({ error: "session not found" }, { status: 404 });
  return NextResponse.json({ agent: session.agent ?? null });
}
