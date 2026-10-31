import { NextResponse } from "next/server";
import { getReleaseChangelog } from "@/lib/server/updater/release-changelog";
import { toReleaseTag } from "@/lib/shared/release-changelog";

export const runtime = "nodejs";

/**
 * `GET /api/updater/changelog?from=0.3.296.1&to=0.3.298.0`
 *
 * What changed between the running desktop build and the offered update,
 * grouped for the update modal. `from`/`to` accept either the bare version or
 * the `v`-prefixed tag; anything that isn't a release tag is rejected before
 * it reaches the GitHub URL.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const from = toReleaseTag(url.searchParams.get("from") ?? "");
  const to = toReleaseTag(url.searchParams.get("to") ?? "");
  if (!from || !to) {
    return NextResponse.json({ error: "from and to must be release versions" }, { status: 400 });
  }
  if (from === to) {
    return NextResponse.json({ error: "same version" }, { status: 400 });
  }
  const result = await getReleaseChangelog(from, to);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 502 });
  }
  return NextResponse.json(result.changelog);
}
