import { promises as fs, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/local-image?path=/abs/path.png
 *
 * Serves an image the agent wrote OUTSIDE the workspace — in practice the
 * screenshots it drops under `/tmp` and then references as `![…](/tmp/x.png)`
 * in its reply. In-workspace images already go through
 * `/api/workspaces/[id]/files?serve=1`; without this route the markdown
 * renderer had nowhere to send anything else and the browser 404'd on
 * `http://host/tmp/x.png`.
 *
 * Deliberately narrow: only image extensions, only under the OS temp roots
 * (`os.tmpdir()` and `/tmp`). Route handlers are cross-origin reachable, so
 * this must never become "serve any absolute path".
 *
 * Path safety follows CLAUDE.md: the request path is rebased onto a trusted
 * root with `resolve(root, rel)` and guarded by an inline `startsWith` right
 * above each fs call (CodeQL's StartsWithDirSanitizer shape).
 */

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  ico: "image/x-icon",
  bmp: "image/bmp",
  avif: "image/avif",
  tiff: "image/tiff",
  tif: "image/tiff",
};

const MAX_BYTES = 10 * 1024 * 1024;

function realOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/**
 * Accepted prefixes → their real (symlink-resolved) location. Both spellings
 * are accepted so `/tmp/x.png` and macOS's `/private/tmp/x.png` both work.
 * Computed once; temp roots don't move while the server runs.
 */
const TEMP_ROOTS: ReadonlyMap<string, string> = (() => {
  const m = new Map<string, string>();
  for (const raw of [tmpdir(), "/tmp"]) {
    const spelled = resolve(raw);
    const real = realOrSelf(spelled);
    m.set(spelled, real);
    m.set(real, real);
  }
  return m;
})();

export async function GET(req: Request) {
  const url = new URL(req.url);
  const raw = url.searchParams.get("path") ?? "";
  if (!raw || !isAbsolute(raw)) {
    return NextResponse.json({ error: "absolute path required" }, { status: 400 });
  }
  const ext = raw.split(".").pop()?.toLowerCase() ?? "";
  const contentType = IMAGE_MIME[ext];
  if (!contentType) {
    return NextResponse.json({ error: "not a supported image type" }, { status: 415 });
  }

  // Normalize (collapses `..`) and find which temp root it claims to be under.
  const abs = resolve(raw);
  let spelledRoot: string | null = null;
  for (const root of TEMP_ROOTS.keys()) {
    if (abs.startsWith(root + sep)) {
      spelledRoot = root;
      break;
    }
  }
  if (!spelledRoot) {
    return NextResponse.json({ error: "path is outside the temp directory" }, { status: 403 });
  }
  const base = TEMP_ROOTS.get(spelledRoot)!;
  const rel = abs.slice(spelledRoot.length + 1);

  // Rebase onto the trusted real root; inline guard right above the fs calls.
  const target = resolve(base, rel);
  if (!target.startsWith(base + sep)) {
    return NextResponse.json({ error: "path escapes the temp directory" }, { status: 403 });
  }
  // A symlink inside tmp could still point elsewhere — judge the real file.
  let real: string;
  try {
    real = await fs.realpath(target);
  } catch {
    return NextResponse.json({ error: "image not found" }, { status: 404 });
  }
  if (!real.startsWith(base + sep)) {
    return NextResponse.json({ error: "path escapes the temp directory" }, { status: 403 });
  }
  let stat: import("node:fs").Stats;
  try {
    stat = await fs.stat(real);
  } catch {
    return NextResponse.json({ error: "image not found" }, { status: 404 });
  }
  if (!stat.isFile()) {
    return NextResponse.json({ error: "not a file" }, { status: 404 });
  }
  if (stat.size > MAX_BYTES) {
    return NextResponse.json({ error: "image too large (>10MB)" }, { status: 413 });
  }
  let buf: Buffer;
  try {
    buf = await fs.readFile(real);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
  // Buffer → Uint8Array: same bytes, satisfies the lib.dom BodyInit type.
  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": contentType,
      // Screenshots get overwritten between runs — keep the cache short.
      "Cache-Control": "private, max-age=10",
    },
  });
}
