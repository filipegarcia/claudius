import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const runtime = "nodejs";

/**
 * Fixed allowlist of check ids this endpoint knows how to remediate, mapped
 * to a fixed, non-user-controlled path under `homedir()`. Deliberately not
 * driven by `req.json()` path input — CC 2.1.205 parity ("/doctor ... can
 * diagnose and fix issues"), scoped to the two checks in `GET /api/doctor`
 * that are pure, safe, local mkdir operations. Anything requiring auth,
 * package installs, or shelling out (missing SDK package, no credentials,
 * git not on PATH) stays diagnose-only — see the 2.1.205 run notes for why.
 */
const FIXABLE_CHECKS: Record<string, () => string> = {
  "claude-dir": () => join(homedir(), ".claude"),
  "projects-dir": () => join(homedir(), ".claude", "projects"),
};

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const id = (body as { id?: unknown } | null)?.id;
  if (typeof id !== "string" || !(id in FIXABLE_CHECKS)) {
    return NextResponse.json({ ok: false, error: "Unknown or non-fixable check id" }, { status: 400 });
  }

  const target = FIXABLE_CHECKS[id]();
  try {
    await fs.mkdir(target, { recursive: true });
    return NextResponse.json({ ok: true, id, path: target });
  } catch (err) {
    return NextResponse.json(
      { ok: false, id, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
