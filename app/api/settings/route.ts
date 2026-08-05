import { NextResponse } from "next/server";
import { readSettings, type SettingsScope } from "@/lib/server/settings";
import { resolveTrustedCwd } from "@/lib/server/trusted-cwd";

export const runtime = "nodejs";

const SCOPES: SettingsScope[] = ["user", "project", "local"];

export async function GET(req: Request) {
  const url = new URL(req.url);
  const scope = (url.searchParams.get("scope") as SettingsScope | null) ?? null;
  const cwd = await resolveTrustedCwd(url.searchParams.get("cwd"));
  if (!cwd) return NextResponse.json({ error: "unknown cwd" }, { status: 400 });
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
