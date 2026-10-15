import { NextResponse } from "next/server";
import { listFs } from "@/lib/server/fs-list";
import { resolveTrustedCwd } from "@/lib/server/trusted-cwd";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const cwd = await resolveTrustedCwd(url.searchParams.get("cwd"));
  if (!cwd) return NextResponse.json({ error: "unknown cwd" }, { status: 400 });
  const q = url.searchParams.get("q") ?? "";
  const limit = Number(url.searchParams.get("limit") ?? "200") || 200;
  try {
    const entries = await listFs({ cwd, query: q, limit });
    return NextResponse.json({ cwd, entries });
  } catch (err) {
    // CC 2.1.301 — worded as a failed search so the @-picker never shows it
    // as "no matches".
    const code = (err as NodeJS.ErrnoException).code;
    const denied = code === "EACCES" || code === "EPERM";
    return NextResponse.json(
      {
        error: `Search failed: ${
          denied ? `permission denied — can't read this folder (${code})` : err instanceof Error ? err.message : String(err)
        }`,
      },
      { status: denied ? 403 : 500 },
    );
  }
}
