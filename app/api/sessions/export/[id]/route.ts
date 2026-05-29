import { exportPlainText } from "@/lib/server/sessions-store";

export const runtime = "nodejs";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const dir = url.searchParams.get("dir") || undefined;
  try {
    const text = await exportPlainText(id, dir);
    return new Response(text, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": `attachment; filename="claudius-session-${id}.txt"`,
      },
    });
  } catch (err) {
    // Log the real error server-side; return a generic message so we don't
    // leak filesystem paths from Node's fs errors (or stack traces) to the
    // browser. The user-facing UI shows "couldn't export" — there's nothing
    // actionable in the underlying message anyway.
    console.error("[export-session] failed", { id, err });
    return new Response("failed to export session", { status: 500 });
  }
}
