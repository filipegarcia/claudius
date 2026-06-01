import { NextResponse } from "next/server";
import {
  getProfileInfoForAccount,
} from "@/lib/server/account-profile";
import { readAccountsRaw } from "@/lib/server/accounts-store";

export const runtime = "nodejs";

/**
 * GET /api/accounts/profile?id=<profileId>&refresh=1
 *
 * Resolve the email / org / subscription / rate-limit-tier metadata
 * for the given account-switcher profile by calling Anthropic's
 * `/api/oauth/profile` endpoint server-side. Server-side because (a)
 * the access token must never leave the host, (b) the upstream
 * endpoint isn't CORS-friendly.
 *
 * When `id` is omitted, default to the currently active profile —
 * which is the canonical "what does the Account section show" case.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  let id = url.searchParams.get("id");
  const refresh = url.searchParams.get("refresh") === "1";
  if (!id) {
    const cur = await readAccountsRaw();
    id = cur.activeProfileId;
  }
  if (!id) {
    return NextResponse.json({ info: null });
  }
  const info = await getProfileInfoForAccount(id, { skipCache: refresh });
  return NextResponse.json({ info });
}
