import { NextResponse } from "next/server";
import { readIcon, writeIcon } from "@/lib/server/workspaces-store";

export const runtime = "nodejs";

const MAX = 2 * 1024 * 1024;
// Detect by magic bytes — never trust the upload's filename / declared MIME.
function sniffExt(buf: Buffer): "png" | "jpg" | "webp" | null {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (
    buf.length > 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  )
    return "webp";
  return null;
}

const MIME_FOR_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const r = await readIcon(id);
  if (!r) return NextResponse.json({ error: "no icon" }, { status: 404 });
  const mime = MIME_FOR_EXT[r.ext] ?? "application/octet-stream";
  return new Response(new Uint8Array(r.buf), {
    headers: {
      "Content-Type": mime,
      "Content-Length": String(r.buf.byteLength),
      "Cache-Control": "public, max-age=300",
    },
  });
}

type PostBody = { data?: string }; // base64 (no data: prefix)

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = (await req.json()) as PostBody;
  if (!body?.data) return NextResponse.json({ error: "data (base64) required" }, { status: 400 });
  const buf = Buffer.from(body.data, "base64");
  if (buf.length > MAX) return NextResponse.json({ error: "image too large (>2MB)" }, { status: 400 });
  const ext = sniffExt(buf);
  if (!ext) return NextResponse.json({ error: "unsupported image (PNG/JPEG/WebP only)" }, { status: 400 });
  await writeIcon(id, ext, buf);
  return NextResponse.json({ ok: true, ext });
}
