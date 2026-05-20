import { NextResponse } from "next/server";

import { startImport, validateBundle } from "@/lib/server/settings-import";
import type { SettingsBundle } from "@/lib/shared/settings-bundle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `POST /api/settings/import` — kicks off a new import session.
 *
 * Accepts the bundle two ways so the UI can offer both a file-picker and a
 * "paste JSON" textarea without two endpoints:
 *
 *   - `Content-Type: application/json` → body IS the bundle.
 *   - `Content-Type: multipart/form-data` → the `file` field holds the
 *     bundle file; we read it server-side.
 *
 * On success returns the initial `ImportProgress`. Most imports pause on the
 * first workspace (a missing rootPath); the client loops on `/resolve` from
 * there.
 */
export async function POST(req: Request) {
  const ct = req.headers.get("content-type")?.toLowerCase() ?? "";

  let parsed: unknown;
  if (ct.includes("multipart/form-data")) {
    const form = await req.formData();
    const file = form.get("file");
    if (!file || typeof file === "string") {
      return NextResponse.json({ error: "missing file field" }, { status: 400 });
    }
    const text = await file.text();
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      return NextResponse.json(
        { error: `invalid JSON: ${err instanceof Error ? err.message : String(err)}` },
        { status: 400 },
      );
    }
  } else {
    try {
      parsed = await req.json();
    } catch (err) {
      return NextResponse.json(
        { error: `invalid JSON: ${err instanceof Error ? err.message : String(err)}` },
        { status: 400 },
      );
    }
  }

  if (!validateBundle(parsed)) {
    return NextResponse.json(
      { error: "bundle failed validation (missing version or workspaces array)" },
      { status: 400 },
    );
  }

  const progress = await startImport(parsed as SettingsBundle);
  return NextResponse.json(progress);
}
