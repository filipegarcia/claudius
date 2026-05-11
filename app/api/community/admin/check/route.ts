import { NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * Tells the client whether this Claudius install is configured as a
 * community admin. The admin token itself never leaves the server — the
 * client only learns the boolean. When true, the UI unlocks moderation
 * controls and routes them through `/api/community/admin/[...path]`.
 */
export async function GET() {
  const configured =
    !!process.env.CLAUDIUS_CHAT_ADMIN_TOKEN &&
    !!process.env.NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL;
  return NextResponse.json({ configured });
}
