import { promises as fs } from "node:fs";
import { isAbsolute, normalize, relative, resolve, sep } from "node:path";
import { resolveWorkspaceRoot } from "@/lib/server/workspace-roots";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Path-based file server for the HTML preview iframes.
 *
 * GET /api/workspaces/:id/files/preview/site/index.html
 *   → serves site/index.html from the workspace root
 *
 * GET /api/workspaces/:id/files/preview/site/style.css
 *   → serves site/style.css
 *
 * Using a real URL path (rather than `?path=` query + srcdoc) means the
 * browser resolves relative URLs naturally: a CSS `href="style.css"` inside
 * index.html resolves to `.../preview/site/style.css` without any rewriting.
 *
 * Path safety: same resolve()+startsWith() pattern as the sibling route.ts,
 * per CLAUDE.md js/path-injection rules — inline check, no helpers.
 */

const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  cjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  jsonc: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  bmp: "image/bmp",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  txt: "text/plain; charset=utf-8",
  xml: "application/xml; charset=utf-8",
};

function inside(root: string, target: string): boolean {
  const r = relative(root, target);
  if (r === "") return true;
  return !r.startsWith("..") && !isAbsolute(r);
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string; path: string[] }> },
) {
  const { id, path: segments } = await ctx.params;

  const resolved = await resolveWorkspaceRoot(id, null);
  if (!resolved) {
    return new Response("workspace not found", { status: 404 });
  }

  // segments is the [...path] catch-all — join to a relative path string
  const relPath = segments.join("/");
  const root = resolved.root.absPath;

  // Resolve strictly inside workspace root (CLAUDE.md path-injection rule).
  const rel = normalize(relPath).replace(/^\/+/, "");
  const target = resolve(root, rel);
  if (!target.startsWith(root + sep)) {
    return new Response("path escapes workspace root", { status: 403 });
  }
  if (!inside(root, target)) {
    return new Response("path escapes workspace root", { status: 403 });
  }

  let content: Buffer;
  try {
    content = await fs.readFile(target);
  } catch {
    return new Response("not found", { status: 404 });
  }

  const ext = relPath.split(".").pop()?.toLowerCase() ?? "";
  const contentType = MIME[ext] ?? "application/octet-stream";

  return new Response(new Blob([content.buffer as ArrayBuffer], { type: contentType }), {
    headers: {
      // Content-Type is set via Blob; repeat here so it's explicit in headers.
      "Content-Type": contentType,
      // No caching — preview files change as the user edits
      "Cache-Control": "private, no-store",
    },
  });
}
