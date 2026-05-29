import { NextResponse } from "next/server";
import { getPricingStatus, refreshPricing } from "@/lib/server/litellm-pricing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Current pricing source (refreshed cache vs bundled snapshot) + model count. */
export async function GET() {
  return NextResponse.json(await getPricingStatus());
}

/** Force an immediate fetch of LiteLLM list prices and update the on-disk cache. */
export async function POST() {
  const result = await refreshPricing();
  const status = result.ok ? 200 : result.source === "disabled" ? 503 : 502;
  return NextResponse.json(result, { status });
}
