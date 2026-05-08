import { NextResponse } from "next/server";
import { setDisableAllHooks } from "@/lib/server/hooks";
import type { SettingsScope } from "@/lib/server/settings";

export const runtime = "nodejs";

const SCOPES: SettingsScope[] = ["user", "project", "local"];

type Body = { scope: SettingsScope; cwd?: string; disabled: boolean };

export async function POST(req: Request) {
  const body = (await req.json()) as Body;
  if (!body?.scope || !SCOPES.includes(body.scope))
    return NextResponse.json({ error: "invalid scope" }, { status: 400 });
  const cwd = body.cwd || process.cwd();
  await setDisableAllHooks(body.scope, cwd, !!body.disabled);
  return NextResponse.json({ ok: true });
}
