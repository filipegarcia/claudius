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
  return NextResponse.json({
    tabs,
    activeId,
    labelMaxWidth: labelWidth ?? TAB_LABEL_DEFAULT,
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
