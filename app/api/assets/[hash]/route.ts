import { NextResponse } from "next/server";
import { deleteAsset, readAsset } from "@/lib/server/asset-store";
import { deleteAssetRow, getAssetMeta } from "@/lib/server/asset-list";

export const runtime = "nodejs";

export async function GET(req: Request, ctx: { params: Promise<{ hash: string }> }) {
  const { hash } = await ctx.params;
  const url = new URL(req.url);
  const cwd = url.searchParams.get("cwd") || process.cwd();
  const meta = await getAssetMeta(cwd, hash);
  if (!meta) return NextResponse.json({ error: "not found" }, { status: 404 });
  const buf = await readAsset(cwd, hash, meta.mediaType);
  if (!buf) return NextResponse.json({ error: "asset bytes missing on disk" }, { status: 404 });
  // Use a Uint8Array body so Next can serve it through the Response stream.
  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": meta.mediaType,
      "Content-Length": String(meta.sizeBytes),
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ hash: string }> }) {
  const { hash } = await ctx.params;
  const url = new URL(req.url);
  const cwd = url.searchParams.get("cwd") || process.cwd();
  const meta = await getAssetMeta(cwd, hash);
  if (!meta) return NextResponse.json({ error: "not found" }, { status: 404 });
  await deleteAsset(cwd, hash, meta.mediaType).catch(() => {});
  await deleteAssetRow(cwd, hash);
  return NextResponse.json({ ok: true });
}
