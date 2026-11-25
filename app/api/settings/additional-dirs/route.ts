import { NextResponse } from "next/server";
import { readSettings, settingsSaveFailure, withSettingsLock, writeSettings, type SettingsScope } from "@/lib/server/settings";
import { resolveTrustedCwd } from "@/lib/server/trusted-cwd";

export const runtime = "nodejs";

const SCOPES: SettingsScope[] = ["user", "project", "local"];

type Body = {
  scope: SettingsScope;
  cwd?: string;
  add?: string[];
  remove?: string[];
};

/**
 * CC 2.1.257 — "Changed --add-dir, /add-dir, and additionalDirectories to
 * refuse network paths (UNC shares, /net/<host> automounts) with a message
 * before touching them; on Windows use a mapped drive letter." A network
 * path can silently hang or block on a stalled mount, and worse, its
 * ownership/ACLs live outside this machine's trust boundary — reject
 * before it's ever written to settings.json (this route is the one real
 * write path for `/add-dir`; `resolveWorkspaceRoot`/`workspace-roots.ts`
 * only *read* whatever's already there).
 */
function isNetworkPath(raw: string): boolean {
  const p = raw.trim();
  return /^\\\\[^\\]+\\/.test(p) || /^\/net\/[^/]+(\/|$)/.test(p);
}

export async function POST(req: Request) {
  const body = (await req.json()) as Body;
  if (!body?.scope || !SCOPES.includes(body.scope))
    return NextResponse.json({ error: "invalid scope" }, { status: 400 });
  const rejected = (body.add ?? []).filter(isNetworkPath);
  if (rejected.length > 0) {
    return NextResponse.json(
      {
        error: `Network paths aren't allowed as additional directories: ${rejected.join(", ")}. On Windows, use a mapped drive letter instead.`,
      },
      { status: 400 },
    );
  }
  const cwd = await resolveTrustedCwd(body.cwd);
  if (!cwd) return NextResponse.json({ error: "unknown cwd" }, { status: 400 });
  // CC 2.1.326 — a folder must never look added when the file wasn't
  // written: return a message naming the file instead of a bare 500.
  try {
    return await saveAdditionalDirs(body, cwd);
  } catch (err) {
    const { status, error } = settingsSaveFailure(body.scope, cwd, err);
    return NextResponse.json({ error }, { status });
  }
}

async function saveAdditionalDirs(body: Body, cwd: string): Promise<NextResponse> {
  return withSettingsLock(body.scope, cwd, async () => {
    const settings = await readSettings(body.scope, cwd);
    const current = new Set(
      Array.isArray(settings.permissions?.additionalDirectories)
        ? (settings.permissions?.additionalDirectories as string[])
        : [],
    );
    for (const a of body.add ?? []) current.add(a);
    for (const r of body.remove ?? []) current.delete(r);
    const arr = [...current];
    const next = {
      ...settings,
      permissions: {
        ...(settings.permissions ?? {}),
        additionalDirectories: arr.length ? arr : undefined,
      },
    };
    // Strip empty permissions block to keep the file tidy.
    if (next.permissions && Object.keys(next.permissions).every((k) => (next.permissions as Record<string, unknown>)[k] == null)) {
      delete (next as { permissions?: unknown }).permissions;
    }
    await writeSettings(body.scope, cwd, next);
    return NextResponse.json({ ok: true, additionalDirectories: arr });
  });
}
