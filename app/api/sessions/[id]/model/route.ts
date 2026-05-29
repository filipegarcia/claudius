import { NextResponse } from "next/server";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { sessionManager } from "@/lib/server/session-manager";

export const runtime = "nodejs";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = sessionManager.get(id);
  if (!session) return NextResponse.json({ error: "session not found" }, { status: 404 });
  const body = (await req.json()) as { model?: string | null };
  await session.setModel(body?.model ?? undefined);
  return NextResponse.json({ ok: true, model: body?.model });
}

/**
 * Return the model list the SDK advertises for this session — the same
 * metadata the CLI's `/model` surface renders. We don't cache: the list is
 * cheap to fetch and may shift across SDK upgrades / org policy changes.
 *
 * 503 when the session isn't bound to an active query yet (resume in
 * flight, reaped). The picker shows a "Session not ready" state and
 * retries on its next open.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const session = sessionManager.get(id);
    if (!session) return NextResponse.json({ error: "session not found" }, { status: 404 });
    // Access the SDK `Query` instance field directly instead of going through
    // a wrapper method on `Session`. This is deliberate:
    //
    //   - The `query` field is assigned in `Session.start()` and lives on
    //     the *instance*. Instance properties survive Next.js Fast Refresh —
    //     when the `Session` module is re-evaluated mid-dev, existing in-memory
    //     instances keep their `query` reference even though their prototype
    //     no longer matches the new class definition.
    //   - A wrapper method on `Session` (e.g. `session.supportedModels()`),
    //     by contrast, lives on the *prototype*. After HMR replaces the class,
    //     pre-existing instances no longer have the method — calling it throws
    //     `session.supportedModels is not a function`, which is exactly what
    //     happened on the first cut of this picker.
    //
    // In production this distinction doesn't matter (no HMR), but the dev
    // experience matters too — restarting `bun run dev` to pick up a new
    // method on Session loses every active session's reaper timer and
    // input queue. Reading from the field skips the issue entirely.
    const query = (session as unknown as { query: Query | null }).query;
    if (!query) {
      return NextResponse.json({ error: "session not active" }, { status: 503 });
    }
    const models = await query.supportedModels();
    return NextResponse.json({ models });
  } catch (err) {
    // Defensive: anything unexpected (SDK shape changes, serialization edge
    // cases) becomes a typed error response instead of a generic 500 so the
    // picker can show the actual cause.

    console.error("[api/sessions/model] GET failed", err);
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
