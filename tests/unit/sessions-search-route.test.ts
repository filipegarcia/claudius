import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeProjectDir } from "@/lib/server/auto-memory";
import { GET } from "@/app/api/sessions/search/route";
import type { SessionContentMatch } from "@/app/api/sessions/search/route";

/**
 * CC 2.1.300 writes `api-request-shape` (full system prompt + tools JSON),
 * `api-request-blob` and `api-request` (params incl. max_tokens) entries into
 * every transcript. The cross-session content search scans raw JSONL, so a
 * word from the system prompt matched every session (with a snippet lifted
 * from the JSON dump) and masked a real later hit. Those lines are skipped.
 */

const CWD = "/tmp/claudius-sessions-search-project";
const prevHome = process.env.HOME;
let home: string;

function writeTranscript(id: string, entries: object[]): void {
  const dir = join(home, ".claude", "projects", encodeProjectDir(CWD));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

async function search(q: string): Promise<SessionContentMatch[]> {
  const url = `http://localhost/api/sessions/search?q=${encodeURIComponent(q)}&dir=${encodeURIComponent(CWD)}`;
  const res = await GET(new Request(url));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { matches: SessionContentMatch[] };
  return body.matches;
}

// Shapes as the 2.1.300 engine writes them (checked against a real transcript):
// `type` first, the prompt/tools nested under `shape`, blobs carrying a
// hash-deduplicated copy of a request message.
const shape = (system: string) => ({
  type: "api-request-shape",
  sessionId: "s",
  shapeHash: "h1",
  timestamp: "2026-10-14T00:00:00.000Z",
  version: "2.1.300",
  shape: {
    system: [{ type: "text", text: system }],
    tools: [
      {
        name: "Bash",
        description: "Executes a bash command in a persistent shell.",
        input_schema: { type: "object" },
      },
    ],
  },
});
const blob = (text: string) => ({
  type: "api-request-blob",
  sessionId: "s",
  hash: "b1",
  message: { role: "user", content: [{ type: "text", text }] },
});
const request = {
  type: "api-request",
  sessionId: "s",
  id: "r1",
  version: "2.1.300",
  shapeHash: "h1",
  params: { model: "claude-opus-4-7", max_tokens: 32000, output_config: { effort: "high" } },
};
const user = (text: string) => ({ type: "user", message: { role: "user", content: text } });
const assistant = (text: string) => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text }] },
});

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "claudius-sessions-search-"));
  process.env.HOME = home;
  writeTranscript("s-plain", [
    shape("You are Claude Code. Be zephyrine about conventions."),
    blob("an earlier request mentioned nothing interesting"),
    request,
    user("please refactor the quokkaville module"),
    assistant("Sure, refactoring now."),
  ]);
  writeTranscript("s-later-hit", [
    shape("Always prefer marmalade-free solutions when possible."),
    request,
    user("hello"),
    assistant("The marmaladeword appears here in a real reply."),
  ]);
  // A blob repeating the user's words sits before the real user line.
  writeTranscript("s-blob-first", [
    blob("tell me about the wombatgrove setup"),
    request,
    user("tell me about the wombatgrove setup"),
  ]);
});

afterAll(() => {
  process.env.HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

describe("GET /api/sessions/search ignores api-request* transcript entries", () => {
  test("a word only in the api-request-shape system prompt matches nothing", async () => {
    expect(await search("zephyrine")).toEqual([]);
  });

  test("a word only in api-request-shape tool descriptions matches nothing", async () => {
    expect(await search("persistent shell")).toEqual([]);
  });

  test("max_tokens (only in api-request params) matches nothing", async () => {
    expect(await search("max_tokens")).toEqual([]);
  });

  test("a word in a user message matches, snippet free of api-request JSON", async () => {
    const matches = await search("quokkaville");
    expect(matches.map((m) => m.sessionId)).toEqual(["s-plain"]);
    expect(matches[0].snippet).toContain("quokkaville");
    expect(matches[0].snippet).not.toContain("api-request");
    // Clamped to the matched line: no bleed into the next JSONL entry.
    expect(matches[0].snippet).not.toContain('"type":"assistant"');
  });

  test("a later real hit is not masked by the same word in the shape line", async () => {
    const matches = await search("marmalade");
    expect(matches.map((m) => m.sessionId)).toEqual(["s-later-hit"]);
    expect(matches[0].snippet).toContain("marmaladeword appears here");
    expect(matches[0].snippet).not.toContain("api-request");
    expect(matches[0].snippet).not.toContain("solutions");
  });

  test("a word repeated in an earlier api-request-blob is found on the real user line", async () => {
    const matches = await search("wombatgrove");
    expect(matches.map((m) => m.sessionId)).toEqual(["s-blob-first"]);
    expect(matches[0].snippet).toContain("wombatgrove");
    expect(matches[0].snippet).not.toContain("api-request");
  });
});
