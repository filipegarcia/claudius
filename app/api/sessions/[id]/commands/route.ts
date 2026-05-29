import { NextResponse } from "next/server";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { sessionManager } from "@/lib/server/session-manager";

export const runtime = "nodejs";

/**
 * Return the slash commands the SDK advertises for this session as rich
 * `SlashCommand` objects (name + description + argumentHint + aliases). The
 * system:init message only carries command *names*; this control request adds
 * descriptions/hints (incl. plugin- and skill-provided commands) so the
 * picker can show real help text, and can be re-fetched after a plugin reload.
 *
 * 503 when the session isn't bound to an active query yet (resume in flight,
 * reaped); the picker falls back to its curated static registry + init names.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const session = sessionManager.get(id);
    if (!session) return NextResponse.json({ error: "session not found" }, { status: 404 });
    // Read the SDK `Query` instance field directly (HMR-safe — survives Next
    // Fast Refresh, unlike the Session.supportedCommands prototype method).
    // Same rationale as the model-picker and loaded-agents routes.
    const query = (session as unknown as { query: Query | null }).query;
    if (!query) {
      return NextResponse.json({ error: "session not active" }, { status: 503 });
    }
    const commands = await query.supportedCommands();
    return NextResponse.json({ commands });
  } catch (err) {
    // Defensive: SDK shape drift / serialization edge cases become a typed
    // error response instead of a generic 500 so the picker can fall back.

    console.error("[api/sessions/commands] GET failed", err);
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
