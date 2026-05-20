import { NextResponse } from "next/server";

import { buildExportBundle, suggestedFilename } from "@/lib/server/settings-export";

export const runtime = "nodejs";
// Bundles vary per request (workspaces edited mid-session, etc.). Tell
// Next.js not to try to cache the response.
export const dynamic = "force-dynamic";

/**
 * `GET /api/settings/export` — returns the full Claudius bundle as a
 * downloadable JSON file. The `Content-Disposition` header makes browsers
 * treat the response as an attachment (instead of rendering it inline),
 * which is what the Backup section's "Export" button relies on when it
 * navigates to this URL.
 */
export async function GET(): Promise<Response> {
  const bundle = await buildExportBundle();
  const body = JSON.stringify(bundle, null, 2);
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${suggestedFilename(bundle.exportedAt)}"`,
      // Length lets the browser show real progress on slow connections.
      "Content-Length": String(Buffer.byteLength(body)),
    },
  });
}
