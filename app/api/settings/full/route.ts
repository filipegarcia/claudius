import { NextResponse } from "next/server";
import {
  pathFor,
  readSettings,
  writeSettings,
  type ClaudeSettings,
  type SettingsScope,
} from "@/lib/server/settings";
import { resolveTrustedCwd } from "@/lib/server/trusted-cwd";
import { applySettingsPatch, parseSettingsPatch } from "@/lib/shared/settings-patch";

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

/**
 * `patch` (CC 2.1.323): only the top-level keys the user changed, applied to
 * a fresh read of the file, so a hand edit made after the page loaded isn't
 * undone. `settings` (a whole-document replace) is kept for older callers.
 */
type PutBody = { scope: SettingsScope; cwd?: string; settings?: ClaudeSettings; patch?: unknown };

export async function PUT(req: Request) {
  const body = (await req.json()) as PutBody;
  if (!body?.scope || !SCOPES.includes(body.scope))
    return NextResponse.json({ error: "invalid scope" }, { status: 400 });
  const patch = body.patch !== undefined ? parseSettingsPatch(body.patch) : null;
  if (body.patch !== undefined && !patch) return NextResponse.json({ error: "invalid patch" }, { status: 400 });
  if (!patch && (typeof body.settings !== "object" || body.settings == null))
    return NextResponse.json({ error: "settings required" }, { status: 400 });
  const cwd = await resolveTrustedCwd(body.cwd);
  if (!cwd) return NextResponse.json({ error: "unknown cwd" }, { status: 400 });
  if (patch) {
    const current = await readSettings(body.scope, cwd);
    await writeSettings(body.scope, cwd, applySettingsPatch(current as Record<string, unknown>, patch) as ClaudeSettings);
  } else {
    await writeSettings(body.scope, cwd, body.settings as ClaudeSettings);
  }
  return NextResponse.json({ ok: true });
}
