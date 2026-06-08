import { NextResponse } from "next/server";
import { resolveActiveWorkspace } from "@/lib/server/active-workspace";
import {
  getActiveTab,
  getOpenTabs,
  getTabLabelMaxWidth,
  setActiveTab,
  setOpenTabs,
  setTabLabelMaxWidth,
  TAB_LABEL_DEFAULT,
} from "@/lib/server/open-tabs-db";
import { getSessionTitlesByCwd } from "@/lib/server/sessions-db";

export const runtime = "nodejs";

/**
 * Persistent tab strip — stores the user's open session-tab list in the
 * per-cwd `.claudius.db` so closing the browser and coming back later
 * restores the same tabs.
 *
 * cwd resolution mirrors the active-workspace path used by /api/sessions:
 * cookie → bootstrap hint → fall back to process.cwd() if no workspace is
 * configured. The DB file itself is keyed by cwd, so a workspace switch
 * naturally swaps the saved list — useWorkspaces.select() already does a
 * full reload after switching, so the client picks the new list up on the
 * next mount.
 *
 * v1: last-write-wins. If two browser windows are open against the same
 * workspace, whichever closes/opens a tab last clobbers the other's view.
 * Acceptable for now — we already coordinate per-session writes via
 * useTabClaim (BroadcastChannel), but tab-strip state isn't worth the
 * extra plumbing.
 */

async function activeCwd(): Promise<string> {
  const ws = await resolveActiveWorkspace().catch(() => null);
  return ws?.rootPath ?? process.cwd();
}

export async function GET() {
  const cwd = await activeCwd();
  const [tabs, activeId, labelWidth] = await Promise.all([
    getOpenTabs(cwd),
    getActiveTab(cwd),
    getTabLabelMaxWidth(cwd),
  ]);
  // Resolve persisted titles for every tab id, so the strip can render
  // proper names from the first paint — without waiting for the client's
  // `refreshSessions` to come back. `refreshSessions` already enriches
  // titles, but it sorts by recency and locally slices to the top 20
  // (use-session.ts: `sorted.slice(0, 20)`), then only re-adds *live*
  // sessions; a disk-only open tab older than the 20 most-recent
  // sessions in the workspace falls out of that merge and ends up
  // labelled with its id prefix until the user clicks it. Returning
  // titles inline here also closes the mount-race window where
  // `session.sessions` is `[]` before the first refresh resolves.
  //
  // Title lookup never throws the GET — `getSessionTitlesByCwd` already
  // tolerates failed DB opens, but defend the route too: a title miss
  // should leave the tab as a UUID, not 500 the whole strip.
  let titles: Record<string, string> = {};
  if (tabs.length > 0) {
    try {
      const titleMap = await getSessionTitlesByCwd(
        tabs.map((id) => ({ cwd, id })),
      );
      // `getSessionTitlesByCwd` keys are `${cwd}:${id}` for cwd-scoped
      // hits and `*:${id}` for cwd-less fan-out hits. The persisted strip
      // is per-cwd, so the cwd-keyed lookup is the primary; the `*:id`
      // fallback covers legitimately-renamed sessions whose JSONL header
      // dropped the cwd. Mirrors the same shape /api/sessions/all uses
      // when it enriches `claudiusTitle`.
      const out: Record<string, string> = {};
      for (const id of tabs) {
        const t = titleMap.get(`${cwd}:${id}`) ?? titleMap.get(`*:${id}`);
        if (t && t.trim()) out[id] = t.trim();
      }
      titles = out;
    } catch {
      // Best effort — fall through with no titles. The client already
      // handles "no title" by rendering the id prefix.
    }
  }
  // Pass the persisted strip through verbatim. Foreign-session-leak
  // protection used to live here as an `id ∈ listIndexedSessions(cwd)`
  // strict filter, but that turned out to drop legitimate ids the client
  // hadn't indexed yet (brand-new sessions whose `init` row was still
  // in-flight; synthetic ids the e2e suite seeds for backgrounded-tab
  // tests). The protection now lives client-side in the chat page's
  // persist effect, which filters tabs whose live `session.cwd` doesn't
  // match the workspace `rootPath` *before* PUT — same end state for
  // real users, but synthetic/test ids are no longer collateral damage.
  return NextResponse.json({
    tabs,
    activeId,
    labelMaxWidth: labelWidth ?? TAB_LABEL_DEFAULT,
    titles,
  });
}

export async function PUT(req: Request) {
  let body: { tabs?: unknown; activeId?: unknown; labelMaxWidth?: unknown } = {};
  try {
    body = (await req.json()) as {
      tabs?: unknown;
      activeId?: unknown;
      labelMaxWidth?: unknown;
    };
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const cwd = await activeCwd();
  // Each field is independently optional so the client can update either
  // the strip or the active marker without re-sending the other.
  if (body.tabs !== undefined) {
    if (!Array.isArray(body.tabs)) {
      return NextResponse.json({ error: "tabs must be an array of strings" }, { status: 400 });
    }
    const ids = body.tabs.filter((x): x is string => typeof x === "string");
    await setOpenTabs(cwd, ids);
  }
  if (body.activeId !== undefined) {
    if (body.activeId !== null && typeof body.activeId !== "string") {
      return NextResponse.json({ error: "activeId must be a string or null" }, { status: 400 });
    }
    await setActiveTab(cwd, body.activeId);
  }
  if (body.labelMaxWidth !== undefined) {
    if (typeof body.labelMaxWidth !== "number" || !Number.isFinite(body.labelMaxWidth)) {
      return NextResponse.json({ error: "labelMaxWidth must be a number" }, { status: 400 });
    }
    await setTabLabelMaxWidth(cwd, body.labelMaxWidth);
  }
  return NextResponse.json({ ok: true });
}
