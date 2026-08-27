import { NextResponse } from "next/server";
import { readSettings, updateAutoMode, type AutoModeConfig } from "@/lib/server/settings";
import { resolveTrustedCwd } from "@/lib/server/trusted-cwd";

export const runtime = "nodejs";

/**
 * CC 2.1.246 parity — "Added an Auto mode tab to /permissions for viewing
 * and editing auto mode classifier rules". Upstream reads `autoMode` from
 * `~/.claude/settings.json` only (see `AutoModeConfig` in
 * `lib/server/settings.ts`), so unlike `/api/settings/permissions` this
 * route has no `scope` — every request is the "user" scope.
 */

type Body = {
  cwd?: string;
  patch: Partial<AutoModeConfig>;
};

export async function POST(req: Request) {
  const body = (await req.json()) as Body;
  if (!body?.patch || typeof body.patch !== "object") {
    return NextResponse.json({ error: "patch required" }, { status: 400 });
  }
  const cwd = await resolveTrustedCwd(body.cwd);
  if (!cwd) return NextResponse.json({ error: "unknown cwd" }, { status: 400 });
  const next = await updateAutoMode(cwd, body.patch);
  return NextResponse.json({ ok: true, autoMode: next.autoMode ?? {} });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const cwd = await resolveTrustedCwd(url.searchParams.get("cwd"));
  if (!cwd) return NextResponse.json({ error: "unknown cwd" }, { status: 400 });
  const settings = await readSettings("user", cwd);
  return NextResponse.json({ autoMode: settings.autoMode ?? {} });
}
