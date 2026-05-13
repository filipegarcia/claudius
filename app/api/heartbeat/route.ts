import { NextResponse } from "next/server";

/**
 * Liveness probe. Returns 200 as long as the Next.js process is alive and
 * able to route a request — no I/O, no DB, no filesystem touch.
 *
 * Pair this with `/api/heartbeatz` (readiness): heartbeat tells you "the
 * server is up", heartbeatz tells you "the server can do useful work".
 *
 * Conventionally consumed by:
 *   - Uptime checkers / load-balancer health checks
 *   - `site/test/test-install-public.sh`, which curls this after `claudius`
 *     boots in a clean Docker container to confirm the install worked.
 */
export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(
    { status: "ok", ts: Date.now() },
    { status: 200 },
  );
}

export async function HEAD() {
  return new Response(null, { status: 200 });
}
