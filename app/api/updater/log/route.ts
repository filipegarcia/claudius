import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import { resolve, sep } from "node:path";
import { installRoot } from "@/lib/server/updater/root";

export const runtime = "nodejs";

/**
 * Incremental tail of the updater log so the in-place "Resolve with Claude"
 * modal can render live progress while `applyUpdate` runs in-process.
 *
 * Contract:
 *   GET /api/updater/log              → { size }            (current EOF; no body)
 *   GET /api/updater/log?offset=<n>   → { size, content }   (bytes [n, size))
 *
 * The client first calls without `offset` to capture the starting EOF (so it
 * only shows lines from THIS resolve, not the whole history), then polls with
 * the advancing offset. `size` in the response is the new offset to poll from
 * next. A capped read keeps any single poll small even if the log surges.
 */
const MAX_CHUNK = 256 * 1024;

export async function GET(req: Request) {
  const root = installRoot();
  // Fixed, non-user path. We still resolve + assert containment inline at the
  // sink (CLAUDE.md: app/api routes must keep the startsWith check visible right
  // above the fs call rather than behind a helper) so CodeQL's path-injection
  // sanitizer fires and a future refactor can't silently widen the input.
  const base = resolve(root);
  const target = resolve(base, ".claudius/logs/updater.log");
  if (!target.startsWith(base + sep)) {
    return NextResponse.json({ error: "invalid path" }, { status: 400 });
  }

  let size = 0;
  try {
    size = (await fs.stat(target)).size;
  } catch {
    // No log yet (fresh install / nothing has run) — report an empty stream.
    return NextResponse.json({ size: 0, content: "" });
  }

  const offsetParam = new URL(req.url).searchParams.get("offset");
  if (offsetParam === null) return NextResponse.json({ size });

  let offset = Number(offsetParam);
  if (!Number.isFinite(offset) || offset < 0) offset = 0;
  // The log is truncated/rotated rarely, but if it shrank below our offset,
  // resync to the new EOF rather than reading garbage.
  if (offset > size) return NextResponse.json({ size, content: "" });
  if (offset === size) return NextResponse.json({ size, content: "" });

  const len = Math.min(size - offset, MAX_CHUNK);
  const fh = await fs.open(target, "r");
  try {
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, offset);
    return NextResponse.json({ size: offset + len, content: buf.toString("utf8") });
  } finally {
    await fh.close();
  }
}
