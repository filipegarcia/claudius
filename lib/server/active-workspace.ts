import { cookies } from "next/headers";
import { ensureBootstrap, getActiveIdHint, type Workspace } from "./workspaces-store";

const COOKIE = "claudius.workspace";

export async function readActiveCookie(): Promise<string | null> {
  try {
    const c = await cookies();
    const v = c.get(COOKIE)?.value;
    return v && typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

export async function writeActiveCookie(id: string): Promise<void> {
  const c = await cookies();
  c.set(COOKIE, id, {
    httpOnly: false,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  // Mutual exclusion: a workspace is now active, so clear any active-
  // customization cookie. Literal name to avoid an import cycle with
  // active-customization.ts (COOKIE_CUST there).
  c.delete("claudius.customization");
}

export async function clearActiveCookie(): Promise<void> {
  const c = await cookies();
  c.delete(COOKIE);
}

export async function resolveActiveWorkspace(): Promise<Workspace | null> {
  const shape = await ensureBootstrap();
  const cookieId = await readActiveCookie();
  const fromCookie = cookieId ? shape.workspaces.find((w) => w.id === cookieId) : null;
  if (fromCookie) return fromCookie;
  const hint = await getActiveIdHint();
  return hint ? shape.workspaces.find((w) => w.id === hint) ?? null : null;
}
