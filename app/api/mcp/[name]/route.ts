import { NextResponse } from "next/server";
import { removeServer, type McpScope } from "@/lib/server/mcp";
import { SettingsParseError } from "@/lib/server/settings";
import { resolveTrustedCwd } from "@/lib/server/trusted-cwd";

export const runtime = "nodejs";

const SCOPES: McpScope[] = ["user", "project", "local"];

export async function DELETE(req: Request, ctx: { params: Promise<{ name: string }> }) {
  const { name } = await ctx.params;
  const url = new URL(req.url);
  const scope = url.searchParams.get("scope") as McpScope | null;
  const cwd = await resolveTrustedCwd(url.searchParams.get("cwd"));
  if (!cwd) return NextResponse.json({ error: "unknown cwd" }, { status: 400 });
  if (!scope || !SCOPES.includes(scope))
    return NextResponse.json({ error: "invalid scope" }, { status: 400 });
  // CC 2.1.330 — the /mcp page now shows why a Remove didn't happen, so say
  // it in words rather than a bare 404 or an HTML 500.
  let ok: boolean;
  try {
    ok = await removeServer(scope, cwd, name);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: err instanceof SettingsParseError ? 422 : 500 },
    );
  }
  if (!ok)
    return NextResponse.json(
      { error: `"${name}" isn't in the ${scope} config any more. Refresh to see the current list.` },
      { status: 404 },
    );
  return NextResponse.json({ ok: true });
}
