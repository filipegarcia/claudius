import { mkdirSync, realpathSync } from "node:fs";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { getSessionMessages, type SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";

import { encodeProjectDir } from "@/lib/server/auto-memory";
import { fullHistoryMessages, stitchCompactedHistory } from "@/lib/server/compacted-history";
import { exportPlainText } from "@/lib/server/sessions-store";
import { TranscriptViewer } from "@/components/sessions/TranscriptViewer";
import { SystemPill } from "@/components/chat/SystemPill";
import type { HistoryMessage } from "@/lib/shared/history-message";

import { makeTempHome, type TmpHome } from "./helpers/tmp-home";

/**
 * The session viewer shows the turns before each compaction, not just the
 * summary. Compaction keeps appending to the same JSONL: a `compact_boundary`
 * with `parentUuid: null`, then the "This session is being continued…"
 * summary. The SDK's `getSessionMessages` stops its parentUuid walk at that
 * null, so the viewer used to start at the last summary.
 *
 * The fixture copies the shape of a real transcript (CLI 2.1.3xx): the
 * boundary's `logicalParentUuid` points at a message that was never written,
 * the compaction kept its last messages (`preservedSegment` /
 * `preservedMessages`), and a subagent's sidechain line is written between
 * the kept tail and the boundary.
 */

const S = "5e551011-0000-4000-8000-00000000c0de";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const U1 = id(1), A1 = id(2), U2 = id(3), A2 = id(4), STOP = id(5), SIDE = id(6);
const B1 = id(7), ATT = id(8), CS1 = id(9), U3 = id(10), A3 = id(11);
const B2 = id(12), CS2 = id(13), U4 = id(14), A4 = id(15);
const NEVER_WRITTEN = id(99);

const SUMMARY_1 =
  "This session is being continued from a previous conversation that ran out of context. " +
  "Summary: the user asked two questions.";
const SUMMARY_2 =
  "This session is being continued from a previous conversation that ran out of context. " +
  "Summary: the user asked three questions.";

function fixture(cwd: string): SessionStoreEntry[] {
  let t = 0;
  const base = () => ({
    isSidechain: false,
    cwd,
    sessionId: S,
    timestamp: new Date(Date.UTC(2026, 10, 14, 10, 0, t++)).toISOString(),
  });
  const user = (uuid: string, parentUuid: string | null, content: string, extra = {}) => ({
    ...base(),
    type: "user",
    uuid,
    parentUuid,
    message: { role: "user", content },
    ...extra,
  });
  const assistant = (uuid: string, parentUuid: string, text: string) => ({
    ...base(),
    type: "assistant",
    uuid,
    parentUuid,
    message: { id: `msg_${uuid}`, role: "assistant", content: [{ type: "text", text }] },
  });
  return [
    user(U1, null, "first question"),
    assistant(A1, U1, "first answer"),
    user(U2, A1, "second question"),
    assistant(A2, U2, "second answer"),
    { ...base(), type: "system", subtype: "stop_hook_summary", uuid: STOP, parentUuid: A2, content: "" },
    { ...base(), type: "assistant", uuid: SIDE, parentUuid: null, isSidechain: true, agentId: "a1",
      message: { id: "msg_side", role: "assistant", content: [{ type: "text", text: "subagent" }] } },
    { type: "custom-title", customTitle: "Fixture", sessionId: S },
    { type: "mode", mode: "normal", sessionId: S },
    {
      ...base(),
      type: "system",
      subtype: "compact_boundary",
      uuid: B1,
      parentUuid: null,
      logicalParentUuid: NEVER_WRITTEN,
      content: "Conversation compacted",
      compactMetadata: {
        trigger: "auto",
        preTokens: 369213,
        postTokens: 15975,
        durationMs: 75831,
        preservedSegment: { headUuid: U2, anchorUuid: CS1, tailUuid: STOP },
        preservedMessages: { anchorUuid: CS1, uuids: [U2, A2, STOP], allUuids: [U2, A2, STOP, NEVER_WRITTEN] },
      },
    },
    { ...base(), type: "attachment", uuid: ATT, parentUuid: B1, attachment: { type: "todo_reminder" } },
    user(CS1, ATT, SUMMARY_1, { isCompactSummary: true, isVisibleInTranscriptOnly: true }),
    user(U3, CS1, "third question"),
    assistant(A3, U3, "third answer"),
    {
      ...base(),
      type: "system",
      subtype: "compact_boundary",
      uuid: B2,
      parentUuid: null,
      logicalParentUuid: A3,
      content: "Conversation compacted",
      compactMetadata: { trigger: "manual", preTokens: 111123, postTokens: 7072 },
    },
    user(CS2, B2, SUMMARY_2, { isCompactSummary: true, isVisibleInTranscriptOnly: true }),
    user(U4, CS2, "fourth question"),
    assistant(A4, U4, "fourth answer"),
  ];
}

function text(m: HistoryMessage): string {
  const c = (m.message as { content?: unknown })?.content;
  if (typeof c === "string") return c;
  return Array.isArray(c) ? c.map((b: { text?: string }) => b.text ?? "").join("") : "";
}

const byUuid = (entries: SessionStoreEntry[]) =>
  new Map(entries.map((e) => [e.uuid, e as SessionStoreEntry & Record<string, unknown>]));

describe("stitchCompactedHistory", () => {
  test("a dangling logicalParentUuid links to the last main-chain entry before the boundary", () => {
    const stitched = byUuid(stitchCompactedHistory(fixture("/x")));
    // Not the sidechain line written after it, not the never-written uuid.
    expect(stitched.get(B1)!.parentUuid).toBe(STOP);
  });

  test("a logicalParentUuid that exists earlier in the file is used", () => {
    expect(byUuid(stitchCompactedHistory(fixture("/x"))).get(B2)!.parentUuid).toBe(A3);
  });

  test("preservation metadata is dropped, the rest of compactMetadata kept", () => {
    const meta = byUuid(stitchCompactedHistory(fixture("/x"))).get(B1)!.compactMetadata;
    expect(meta).toEqual({ trigger: "auto", preTokens: 369213, postTokens: 15975, durationMs: 75831 });
  });

  test("the input entries are not mutated", () => {
    const input = fixture("/x");
    const before = JSON.stringify(input);
    stitchCompactedHistory(input);
    expect(JSON.stringify(input)).toBe(before);
  });

  test("a boundary with nothing before it stays a root", () => {
    const [b] = stitchCompactedHistory([
      { type: "system", subtype: "compact_boundary", uuid: B1, parentUuid: null, logicalParentUuid: NEVER_WRITTEN },
    ]);
    expect((b as { parentUuid?: unknown }).parentUuid).toBeNull();
  });
});

describe("fullHistoryMessages (through the SDK)", () => {
  let tmp: TmpHome;
  let root: string;
  let prevConfigDir: string | undefined;

  // One home for the whole block: the SDK resolves its projects dir once per
  // process, so a fresh tmp HOME per test would leave it reading the first
  // (deleted) one. The fixture is read-only, so sharing it is safe.
  beforeAll(async () => {
    tmp = makeTempHome();
    // The SDK resolves its projects dir from CLAUDE_CONFIG_DIR when set (it
    // is inside a Claudius-spawned shell); unset it so it follows tmp HOME.
    prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_CONFIG_DIR;
    // realpath: macOS tmpdirs sit behind /var → /private/var and the SDK
    // canonicalizes `dir` before encoding it.
    root = join(realpathSync(tmp.home), "proj");
    mkdirSync(root);
    const dir = join(tmp.home, ".claude", "projects", encodeProjectDir(root));
    mkdirSync(dir, { recursive: true });
    const lines = fixture(root).map((e) => JSON.stringify(e)).join("\n") + "\n";
    await fs.writeFile(join(dir, `${S}.jsonl`), lines);
  });

  afterAll(() => {
    if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
    tmp.restore();
  });

  test("the SDK alone starts at the last compaction (the bug)", async () => {
    const plain = (await getSessionMessages(S, { dir: root })).map(text);
    expect(plain).toContain("fourth question");
    expect(plain).not.toContain("first question");
  });

  test("returns every turn, before and after each compaction, in order", async () => {
    const all = await fullHistoryMessages(S, root);
    const convo = all.filter((m) => m.type !== "system" && !m.isCompactSummary).map(text);
    expect(convo).toEqual([
      "first question",
      "first answer",
      "second question",
      "second answer",
      "third question",
      "third answer",
      "fourth question",
      "fourth answer",
    ]);
    // Subagent lines stay out, as in the SDK's own listing.
    expect(all.map((m) => m.uuid)).not.toContain(SIDE);
  });

  test("each compaction is a boundary row with its stats, then the flagged summary", async () => {
    const all = await fullHistoryMessages(S, root);
    const at = (uuid: string) => all.findIndex((m) => m.uuid === uuid);
    expect(all[at(B1)]).toMatchObject({
      type: "system",
      subtype: "compact_boundary",
      compactBoundary: { trigger: "auto", preTokens: 369213, postTokens: 15975, durationMs: 75831 },
    });
    expect(all[at(B2)]).toMatchObject({ compactBoundary: { trigger: "manual" } });
    expect(all[at(CS1)]!.isCompactSummary).toBe(true);
    // The kept messages stay where they were written: before the boundary.
    expect(at(A2)).toBeLessThan(at(B1));
    expect(at(B1)).toBeLessThan(at(CS1));
    expect(at(CS1)).toBeLessThan(at(U3));
    expect(all[at(STOP)]!.subtype).toBe("stop_hook_summary");
  });

  test("without system messages the conversation is still complete", async () => {
    const all = await fullHistoryMessages(S, root, false);
    expect(all.some((m) => m.type === "system")).toBe(false);
    expect(all.map(text)).toContain("first question");
  });

  test("the export covers the earlier turns and labels the summaries", async () => {
    const out = await exportPlainText(S, root);
    expect(out).toContain("first question");
    expect(out.indexOf("first question")).toBeLessThan(out.indexOf("fourth answer"));
    expect(out).toContain("[Compacted earlier conversation. Summary:]");
  });

  test("an unknown session rejects, so the route can fall back", async () => {
    await expect(fullHistoryMessages(id(404).replace(/^0/, "a"), root)).rejects.toThrow();
  });
});

describe("TranscriptViewer", () => {
  const row = (m: Partial<HistoryMessage>): HistoryMessage =>
    ({ session_id: S, parent_tool_use_id: null, parent_agent_id: null, ...m }) as HistoryMessage;
  const messages: HistoryMessage[] = [
    row({ type: "user", uuid: U1, message: { role: "user", content: "first question" } }),
    row({ type: "assistant", uuid: A1, message: { role: "assistant", content: [{ type: "text", text: "first answer" }] } }),
    row({ type: "system", uuid: B1, message: undefined, subtype: "compact_boundary",
      compactBoundary: { trigger: "auto", preTokens: 369213, postTokens: 15975 } }),
    row({ type: "user", uuid: CS1, isCompactSummary: true, message: { role: "user", content: SUMMARY_1 } }),
    row({ type: "user", uuid: U3, message: { role: "user", content: "third question" } }),
  ];
  const html = renderToStaticMarkup(createElement(TranscriptViewer, { messages }));

  test("earlier turns render as messages", () => {
    expect(html).toContain("first question");
    expect(html).toContain("first answer");
    expect(html).toContain("third question");
  });

  test("the compaction is one divider with stats; the summary is collapsed, not a user bubble", () => {
    expect(html.match(/data-testid="transcript-compaction"/g)).toHaveLength(1);
    expect(html).toContain("369,213→15,975 tokens");
    expect(html).toContain("show summary");
    expect(html).not.toContain("being continued from a previous conversation");
    expect(html.match(/data-message-role="user"/g)).toHaveLength(2);
  });

  test("a summary without its boundary row still renders as a divider", () => {
    const out = renderToStaticMarkup(
      createElement(TranscriptViewer, { messages: messages.filter((m) => m.type !== "system") }),
    );
    expect(out.match(/data-testid="transcript-compaction"/g)).toHaveLength(1);
    expect(out).not.toContain("being continued from a previous conversation");
  });

  test("other system rows are labelled by subtype", () => {
    const out = renderToStaticMarkup(
      createElement(TranscriptViewer, {
        messages: [row({ type: "system", uuid: STOP, message: undefined, subtype: "stop_hook_summary" })],
      }),
    );
    expect(out).toContain("stop hook summary");
  });
});

describe("chat compaction row links to the full history", () => {
  const PATH = `~/.claude/projects/-Users-me-proj/${S}.jsonl`;
  const render = (sessionId: string | null) =>
    renderToStaticMarkup(
      createElement(SystemPill, {
        entry: { uuid: "c1", afterMessageUuid: "", kind: "compact_boundary", label: "Compacted earlier conversation" },
        levers: { resumedTranscriptPath: PATH, sessionId },
      }),
    );

  test("a resumed session's top-of-thread row links to the session viewer", () => {
    const html = render(S);
    expect(html).toContain('data-testid="compact-earlier-history-link"');
    expect(html).toContain(`href="/sessions/${S}"`);
    expect(html).toContain(PATH);
  });

  test("no session id, no link", () => {
    expect(render(null)).not.toContain("compact-earlier-history-link");
  });
});
