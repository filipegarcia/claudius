import { NextResponse } from "next/server";
import {
  readSettings,
  settingsSaveFailure,
  updatePermissionRuleList,
  updatePermissions,
  type PermissionRules,
  type SettingsScope,
} from "@/lib/server/settings";
import { resolveTrustedCwd } from "@/lib/server/trusted-cwd";
import {
  permissionRuleRefusalMessage,
  validatePermissionRule,
  type PermissionRuleKind,
} from "@/lib/shared/permission-rule-lint";

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
  } else if (!RULE_KINDS.every((k) => isStringList(body.patch?.[k]))) {
    return NextResponse.json({ error: "invalid patch" }, { status: 400 });
  }
  // CC 2.1.332 — "Improved `/permissions` to refuse a rule that would be
  // skipped at the next start, such as `rm -rf` with no tool name, and to
  // show the reason". Check every rule being added (a delta's `add`, or a
  // patch's rule lists) against the engine's validator; removals stay
  // allowed so a bad rule already in the file can be deleted.
  const adding: Array<[PermissionRuleKind, string]> = delta
    ? (delta.add ?? []).map((r) => [delta.kind, r])
    : RULE_KINDS.flatMap((k) => (body.patch?.[k] ?? []).map((r): [PermissionRuleKind, string] => [k, r]));
  for (const [kind, rule] of adding) {
    const reason = permissionRuleRefusalMessage(validatePermissionRule(rule, kind));
    if (reason) {
      return NextResponse.json({ error: `"${rule}" would be skipped at the next start: ${reason}` }, { status: 400 });
    }
  }
  const cwd = await resolveTrustedCwd(body.cwd);
  if (!cwd) return NextResponse.json({ error: "unknown cwd" }, { status: 400 });
  // CC 2.1.326 — a rule must never look saved when the file wasn't written:
  // return a message naming the file instead of a bare 500.
  try {
    const next = delta
      ? await updatePermissionRuleList(body.scope, cwd, delta.kind, { add: delta.add, remove: delta.remove })
      : await updatePermissions(body.scope, cwd, body.patch as Partial<PermissionRules>);
    return NextResponse.json({ ok: true, settings: next });
  } catch (err) {
    const { status, error } = settingsSaveFailure(body.scope, cwd, err);
    return NextResponse.json({ error }, { status });
  }
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
