import { NextResponse } from "next/server";
import { list } from "@/lib/server/sessions-store";
import { getSessionTitlesByCwd } from "@/lib/server/sessions-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const dir = url.searchParams.get("dir") || undefined;
  const limit = Number(url.searchParams.get("limit") || "200") || 200;
  try {
    const sessions = await list({ dir, limit });
    // Enrich each SDK session info with our DB title (if any).
    //
    // Why: `setSessionTitle` (DB write) and `renameSession` (SDK JSONL
    // header write) are separate operations. The SDK call routinely
    // fails when the JSONL doesn't exist yet — common for sessions
    // renamed before their first turn — so the SDK's `customTitle`
    // ends up empty for many legitimately-renamed sessions. We mirror
    // the rename into our DB so it survives that hole; this enrichment
    // surfaces it to the client.
    //
    // The override lands on a NEW `claudiusTitle` field rather than
    // overwriting `customTitle` itself: it lets the client tell apart
    // "user renamed via Claudius" (claudiusTitle) from "renamed via
    // SDK / TUI" (customTitle) for diagnostics, while both still mean
    // the session has a real name.
    // Pass EVERY session through — even those without a `cwd` in the
    // JSONL header. `getSessionTitlesByCwd` fans those out across every
    // known workspace's DB so a renamed session whose SDK info dropped
    // the cwd still gets its title surfaced. The reported `cwd` is also
    // included in the title-map key, so we look it up the same way.
    const titles = await getSessionTitlesByCwd(
      sessions.map((s) => ({ cwd: s.cwd, id: s.sessionId })),
    );
    const enriched = sessions.map((s) => {
      // Two keys: the cwd-scoped one (preferred when the JSONL carries
      // a cwd) and the unkeyed `*:id` fallback (filled by the fan-out
      // path for cwd-less sessions). Either is fine — they both mean
      // "the user named this session via Claudius."
      const cwdKey = s.cwd ? `${s.cwd}:${s.sessionId}` : null;
      const dbTitle =
        (cwdKey ? titles.get(cwdKey) : null) ?? titles.get(`*:${s.sessionId}`);
      return dbTitle ? { ...s, claudiusTitle: dbTitle } : s;
    });
    return NextResponse.json({ sessions: enriched });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
