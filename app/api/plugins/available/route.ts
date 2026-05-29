import { NextResponse } from "next/server";
import { listAvailable } from "@/lib/server/plugins";

export const runtime = "nodejs";

export async function GET() {
  const plugins = await listAvailable();
  return NextResponse.json({ plugins });
}
