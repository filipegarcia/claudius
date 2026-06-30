import { cookies } from "next/headers";
import { resolveActiveWorkspace } from "./active-workspace";
import {
  customizationSrcDir,
  getCustomization,
  type Customization,
} from "./customizations-store";
import type { Workspace } from "./workspaces-store";

/**
 * The active "context" in Claudius used to be solely the active workspace
 * (cookie `claudius.workspace`). Customizations are no longer backed by a
 * workspace, so they get a parallel cookie. The two are mutually exclusive:
 * selecting a workspace clears this cookie (see active-workspace.writeActiveCookie),
 * and selecting a customization clears the workspace cookie (below). This keeps
 * a stale customization cookie from hijacking the cwd of a new workspace chat.
 */
const COOKIE_CUST = "claudius.customization";
// Literal to avoid an import cycle with active-workspace.ts.
const COOKIE_WS = "claudius.workspace";

export async function readActiveCustomizationCookie(): Promise<string | null> {
  try {
    const c = await cookies();
    const v = c.get(COOKIE_CUST)?.value;
    return v && typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

export async function writeActiveCustomizationCookie(id: string): Promise<void> {
  const c = await cookies();
  c.set(COOKIE_CUST, id, {
    httpOnly: false,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  // Mutual exclusion: a customization is now active, so clear the workspace
  // cookie. Session cwd resolution checks the customization cookie first, but
  // dropping the workspace cookie keeps the two from disagreeing.
  c.delete(COOKIE_WS);
}

export async function clearActiveCustomizationCookie(): Promise<void> {
  const c = await cookies();
  c.delete(COOKIE_CUST);
}

/**
 * The customization currently selected via the `claudius.customization`
 * cookie, or null when none is set / it no longer exists.
 */
export async function resolveActiveCustomization(): Promise<Customization | null> {
  const id = await readActiveCustomizationCookie();
  if (!id) return null;
  return getCustomization(id).catch(() => null);
}

export type ActiveCwd = {
  cwd: string;
  customizationId: string | null;
  ws: Workspace | null;
};

/**
 * Unified active-context resolver. Priority:
 *   1. active customization cookie → its src dir
 *   2. active workspace → its rootPath
 *   3. process.cwd() (legacy fallback)
 * This is the single place the workspace-vs-customization priority lives, so
 * cwd-keyed surfaces (open-tabs, splash, sessions) all agree.
 */
export async function resolveActiveCwd(): Promise<ActiveCwd> {
  const cust = await resolveActiveCustomization();
  if (cust) {
    return { cwd: customizationSrcDir(cust.id), customizationId: cust.id, ws: null };
  }
  const ws = await resolveActiveWorkspace().catch(() => null);
  if (ws) return { cwd: ws.rootPath, customizationId: null, ws };
  return { cwd: process.cwd(), customizationId: null, ws: null };
}
