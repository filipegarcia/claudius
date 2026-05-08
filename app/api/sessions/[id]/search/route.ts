import { NextResponse } from "next/server";
import { sessionManager } from "@/lib/server/session-manager";
import { messages as allMessages, stringifyContent } from "@/lib/server/sessions-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SNIPPET_RADIUS = 60;

export type SearchHit = {
  messageUuid: string;
  role: "user" | "assistant" | "system";
  snippet: string;
  score: number;
};

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const q = url.searchParams.get("q") ?? "";
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? "50") || 50));
  let dir = url.searchParams.get("dir") || undefined;
  if (!dir) {
    const session = sessionManager.get(id);
    if (session) dir = session.cwd;
  }
  if (!q.trim()) return NextResponse.json({ hits: [] });

  // /regex/ syntax — fall back to substring on parse failure with a 400.
  let matcher: ((haystack: string) => Array<{ index: number; length: number }>) | null = null;
  if (q.length >= 2 && q.startsWith("/") && q.endsWith("/")) {
    const pattern = q.slice(1, -1);
    let re: RegExp;
    try {
      re = new RegExp(pattern, "gi");
    } catch (err) {
      return NextResponse.json(
        { error: `invalid regex: ${err instanceof Error ? err.message : String(err)}` },
        { status: 400 },
      );
    }
    matcher = (haystack) => {
      const out: Array<{ index: number; length: number }> = [];
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(haystack)) && out.length < 5) {
        out.push({ index: m.index, length: m[0].length });
        if (m[0].length === 0) re.lastIndex += 1; // avoid infinite loop on empty match
      }
      return out;
    };
  } else {
    const needle = q.toLowerCase();
    matcher = (haystack) => {
      const lower = haystack.toLowerCase();
      const out: Array<{ index: number; length: number }> = [];
      let from = 0;
      while (out.length < 5) {
        const idx = lower.indexOf(needle, from);
        if (idx === -1) break;
        out.push({ index: idx, length: needle.length });
        from = idx + needle.length;
      }
      return out;
    };
  }

  let all;
  try {
    all = await allMessages(id, dir, /* includeSystem */ false);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }

  const hits: SearchHit[] = [];
  let order = 0;
  for (const m of all) {
    if (m.type !== "user" && m.type !== "assistant") continue;
    const content = (m.message as { content?: unknown }).content;
    const haystack = stringifyContent(content);
    if (!haystack) continue;
    const matches = matcher(haystack);
    if (matches.length === 0) continue;
    const first = matches[0];
    const start = Math.max(0, first.index - SNIPPET_RADIUS);
    const end = Math.min(haystack.length, first.index + first.length + SNIPPET_RADIUS);
    const prefix = start > 0 ? "…" : "";
    const suffix = end < haystack.length ? "…" : "";
    const snippet = prefix + haystack.slice(start, end).replace(/\s+/g, " ").trim() + suffix;
    hits.push({
      messageUuid: m.uuid,
      role: m.type as "user" | "assistant",
      snippet,
      score: order++,
    });
    if (hits.length >= limit) break;
  }
  return NextResponse.json({ hits });
}
