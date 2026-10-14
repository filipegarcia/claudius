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

const shape = (system: string) => ({
  type: "api-request-shape",
  system: [{ type: "text", text: system }],
  tools: [{ name: "Bash", description: "Executes a bash command in a persistent shell." }],
});
const blob = { type: "api-request-blob", blob: "c29tZSBvcGFxdWUgYmxvYg==" };
const request = { type: "api-request", params: { model: "claude-opus-4-7", max_tokens: 32000 } };
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
    blob,
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
});
