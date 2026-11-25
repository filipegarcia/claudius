import { NextResponse } from "next/server";
import { addGroup, listAll, removeGroup } from "@/lib/server/hooks";
import { handlerTypeAllowed, HOOK_EVENT_NAMES, type HookEvent, type HookGroup } from "@/lib/shared/hook-events";
import type { SettingsScope } from "@/lib/server/settings";
import { resolveTrustedCwd } from "@/lib/server/trusted-cwd";

export const runtime = "nodejs";

const SCOPES: SettingsScope[] = ["user", "project", "local"];

export async function GET(req: Request) {
  const url = new URL(req.url);
  const cwd = await resolveTrustedCwd(url.searchParams.get("cwd"));
  if (!cwd) return NextResponse.json({ error: "unknown cwd" }, { status: 400 });
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
  // SDK 0.3.332 — the engine refuses every skill shell command when a prompt
  // or agent hook sits on PreSkillShellCommand (CC 2.1.280: agent hooks on
  // PermissionRequest). Don't write a handler that can't run.
  const disallowed = body.group.hooks.find((h) => !handlerTypeAllowed(h?.type, body.event));
  if (disallowed)
    return NextResponse.json(
      { error: `${disallowed.type} hooks don't run on ${body.event} — use command or http` },
      { status: 400 },
    );
  const cwd = await resolveTrustedCwd(body.cwd);
  if (!cwd) return NextResponse.json({ error: "unknown cwd" }, { status: 400 });
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
  const cwd = await resolveTrustedCwd(body.cwd);
  if (!cwd) return NextResponse.json({ error: "unknown cwd" }, { status: 400 });
  const ok = await removeGroup(body.scope, cwd, body.event, body.index);
  if (!ok) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
