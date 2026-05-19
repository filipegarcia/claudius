import { NextResponse } from "next/server";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { sessionManager } from "@/lib/server/session-manager";

export const runtime = "nodejs";

/**
 * Sessionless model list for surfaces that need to render the picker
 * without a bound session — e.g. the workspace-create form picking the
 * default model for new sessions. The right-rail picker has its own
 * session-scoped route (`/api/sessions/<id>/model`) and is unaffected.
 *
 * Why this exists in a separate route: the SDK's `supportedModels()` is
 * an instance method on a live `Query`, not a sessionless export. So
 * "available models" outside a session requires either a piggybacked
 * lookup or a hand-maintained list.
 *
 * Strategy here: opportunistically reuse any active session's Query. If
 * the user already has Claudius running with at least one session
 * bound, the picker shows the same models the SDK is currently
 * advertising — same source of truth as the session-scoped picker. If
 * no session is active (fresh boot, all sessions reaped), fall back to
 * the small static SDK-alias list so the picker always has *something*
 * to show.
 *
 * The static fallback uses aliases, not pinned model IDs, so it stays
 * accurate across SDK upgrades without requiring a manual touch-up.
 * Picking an alias means "whichever version the SDK currently maps it
 * to" — exactly what `(inherit machine default)` already does today,
 * just made explicit.
 */

/** Mirror of the SDK's `ModelInfo` shape — see ModelPicker.tsx. */
type ModelInfo = {
  value: string;
  displayName: string;
  description: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: Array<"low" | "medium" | "high" | "xhigh" | "max">;
  supportsAdaptiveThinking?: boolean;
  supportsFastMode?: boolean;
  supportsAutoMode?: boolean;
};

const STATIC_FALLBACK: ModelInfo[] = [
  {
    value: "default",
    displayName: "Default (recommended)",
    description: "Whichever model the SDK currently advertises as default.",
  },
  {
    value: "sonnet",
    displayName: "Sonnet",
    description: "Latest Sonnet — best for everyday tasks.",
  },
  {
    value: "haiku",
    displayName: "Haiku",
    description: "Latest Haiku — fastest for quick answers.",
  },
  {
    value: "opus",
    displayName: "Opus",
    description: "Latest Opus — deepest reasoning, slower.",
  },
];

export async function GET() {
  try {
    // Look for any bound session and borrow its Query. We access the
    // `query` instance field directly (not a wrapper method on Session)
    // for the same Fast-Refresh-survives-HMR reason called out in
    // `app/api/sessions/[id]/model/route.ts`.
    for (const session of sessionManager.list()) {
      const query = (session as unknown as { query: Query | null }).query;
      if (!query) continue;
      try {
        const models = await query.supportedModels();
        if (Array.isArray(models) && models.length > 0) {
          return NextResponse.json({ models, source: "session" });
        }
      } catch {
        // This session's query is unhappy — try the next one. If they
        // all fail we fall through to the static list below.
      }
    }
  } catch (err) {
    // Defensive: a sessionManager iteration error shouldn't 500 the
    // picker. Log and serve the fallback so the UI stays usable.
    console.error("[api/models] GET session-probe failed", err);
  }
  return NextResponse.json({ models: STATIC_FALLBACK, source: "fallback" });
}
