import { NextResponse } from "next/server";
import {
  isSkillOverrideValue,
  readSettings,
  updateSkillOverride,
  type SkillOverrideValue,
} from "@/lib/server/settings";
import { resolveTrustedCwd } from "@/lib/server/trusted-cwd";

export const runtime = "nodejs";

type Body = {
  cwd?: string;
  name: string;
  value: SkillOverrideValue;
};

/**
 * CC 2.1.280 parity — the `/skills` overlay's on/off toggle. Project-scoped
 * only (see `updateSkillOverride`'s doc comment), so unlike
 * `/api/settings/permissions` there's no per-scope fan-out here.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const cwd = await resolveTrustedCwd(url.searchParams.get("cwd"));
  if (!cwd) return NextResponse.json({ error: "unknown cwd" }, { status: 400 });
  const settings = await readSettings("project", cwd);
  return NextResponse.json({ skillOverrides: settings.skillOverrides ?? {} });
}

export async function POST(req: Request) {
  const body = (await req.json()) as Body;
  if (!body?.name || typeof body.name !== "string") {
    return NextResponse.json({ error: "name required" }, { status: 400 });
  }
  if (!isSkillOverrideValue(body.value)) {
    return NextResponse.json({ error: "invalid value" }, { status: 400 });
  }
  const cwd = await resolveTrustedCwd(body.cwd);
  if (!cwd) return NextResponse.json({ error: "unknown cwd" }, { status: 400 });
  const next = await updateSkillOverride(cwd, body.name, body.value);
  return NextResponse.json({ ok: true, skillOverrides: next.skillOverrides ?? {} });
}
