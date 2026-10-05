import { NextResponse } from "next/server";
import {
  addExtraMarketplace,
  enrichInstalled,
  listAll,
  removeExtraMarketplace,
  removePolicyMarketplaceEntry,
  setEnabled,
  setPluginOptionValue,
} from "@/lib/server/plugins";
import type { MarketplaceSource } from "@/lib/shared/marketplace-settings";
import type { PluginOptionValue } from "@/lib/shared/plugin-config";
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
  // SDK 0.3.283 — plugins that failed to load this session. The detailed
  // array (plugin / type / message / path) rides the `system:init` message
  // only; the `reload_plugins` response carries just an `error_count`. So we
  // read the session's captured init errors rather than the reload result.
  let pluginErrors: unknown[] = [];
  if (sessionId) {
    const session = sessionManager.get(sessionId);
    if (session) {
      pluginErrors = session.getPluginLoadErrors();
      const r = await session.reloadPlugins();
      if (r.ok) {
        const d = r.data as { plugins?: unknown[]; error_count?: number };
        // G2 — enrich with description/displayName from each plugin's plugin.json.
        installed = await enrichInstalled(Array.isArray(d.plugins) ? d.plugins : []);
        // The detailed `plugin_errors` array is captured once at init; a live
        // `reload_plugins` only reports a coarse `error_count`. If that count
        // is now zero, the user has fixed whatever failed (edited config, then
        // hit Reload) — drop the stale init errors so a resolved failure
        // doesn't linger. A non-zero count keeps the init detail, the best
        // description we have of what's still wrong.
        if (d.error_count === 0) pluginErrors = [];
      } else {
        installedError = r.error;
      }
    }
  }

  return NextResponse.json({ cwd, scopes, installed, installedError, pluginErrors });
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
      // G1 — structural marketplace ops (no full-list replacement, so a rich
      // object/array settings.json config is never clobbered).
      kind: "marketplaces";
      scope: SettingsScope;
      cwd?: string;
      op: "add-extra" | "remove-extra" | "remove-policy";
      name?: string;
      source?: MarketplaceSource;
      list?: "strict" | "blocked";
      index?: number;
    }
  | {
      // G3 — set/clear one plugin option value (value omitted = clear).
      kind: "plugin-config";
      scope: SettingsScope;
      cwd?: string;
      pluginId: string;
      name: string;
      value?: PluginOptionValue;
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
    if (body.op === "add-extra") {
      if (typeof body.name !== "string" || !body.source)
        return NextResponse.json({ error: "name and source required" }, { status: 400 });
      const res = await addExtraMarketplace(body.scope, cwd, body.name, body.source);
      if (!res.ok) return NextResponse.json({ error: res.error }, { status: 400 });
      return NextResponse.json({ ok: true });
    }
    if (body.op === "remove-extra") {
      if (typeof body.name !== "string")
        return NextResponse.json({ error: "name required" }, { status: 400 });
      await removeExtraMarketplace(body.scope, cwd, body.name);
      return NextResponse.json({ ok: true });
    }
    if (body.op === "remove-policy") {
      if ((body.list !== "strict" && body.list !== "blocked") || typeof body.index !== "number")
        return NextResponse.json({ error: "list and index required" }, { status: 400 });
      await removePolicyMarketplaceEntry(body.scope, cwd, body.list, body.index);
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: "invalid op" }, { status: 400 });
  }
  if (body.kind === "plugin-config") {
    if (typeof body.pluginId !== "string" || typeof body.name !== "string")
      return NextResponse.json({ error: "pluginId and name required" }, { status: 400 });
    await setPluginOptionValue(body.scope, cwd, body.pluginId, body.name, body.value);
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: "invalid kind" }, { status: 400 });
}
