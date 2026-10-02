import { NextResponse } from "next/server";
import { sep } from "node:path";
import { resolvePeerSource } from "@/lib/server/peer-source";
import { sessionManager } from "@/lib/server/session-manager";
import { listWorkspaces } from "@/lib/server/workspaces-store";
import { PEER_SNIPPET_MAX, type PeerSourceResponse } from "@/lib/shared/peer-source";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/sessions/peer-source?from=<addr>&pid=<n>&msgId=<uuid>&snippet=<text>&at=<ms>
 *
 * Resolve a cross-session peer message to the session that sent it, so the
 * chat's peer-message row can link there. Params come from the message's
 * `SDKMessageOrigin` plus the leading slice of its body — see
 * `lib/server/peer-source.ts` for which delivery paths carry which fields.
 *
 * Responds `{ source: null }` (200) when the sender can't be located — the
 * UI shows that as "sender not found" rather than an error.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const from = url.searchParams.get("from") || undefined;
  const pidRaw = url.searchParams.get("pid");
  const msgId = url.searchParams.get("msgId") || undefined;
  const snippet = url.searchParams.get("snippet")?.slice(0, PEER_SNIPPET_MAX) || undefined;
  const atRaw = url.searchParams.get("at");

  const pid = pidRaw && /^\d{1,10}$/.test(pidRaw) ? Number(pidRaw) : undefined;
  const at = atRaw && /^\d{1,16}$/.test(atRaw) ? Number(atRaw) : undefined;
  if (pid === undefined && !msgId && !from && !snippet) {
    return NextResponse.json({ error: "from, pid, msgId or snippet required" }, { status: 400 });
  }

  const found = await resolvePeerSource({ pid, from, msgId, snippet, at });
  if (!found) return NextResponse.json({ source: null } satisfies PeerSourceResponse);

  // Deepest workspace whose root contains the sender's cwd — sessions are
  // often started in a subdirectory of the project the workspace points at.
  let workspaceId: string | null = null;
  if (found.cwd) {
    const cwd = found.cwd;
    const workspaces = await listWorkspaces().catch(() => []);
    const match = workspaces
      .filter((w) => cwd === w.rootPath || cwd.startsWith(w.rootPath.endsWith(sep) ? w.rootPath : w.rootPath + sep))
      .sort((a, b) => b.rootPath.length - a.rootPath.length)[0];
    workspaceId = match?.id ?? null;
  }

  const body: PeerSourceResponse = {
    source: {
      sessionId: found.sessionId,
      cwd: found.cwd,
      name: found.name,
      live: found.live,
      hostedHere: !!sessionManager.get(found.sessionId),
      workspaceId,
    },
  };
  return NextResponse.json(body);
}
