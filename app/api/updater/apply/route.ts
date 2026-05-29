import { NextResponse } from "next/server";
import { applyUpdate } from "@/lib/server/updater/apply";

export const runtime = "nodejs";

/**
 * Manual apply trigger. Body may include `{ allowCcMerge: true }` to opt
 * into the Claude-merge path even when settings are notify-only or ff-only
 * — i.e. the user clicked the explicit "Let Claude resolve" button.
 *
 * Note: a successful apply will SIGTERM this process ~1.5s after the
 * response is sent. The detached restarter then re-execs claudiusd. So the
 * client should expect the connection to drop after this returns.
 */
export async function POST(req: Request) {
  let allowCcMerge = false;
  try {
    const body = (await req.json()) as { allowCcMerge?: boolean } | null;
    allowCcMerge = body?.allowCcMerge === true;
  } catch {
    // Empty body is fine — defaults to allowCcMerge=false.
  }
  const outcome = await applyUpdate({ allowCcMerge });
  return NextResponse.json(outcome);
}
