import { NextResponse } from "next/server";
import { openDb } from "@/lib/server/db";

/**
 * Readiness probe. Returns 200 only when the server can talk to its
 * dependencies — today that means the per-workspace SQLite database
 * loads, migrations apply cleanly, and a trivial query round-trips.
 *
 * Returns 503 with a `{ status: "fail", failed: [...] }` payload when a
 * check trips, so monitoring tooling can drain the instance from a pool
 * while leaving `/api/heartbeat` (pure liveness) returning 200.
 *
 * The DB is per-workspace (`~/.claude/projects/<encoded-cwd>/.claudius.db`).
 * We probe against `process.cwd()` — the install directory the server was
 * launched from — because that's the workspace `openDb()` would lazily
 * create on a first real request anyway. This keeps the readiness check
 * cwd-independent and doesn't depend on a user having clicked
 * "activate workspace" yet.
 */
export const runtime = "nodejs";

type Check = {
  id: string;
  status: "ok" | "fail";
  detail?: string;
};

async function checkDb(): Promise<Check> {
  try {
    const db = await openDb(process.cwd());
    const row = db.prepare<[], { ok: number }>("SELECT 1 AS ok").get();
    if (row?.ok !== 1) {
      return { id: "db", status: "fail", detail: "SELECT 1 returned no row" };
    }
    return { id: "db", status: "ok" };
  } catch (err) {
    return {
      id: "db",
      status: "fail",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function GET() {
  const checks: Check[] = [await checkDb()];
  const failed = checks.filter((c) => c.status === "fail");
  const status = failed.length === 0 ? "ok" : "fail";
  const httpStatus = failed.length === 0 ? 200 : 503;
  return NextResponse.json(
    { status, ts: Date.now(), checks, failed: failed.map((c) => c.id) },
    { status: httpStatus },
  );
}
