import { NextResponse } from "next/server";
import { listAvailable } from "@/lib/server/plugins";

export const runtime = "nodejs";

export async function GET() {
  // CC 2.1.331 — say why the list failed (e.g. the marketplaces folder
  // can't be read) instead of an HTML 500 that Discover showed as "No
  // marketplaces cached yet". A missing folder is still an empty list.
  try {
    const plugins = await listAvailable();
    return NextResponse.json({ plugins });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
