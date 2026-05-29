import { NextResponse } from "next/server";
import { list, type SessionListItem } from "@/lib/server/sessions-store";
import { getSessionTitlesByCwd, listAllIndexedSessions } from "@/lib/server/sessions-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const dir = url.searchParams.get("dir") || undefined;
  const limit = Number(url.searchParams.get("limit") || "200") || 200;
  try {
    const sessions = await list({ dir, limit });
    // Surface DB-only sessions too. A session that was renamed before
    // its first turn flushed has a `.claudius.db` row but no JSONL on
    // disk, so the SDK's `listSessions` (which `list()` wraps) leaves
    // it invisible. After the in-memory copy is reaped — natural
    // reaper timer OR a dev-reap — that session disappears from every
    // surface the client uses and tabs in `openTabs` fall back to the
    // id-prefix label. Fan out across workspaces (or scope to `dir`
    // when given) and synthesize entries for any DB row whose id the
    // SDK didn't return.
    const sdkIds = new Set(sessions.map((s) => s.sessionId));
    const dbRows = await listAllIndexedSessions(dir);
    const synthetic: SessionListItem[] = [];
    for (const row of dbRows) {
      if (sdkIds.has(row.id)) continue;
      synthetic.push({
        sessionId: row.id,
        // `summary` is the SDK's display fallback; for a session that
        // has no JSONL yet there's no "first prompt" — feed the DB
        // title if we have one (better than an empty string).
        summary: row.title ?? "",
        lastModified: row.last_seen_at || row.updated_at || row.created_at || 0,
        cwd: row.cwd,
      });
    }
    const combined = [...sessions, ...synthetic];

    // Enrich each session info with our DB title (if any).
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
      combined.map((s) => ({ cwd: s.cwd, id: s.sessionId })),
    );
    const enriched = combined.map((s) => {
      // Two keys: the cwd-scoped one (preferred when the JSONL carries
      // a cwd) and the unkeyed `*:id` fallback (filled by the fan-out
      // path for cwd-less sessions). Either is fine — they both mean
      // "the user named this session via Claudius."
      const cwdKey = s.cwd ? `${s.cwd}:${s.sessionId}` : null;
      const dbTitle =
        (cwdKey ? titles.get(cwdKey) : null) ?? titles.get(`*:${s.sessionId}`);
      return dbTitle ? { ...s, claudiusTitle: dbTitle } : s;
    });
    // Sort by recency and apply the caller's limit. The SDK already
    // honored `limit` for its slice; without the re-sort + re-cap our
    // synthetic rows would always pile up at the end and could push
    // legitimately-recent JSONL sessions off the visible page.
    enriched.sort((a, b) => (b.lastModified ?? 0) - (a.lastModified ?? 0));
    return NextResponse.json({ sessions: enriched.slice(0, limit) });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
