import { NextResponse } from "next/server";
import { readdir, readFile, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { projectRoot } from "@/lib/server/db";
import { PathInjectionError } from "@/lib/server/safe-path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SNIPPET_RADIUS = 60;
// Bound the fan-out so a workspace with thousands of transcripts can't wedge
// the event loop on a single keystroke. The newest files are scanned first.
const MAX_FILES = 600;
const CONCURRENCY = 8;
// CC 2.1.300 writes engine-internal request-capture entries into every
// transcript: `api-request-shape` (the full system prompt + tools JSON, which
// can be large), `api-request-blob` (hash-deduplicated copies of request
// messages, so skipping them loses nothing — the real user/assistant lines
// are still there) and `api-request` (params incl. max_tokens). Any word from
// the system prompt or tool descriptions would otherwise match every session.
// In raw JSONL an UNESCAPED `"type":"api-request` is a real JSON key, not
// string content (a quote inside a string value is written `\"`); the engine
// writes it as the first key of all three entry types. This is a constant —
// never derived from user input.
const API_REQUEST_LINE_MARKER = '"type":"api-request';

export type SessionContentMatch = {
  sessionId: string;
  snippet: string;
};

/**
 * Full-text search ACROSS a workspace's session transcripts.
 *
 * The metadata search on the Sessions page (id / title / firstPrompt / cwd /
 * branch) lives entirely client-side. This endpoint is the "search inside the
 * messages" complement: it scans the raw `.jsonl` transcript files on disk for
 * the query and returns the sessions that contain it, with a snippet.
 *
 * Why scan the raw JSONL instead of the SDK's parsed `getSessionMessages`:
 * parsing every transcript in a busy workspace (hundreds of multi-MB files)
 * per keystroke is far too slow. A single `readFile` + a regex `.exec` scan
 * over the raw text is an order of magnitude cheaper and good enough — the
 * query text we're matching lives verbatim in the JSON string values. The
 * snippet is extracted from the raw text (whitespace-collapsed); it's a
 * preview, not a faithful render.
 *
 * Scope: a session's transcript lives at
 * `~/.claude/projects/<encoded-cwd>/<id>.jsonl`, so every session whose cwd is
 * exactly `dir` sits in one directory — the same exact-cwd set the Sessions
 * page shows. We scan that one directory.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = url.searchParams.get("q") ?? "";
  const dir = url.searchParams.get("dir") || "";
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? "100") || 100));

  if (!q.trim()) return NextResponse.json({ matches: [] });
  // `dir` (the workspace root) is required: it pins the search to one
  // project directory. Without it we'd have to fan out across every
  // workspace, which the Sessions page never needs.
  if (!dir) {
    return NextResponse.json({ error: "dir is required" }, { status: 400 });
  }

  // Build a case-insensitive LITERAL matcher. The query is always treated as
  // a literal substring: every regex metacharacter is escaped before it
  // reaches `new RegExp`. We deliberately do NOT compile a user-supplied
  // pattern — that is a regex-injection / ReDoS sink (CodeQL
  // js/regex-injection): a crafted pattern could trigger catastrophic
  // backtracking and wedge the Node event loop, reachable cross-origin since
  // route handlers don't gate request processing on CSRF. The escape below is
  // the canonical MDN metacharacter escape (CodeQL's MetacharEscapeSanitizer),
  // so the value reaching the constructor carries no attacker regex syntax.
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(escaped, "gi");

  // `projectRoot` runs `assertWithin` on the cwd→path flow and returns the
  // resolved `~/.claude/projects/<encoded-cwd>` directory. `encodeProjectDir`
  // strips every non-alphanumeric char, so the encoded segment can't carry
  // `..` or a separator.
  let base: string;
  try {
    base = projectRoot(dir);
  } catch (err) {
    if (err instanceof PathInjectionError) {
      return NextResponse.json({ error: "invalid dir" }, { status: 400 });
    }
    throw err;
  }

  let names: string[];
  try {
    names = (await readdir(base)).filter((n) => n.endsWith(".jsonl"));
  } catch {
    // No transcripts on disk for this workspace yet.
    return NextResponse.json({ matches: [] });
  }
  // Sort newest-first by mtime so the MAX_FILES / result caps keep the most
  // recent transcripts — matching the recency ordering of the rest of the
  // page. `stat` is metadata-only (cheap); files that vanish between readdir
  // and stat sort to the bottom and are dropped by the cap.
  const withMtime = await Promise.all(
    names.map(async (name) => {
      try {
        const target = resolve(base, name);
        if (!target.startsWith(base + sep)) return { name, mtime: 0 };
        const st = await stat(target);
        return { name, mtime: st.mtimeMs };
      } catch {
        return { name, mtime: 0 };
      }
    }),
  );
  withMtime.sort((a, b) => b.mtime - a.mtime);
  const files = withMtime.slice(0, MAX_FILES).map((f) => f.name);

  const matches: SessionContentMatch[] = [];
  let cursor = 0;
  async function worker() {
    while (cursor < files.length && matches.length < limit) {
      const name = files[cursor++];
      const sessionId = name.slice(0, -".jsonl".length);
      // Session ids are SDK-minted UUIDs. Reject anything that isn't a plain
      // id token before it reaches the fs sink.
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(sessionId)) continue;
      // Inline path-injection barrier at the sink (CodeQL js/path-injection):
      // resolve under the (already-validated) base and confirm containment.
      const target = resolve(base, name);
      if (!target.startsWith(base + sep)) continue;
      let text: string;
      try {
        text = await readFile(target, "utf8");
      } catch {
        continue;
      }
      // Walk the matches and take the first one that isn't inside an
      // engine-internal `api-request*` line; when a match lands in one, jump
      // past the whole line so a 2 MB system-prompt dump costs one skip.
      re.lastIndex = 0;
      let hit: RegExpExecArray | null = null;
      let lineStart = 0;
      let lineEnd = text.length;
      for (let m = re.exec(text); m; m = re.exec(text)) {
        // Zero-length guard: always advance past this match position so the
        // scan can't spin (the escaped non-empty query can't match empty
        // today, but the loop must not depend on that).
        if (m[0].length === 0) re.lastIndex = m.index + 1;
        lineStart = text.lastIndexOf("\n", m.index) + 1;
        const nl = text.indexOf("\n", m.index);
        lineEnd = nl === -1 ? text.length : nl;
        if (text.slice(lineStart, lineEnd).includes(API_REQUEST_LINE_MARKER)) {
          re.lastIndex = lineEnd + 1;
          continue;
        }
        hit = m;
        break;
      }
      if (!hit) continue;
      // Clamp the snippet window to the matched line so it never bleeds into
      // a neighbouring JSONL entry (e.g. an adjacent api-request dump).
      const start = Math.max(lineStart, hit.index - SNIPPET_RADIUS);
      const end = Math.max(start, Math.min(lineEnd, hit.index + hit[0].length + SNIPPET_RADIUS));
      // The slice is raw JSONL, so it carries JSON string escapes. Decode the
      // common ones so the preview reads like prose instead of `\n`/`\"` noise.
      const cleaned = text
        .slice(start, end)
        .replace(/\\[nrt]/g, " ")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\")
        .replace(/\s+/g, " ")
        .trim();
      const snippet = (start > lineStart ? "…" : "") + cleaned + (end < lineEnd ? "…" : "");
      matches.push({ sessionId, snippet });
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker));

  return NextResponse.json({ matches: matches.slice(0, limit) });
}
