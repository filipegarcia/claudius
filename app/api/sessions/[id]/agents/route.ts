import { NextResponse } from "next/server";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { sessionManager } from "@/lib/server/session-manager";

export const runtime = "nodejs";

/**
 * Return the subagent list the SDK has loaded for this session — the same
 * `AgentInfo[]` the CLI's `claude agents` surface and the `--agent` picker
 * read. This is the source of truth for which agents are actually live
 * (file-based `.claude/agents/*.md`, plugin-injected, and the built-in
 * general-purpose / Explore agents), distinct from the filesystem-only
 * listing in `/api/agents` which just enumerates the markdown files on disk.
 *
 * 503 when the session isn't bound to an active query yet (resume in flight,
 * reaped). The /agents page shows a "session not ready" state and retries.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const session = sessionManager.get(id);
    if (!session) return NextResponse.json({ error: "session not found" }, { status: 404 });
    // Read the SDK `Query` instance field directly rather than going through
    // `Session.supportedAgents()`. The wrapper method lives on the class
    // prototype, which Next.js Fast Refresh swaps out from under existing
    // in-memory `Session` instances mid-dev — calling it then throws
    // `session.supportedAgents is not a function`. The `query` field is
    // assigned on the *instance* in `Session.start()` and survives HMR. See
    // the same rationale on the model-picker route. In production (no HMR)
    // either path works; reading the field is simply the robust choice.
    const query = (session as unknown as { query: Query | null }).query;
    if (!query) {
      return NextResponse.json({ error: "session not active" }, { status: 503 });
    }
    const agents = await query.supportedAgents();
    return NextResponse.json({ agents });
  } catch (err) {
    // Defensive: SDK shape drift / serialization edge cases become a typed
    // error response instead of a generic 500 so the UI can show the cause.

    console.error("[api/sessions/agents] GET failed", err);
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
