import { NextResponse } from "next/server";
import { readSettings, type SettingsScope } from "@/lib/server/settings";

export const runtime = "nodejs";

const SCOPES: SettingsScope[] = ["user", "project", "local"];

export async function GET(req: Request) {
  const url = new URL(req.url);
  const scope = (url.searchParams.get("scope") as SettingsScope | null) ?? null;
  const cwd = url.searchParams.get("cwd") || process.cwd();
  if (scope) {
    if (!SCOPES.includes(scope)) return NextResponse.json({ error: "invalid scope" }, { status: 400 });
    const settings = await readSettings(scope, cwd);
    return NextResponse.json({ scope, settings });
  }
  const all = await Promise.all(
    SCOPES.map(async (s) => ({ scope: s, settings: await readSettings(s, cwd) })),
  );
  return NextResponse.json({ scopes: all });
}
