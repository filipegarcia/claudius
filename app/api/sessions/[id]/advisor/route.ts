import { NextResponse } from "next/server";
import { sessionManager } from "@/lib/server/session-manager";
import { readSettings, writeSettings, type ClaudeSettings } from "@/lib/server/settings";
import {
  ADVISOR_OPTIONS,
  type AdvisorChoice,
  normalizeAdvisorChoice,
} from "@/lib/shared/advisor";

export const runtime = "nodejs";

/**
 * Set the advisor model. The advisor is a *connection-level* preference in
 * the Claude Code product surface — it lives in `~/.claude/settings.json`
 * and applies to every session the user opens against this account. So this
 * route does TWO things, atomic-ish from the user's POV:
 *
 *   1. **Persists** the choice to `~/.claude/settings.json` (the user scope
 *      Claudius shares with the Claude Code CLI). Survives across sessions,
 *      workspaces, and Claudius restarts. This is the source of truth the
 *      Settings page also writes to.
 *   2. **Applies it mid-session** by calling
 *      `Query.applyFlagSettings({ advisorModel })` so the *current* turn
 *      respects the new pick without forcing a restart.
 *
 * Body shape:
 *   - `{ model: "claude-opus-4-8" }` — set the advisor (both layers).
 *   - `{ model: null }` — remove the key from `~/.claude/settings.json`
 *     AND clear the flag-layer override. With both gone the SDK has no
 *     advisor configured, so this is an honest "off".
 *
 * Values are constrained to the three product-blessed choices listed in
 * `lib/shared/advisor.ts`; unknown strings collapse to `null`. Advanced
 * users with a non-listed advisor edit `settings.json` directly.
 */
const ALLOWED = new Set<string | null>(ADVISOR_OPTIONS.map((o) => o.value));

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = sessionManager.get(id);
  if (!session) return NextResponse.json({ error: "session not found" }, { status: 404 });
  const body = (await req.json()) as { model?: string | null };
  // Treat `undefined` as "clear" so an empty body { } reads as "no
  // advisor" — same convention the model picker uses for its "Inherit"
  // row. `normalizeAdvisorChoice` collapses unknown strings to null,
  // which the allowlist check below then accepts.
  const raw = body?.model === undefined ? null : body.model;
  const choice: AdvisorChoice = raw === null ? null : normalizeAdvisorChoice(raw);
  if (!ALLOWED.has(choice)) {
    return NextResponse.json({ error: "invalid advisor model" }, { status: 400 });
  }

  // (1) Persist to ~/.claude/settings.json. Best-effort across the two
  // sub-steps: a settings write failure shouldn't block the mid-session
  // apply (and vice versa). The Settings page reads/writes the same file.
  const session_cwd = (session as unknown as { cwd: string }).cwd;
  try {
    const current = await readSettings("user", session_cwd);
    const next: ClaudeSettings = { ...current };
    if (choice === null) {
      delete next.advisorModel;
    } else {
      next.advisorModel = choice;
    }
    await writeSettings("user", session_cwd, next);
  } catch (err) {
    console.error("[api/sessions/advisor] settings write failed", err);
    // Continue — we still want the in-memory apply to land so the active
    // turn reflects the user's pick.
  }

  // (2) Apply mid-session via the flag-settings layer.
  await session.setAdvisorModel(choice);
  return NextResponse.json({ ok: true, model: choice });
}

/**
 * Return the effective advisor — the in-memory cache the Session captured
 * at start, with a *live* fall-back read of `~/.claude/settings.json`. The
 * fallback is crucial for sessions that started BEFORE the
 * advisor-caching code shipped: `this.advisorModel` is undefined on those
 * instances, but the user's settings.json may already carry a value (the
 * SDK is honoring it too) — without the fallback the SessionCard would
 * lie and say "No advisor" on every long-lived session the user came
 * back to.
 *
 * Returns `{ model: null }` when no advisor is configured anywhere.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = sessionManager.get(id);
  if (!session) return NextResponse.json({ error: "session not found" }, { status: 404 });
  // Mirror the field-read pattern used by /api/sessions/[id]/model — instance
  // property reads survive Fast Refresh, prototype methods don't.
  const cached = (session as unknown as { advisorModel?: string }).advisorModel ?? null;
  if (cached) return NextResponse.json({ model: cached });
  // Cache miss — read the canonical settings.json. Best-effort: a parse
  // error or missing file → `null` (no advisor), same as the cache-miss path.
  try {
    const session_cwd = (session as unknown as { cwd: string }).cwd;
    const disk = await readSettings("user", session_cwd);
    const onDisk = typeof disk.advisorModel === "string" ? disk.advisorModel : null;
    return NextResponse.json({ model: onDisk });
  } catch {
    return NextResponse.json({ model: null });
  }
}
