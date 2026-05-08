import { NextResponse } from "next/server";
import { readSettings, writeSettings, type SettingsScope } from "@/lib/server/settings";

export const runtime = "nodejs";

const SCOPES: SettingsScope[] = ["user", "project", "local"];

type Body = {
  scope: SettingsScope;
  cwd?: string;
  add?: string[];
  remove?: string[];
};

export async function POST(req: Request) {
  const body = (await req.json()) as Body;
  if (!body?.scope || !SCOPES.includes(body.scope))
    return NextResponse.json({ error: "invalid scope" }, { status: 400 });
  const cwd = body.cwd || process.cwd();
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
}
