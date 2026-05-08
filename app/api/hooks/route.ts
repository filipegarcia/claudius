import { NextResponse } from "next/server";
import { addGroup, listAll, removeGroup, setDisableAllHooks } from "@/lib/server/hooks";
import { HOOK_EVENT_NAMES, type HookEvent, type HookGroup } from "@/lib/shared/hook-events";
import type { SettingsScope } from "@/lib/server/settings";

export const runtime = "nodejs";

const SCOPES: SettingsScope[] = ["user", "project", "local"];

export async function GET(req: Request) {
  const url = new URL(req.url);
  const cwd = url.searchParams.get("cwd") || process.cwd();
  const data = await listAll(cwd);
  return NextResponse.json({ cwd, scopes: data });
}

type PostBody = {
  scope: SettingsScope;
  cwd?: string;
  event: HookEvent;
  group: HookGroup;
};

export async function POST(req: Request) {
  const body = (await req.json()) as PostBody;
  if (!body?.scope || !SCOPES.includes(body.scope))
    return NextResponse.json({ error: "invalid scope" }, { status: 400 });
  if (!HOOK_EVENT_NAMES.includes(body.event))
    return NextResponse.json({ error: "invalid event" }, { status: 400 });
  if (!body?.group?.hooks?.length)
    return NextResponse.json({ error: "group.hooks required" }, { status: 400 });
  const cwd = body.cwd || process.cwd();
  await addGroup(body.scope, cwd, body.event, body.group);
  return NextResponse.json({ ok: true });
}

type DeleteBody = {
  scope: SettingsScope;
  cwd?: string;
  event: HookEvent;
  index: number;
};

export async function DELETE(req: Request) {
  const body = (await req.json()) as DeleteBody;
  if (!body?.scope || !SCOPES.includes(body.scope))
    return NextResponse.json({ error: "invalid scope" }, { status: 400 });
  if (!HOOK_EVENT_NAMES.includes(body.event))
    return NextResponse.json({ error: "invalid event" }, { status: 400 });
  if (typeof body.index !== "number")
    return NextResponse.json({ error: "index required" }, { status: 400 });
  const cwd = body.cwd || process.cwd();
  const ok = await removeGroup(body.scope, cwd, body.event, body.index);
  if (!ok) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
