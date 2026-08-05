import { NextResponse } from "next/server";
import {
  pathFor,
  readSettings,
  writeSettings,
  type ClaudeSettings,
  type SettingsScope,
} from "@/lib/server/settings";
import { resolveTrustedCwd } from "@/lib/server/trusted-cwd";

export const runtime = "nodejs";

const SCOPES: SettingsScope[] = ["user", "project", "local"];

export async function GET(req: Request) {
  const url = new URL(req.url);
  const cwd = await resolveTrustedCwd(url.searchParams.get("cwd"));
  if (!cwd) return NextResponse.json({ error: "unknown cwd" }, { status: 400 });
  const out = await Promise.all(
    SCOPES.map(async (scope) => ({
      scope,
      path: pathFor(scope, cwd),
      settings: await readSettings(scope, cwd),
    })),
  );
  return NextResponse.json({ cwd, scopes: out });
}

type PutBody = { scope: SettingsScope; cwd?: string; settings: ClaudeSettings };

export async function PUT(req: Request) {
  const body = (await req.json()) as PutBody;
  if (!body?.scope || !SCOPES.includes(body.scope))
    return NextResponse.json({ error: "invalid scope" }, { status: 400 });
  if (typeof body.settings !== "object" || body.settings == null)
    return NextResponse.json({ error: "settings required" }, { status: 400 });
  const cwd = await resolveTrustedCwd(body.cwd);
  if (!cwd) return NextResponse.json({ error: "unknown cwd" }, { status: 400 });
  await writeSettings(body.scope, cwd, body.settings);
  return NextResponse.json({ ok: true });
}
