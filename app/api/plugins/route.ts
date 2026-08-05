import { NextResponse } from "next/server";
import { listAll, setEnabled, setMarketplaces } from "@/lib/server/plugins";
import { sessionManager } from "@/lib/server/session-manager";
import type { SettingsScope } from "@/lib/server/settings";
import { resolveTrustedCwd } from "@/lib/server/trusted-cwd";

export const runtime = "nodejs";

const SCOPES: SettingsScope[] = ["user", "project", "local"];

export async function GET(req: Request) {
  const url = new URL(req.url);
  const cwd = await resolveTrustedCwd(url.searchParams.get("cwd"));
  if (!cwd) return NextResponse.json({ error: "unknown cwd" }, { status: 400 });
  const sessionId = url.searchParams.get("sessionId");
  const scopes = await listAll(cwd);

  // Active plugin info comes from the live SDK session if one was passed.
  let installed: unknown[] = [];
  let installedError: string | null = null;
  if (sessionId) {
    const session = sessionManager.get(sessionId);
    if (session) {
      const r = await session.reloadPlugins();
      if (r.ok) {
        const d = r.data as { plugins?: unknown[] };
        installed = Array.isArray(d.plugins) ? d.plugins : [];
      } else {
        installedError = r.error;
      }
    }
  }

  return NextResponse.json({ cwd, scopes, installed, installedError });
}

type PostBody =
  | {
      kind: "toggle";
      scope: SettingsScope;
      cwd?: string;
      pluginId: string;
      enabled: boolean;
    }
  | {
      kind: "marketplaces";
      scope: SettingsScope;
      cwd?: string;
      extraKnownMarketplaces?: string[];
      strictKnownMarketplaces?: boolean;
      blockedMarketplaces?: string[];
    };

export async function POST(req: Request) {
  const body = (await req.json()) as PostBody;
  if (!body?.scope || !SCOPES.includes(body.scope))
    return NextResponse.json({ error: "invalid scope" }, { status: 400 });
  const cwd = await resolveTrustedCwd(body.cwd);
  if (!cwd) return NextResponse.json({ error: "unknown cwd" }, { status: 400 });
  if (body.kind === "toggle") {
    if (!body.pluginId)
      return NextResponse.json({ error: "pluginId required" }, { status: 400 });
    await setEnabled(body.scope, cwd, body.pluginId, !!body.enabled);
    return NextResponse.json({ ok: true });
  }
  if (body.kind === "marketplaces") {
    await setMarketplaces(body.scope, cwd, {
      extraKnownMarketplaces: body.extraKnownMarketplaces,
      strictKnownMarketplaces: body.strictKnownMarketplaces,
      blockedMarketplaces: body.blockedMarketplaces,
    });
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: "invalid kind" }, { status: 400 });
}
