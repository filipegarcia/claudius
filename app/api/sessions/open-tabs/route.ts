import { NextResponse } from "next/server";
import { resolveActiveWorkspace } from "@/lib/server/active-workspace";
import { getOpenTabs, setOpenTabs } from "@/lib/server/open-tabs-db";

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
  const tabs = await getOpenTabs(cwd);
  return NextResponse.json({ tabs });
}

export async function PUT(req: Request) {
  let body: { tabs?: unknown } = {};
  try {
    body = (await req.json()) as { tabs?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!Array.isArray(body.tabs)) {
    return NextResponse.json({ error: "tabs must be an array of strings" }, { status: 400 });
  }
  const ids = body.tabs.filter((x): x is string => typeof x === "string");
  const cwd = await activeCwd();
  await setOpenTabs(cwd, ids);
  return NextResponse.json({ ok: true });
}
