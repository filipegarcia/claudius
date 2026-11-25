import { NextResponse } from "next/server";
import { homedir } from "node:os";
import { runApiConnectivity } from "@/lib/server/api-connectivity";
import { engineEnv } from "@/lib/server/engine-env";
import { resolveManagedModelPolicy } from "@/lib/server/managed-model-policy";

export const runtime = "nodejs";

/**
 * CC 2.1.331 parity — the API connectivity section of /doctor (see
 * `lib/server/api-connectivity.ts`). Its own route, not part of
 * `GET /api/doctor`: the test waits up to 10 s for an answer, and the rest of
 * the report shouldn't wait with it. Takes no input — the URL comes from the
 * env (`ANTHROPIC_BASE_URL`), never from the request.
 */
export async function GET() {
  const env = await engineEnv();
  const policy = await resolveManagedModelPolicy(homedir());
  const report = await runApiConnectivity(env, {
    probe: async (url, init) => {
      const res = await fetch(url, init);
      await res.body?.cancel().catch(() => {});
      return { status: res.status };
    },
    managedSettingsDidNotLoad: Array.isArray(policy.didNotLoad) && policy.didNotLoad.length > 0,
  });
  return NextResponse.json(report);
}
