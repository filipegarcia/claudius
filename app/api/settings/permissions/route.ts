import { NextResponse } from "next/server";
import {
  readSettings,
  updatePermissionRuleList,
  updatePermissions,
  type PermissionRules,
  type SettingsScope,
} from "@/lib/server/settings";
import { resolveTrustedCwd } from "@/lib/server/trusted-cwd";

export const runtime = "nodejs";

const SCOPES: SettingsScope[] = ["user", "project", "local"];

type Body = {
  scope: SettingsScope;
  cwd?: string;
  patch?: Partial<PermissionRules>;
  /**
   * CC 2.1.323 — add/remove rules on one list, applied to a fresh read so a
   * rule hand-added to the file since the page loaded survives.
   */
  ruleDelta?: { kind: "allow" | "ask" | "deny"; add?: string[]; remove?: string[] };
};

const RULE_KINDS = ["allow", "ask", "deny"] as const;
const isStringList = (v: unknown): v is string[] | undefined =>
  v === undefined || (Array.isArray(v) && v.every((x) => typeof x === "string"));

export async function POST(req: Request) {
  const body = (await req.json()) as Body;
  if (!body?.scope || !SCOPES.includes(body.scope)) {
    return NextResponse.json({ error: "invalid scope" }, { status: 400 });
  }
  const delta = body.ruleDelta;
  if (delta !== undefined) {
    if (
      !delta ||
      typeof delta !== "object" ||
      !RULE_KINDS.includes(delta.kind) ||
      !isStringList(delta.add) ||
      !isStringList(delta.remove)
    ) {
      return NextResponse.json({ error: "invalid ruleDelta" }, { status: 400 });
    }
  } else if (!body.patch || typeof body.patch !== "object") {
    return NextResponse.json({ error: "patch required" }, { status: 400 });
  }
  const cwd = await resolveTrustedCwd(body.cwd);
  if (!cwd) return NextResponse.json({ error: "unknown cwd" }, { status: 400 });
  const next = delta
    ? await updatePermissionRuleList(body.scope, cwd, delta.kind, { add: delta.add, remove: delta.remove })
    : await updatePermissions(body.scope, cwd, body.patch as Partial<PermissionRules>);
  return NextResponse.json({ ok: true, settings: next });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const cwd = await resolveTrustedCwd(url.searchParams.get("cwd"));
  if (!cwd) return NextResponse.json({ error: "unknown cwd" }, { status: 400 });
  const out: Record<string, PermissionRules> = {};
  for (const scope of SCOPES) {
    const s = await readSettings(scope, cwd);
    out[scope] = s.permissions ?? {};
  }
  return NextResponse.json(out);
}
