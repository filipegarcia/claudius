import { NextResponse } from "next/server";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { sessionManager } from "@/lib/server/session-manager";

export const runtime = "nodejs";

/**
 * Mirror of the SDK's `ModelInfo` shape — kept local so we don't import
 * the type-graph through this route handler. See `ModelPicker.tsx`.
 */
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

/**
 * Aliases we always want surfaced in the picker even when the SDK omits
 * them from `supportedModels()`. The SDK gates some entries behind plan /
 * account capability (e.g. `isFableAvailable` in the bundled CLI binary),
 * which means a perfectly valid alias like `fable` can be invisible to a
 * user whose entitlement check is still propagating. Selecting one of
 * these still goes through the SDK's `setModel`, which returns a 409 if
 * the account can't use it — so the worst case for a stale augment is a
 * recoverable error toast, not a broken session.
 *
 * Kept in sync with the static fallback in `app/api/models/route.ts`.
 */
const ALWAYS_SHOWN_ALIASES: ModelInfo[] = [
  {
    value: "fable",
    displayName: "Fable",
    description: "Latest Fable — extended thinking and reasoning.",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    supportsAdaptiveThinking: true,
  },
];

/**
 * Family detector for "is this entry already covering the alias?". A pinned
 * id like `claude-fable-5` should count as a Fable entry — we don't want to
 * append a duplicate `fable` row when the SDK already returned the pinned
 * version. Match on substring of the alias inside the value or displayName.
 */
function listAlreadyCoversAlias(list: ModelInfo[], alias: ModelInfo): boolean {
  const needle = alias.value.toLowerCase();
  return list.some((m) => {
    const v = (m.value ?? "").toLowerCase();
    const d = (m.displayName ?? "").toLowerCase();
    return v === needle || v.includes(needle) || d.includes(needle);
  });
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = sessionManager.get(id);
  if (!session) return NextResponse.json({ error: "session not found" }, { status: 404 });
  const body = (await req.json()) as { model?: string | null };
  const result = await session.setModel(body?.model ?? undefined);
  if (!result.ok) {
    // Surface the SDK rejection so the client can revert its optimistic
    // pick and toast. 409 because the model state is unchanged — the
    // request itself was well-formed.
    return NextResponse.json(
      { ok: false, error: result.error, model: result.model ?? null },
      { status: 409 },
    );
  }
  return NextResponse.json({ ok: true, model: result.model ?? null });
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
    const sdkModels = (await query.supportedModels()) as ModelInfo[];
    // Augment with aliases the SDK gated out for this account — see
    // ALWAYS_SHOWN_ALIASES rationale. Order: SDK entries first (so the
    // SDK's preferred ordering wins), augmented aliases appended at the
    // end so they don't hijack the default-pick row.
    const augmented = [...sdkModels];
    for (const alias of ALWAYS_SHOWN_ALIASES) {
      if (!listAlreadyCoversAlias(augmented, alias)) {
        augmented.push(alias);
      }
    }
    return NextResponse.json({ models: augmented });
  } catch (err) {
    // Defensive: anything unexpected (SDK shape changes, serialization edge
    // cases) becomes a typed error response instead of a generic 500 so the
    // picker can show the actual cause.

    console.error("[api/sessions/model] GET failed", err);
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
