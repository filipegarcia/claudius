import { NextResponse } from "next/server";
import { checkForUpdates } from "@/lib/server/updater/detect";

export const runtime = "nodejs";

export async function POST() {
  const result = await checkForUpdates();
  return NextResponse.json(result);
}
