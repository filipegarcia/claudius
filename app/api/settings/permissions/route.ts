import { NextResponse } from "next/server";
import {
  readSettings,
  updatePermissions,
  type PermissionRules,
  type SettingsScope,
} from "@/lib/server/settings";
import { resolveTrustedCwd } from "@/lib/server/trusted-cwd";

export const runtime = "nodejs";

const SCOPES: SettingsScope[] = ["user", "project", "local"];

type Body = {
  scope: SettingsScope;
  cwd?: string;
  patch: Partial<PermissionRules>;
};

export async function POST(req: Request) {
  const body = (await req.json()) as Body;
  if (!body?.scope || !SCOPES.includes(body.scope)) {
    return NextResponse.json({ error: "invalid scope" }, { status: 400 });
  }
  if (!body.patch || typeof body.patch !== "object") {
    return NextResponse.json({ error: "patch required" }, { status: 400 });
  }
  const cwd = await resolveTrustedCwd(body.cwd);
  if (!cwd) return NextResponse.json({ error: "unknown cwd" }, { status: 400 });
  const next = await updatePermissions(body.scope, cwd, body.patch);
  return NextResponse.json({ ok: true, settings: next });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const cwd = await resolveTrustedCwd(url.searchParams.get("cwd"));
  if (!cwd) return NextResponse.json({ error: "unknown cwd" }, { status: 400 });
  const out: Record<string, PermissionRules> = {};
  for (const scope of SCOPES) {
    const s = await readSettings(scope, cwd);
    out[scope] = s.permissions ?? {};
  }
  return NextResponse.json(out);
}
