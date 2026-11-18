import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import { encodeProjectDir } from "@/lib/server/auto-memory";
import {
  RESUME_GAP_NOTICE,
  readTranscriptLinks,
  transcriptHasMissingParent,
} from "@/lib/server/session-resume";
import { withPagedResumeGap } from "@/lib/client/use-session";
import { selectReplayWindow } from "@/lib/server/session";
import type { ServerEvent } from "@/lib/shared/events";

/**
 * CC 2.1.327 — "Added a line when a resumed session's earlier messages can't
 * be loaded". The CLI flags the loaded chain when its first row names a
 * parent that isn't in the file (not an `isCompactSummary` prompt, not the
 * file's opening turn). Each fixture is a real-shaped JSONL; the first loaded
 * uuid comes from the SDK's own `getSessionMessages`, the same input the
 * resume replay feeds the rule.
 */

const CWD = "/tmp/claudius-resume-gap-project";
const prevHome = process.env.HOME;
const prevConfig = process.env.CLAUDE_CONFIG_DIR;
let home: string;
let base: string;
let n = 0;

const SESSION_PREFIX = "4b1c0f3e-2a6d-4e8f-9b7a-";

function newId(): string {
  n++;
  return `${SESSION_PREFIX}${String(n).padStart(12, "0")}`;
}

function row(type: "user" | "assistant", uuid: string, parentUuid: string | null, extra: object = {}) {
  const t = new Date(Date.UTC(2026, 10, 1, 12, 0, n)).toISOString();
  return {
    type,
    uuid,
    parentUuid,
    isSidechain: false,
    sessionId: "",
    cwd: CWD,
    timestamp: t,
    message:
      type === "user"
        ? { role: "user", content: `prompt ${uuid}` }
        : {
            role: "assistant",
            id: `msg_${uuid}`,
            model: "claude-opus-5-5",
            type: "message",
            content: [{ type: "text", text: `reply ${uuid}` }],
            stop_reason: "end_turn",
          },
    ...extra,
  };
}

/** Write a transcript and return its path plus the SDK's first loaded uuid. */
async function fixture(entries: object[]): Promise<{ file: string; first: string | undefined }> {
  const id = newId();
  const dir = join(base, encodeProjectDir(CWD));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.jsonl`);
  writeFileSync(
    file,
    entries.map((e) => JSON.stringify({ ...e, sessionId: id })).join("\n") + "\n",
  );
  const loaded = await getSessionMessages(id, { dir: CWD, includeSystemMessages: true });
  return { file, first: loaded.find((m) => typeof m.uuid === "string")?.uuid };
}

async function gap(entries: object[]): Promise<boolean> {
  const { file, first } = await fixture(entries);
  expect(first).toBeTruthy();
  return transcriptHasMissingParent(file, first!, base);
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "claudius-resume-gap-"));
  process.env.HOME = home;
  process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
  base = join(home, ".claude", "projects");
});

afterAll(() => {
  process.env.HOME = prevHome;
  if (prevConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prevConfig;
  rmSync(home, { recursive: true, force: true });
});

describe("resume gap detection", () => {
  test("a healthy chain has no gap", async () => {
    expect(
      await gap([
        { type: "file-history-snapshot", messageId: "u1", snapshot: {} },
        row("user", "u1", null),
        row("assistant", "a1", "u1"),
        row("user", "u2", "a1"),
        row("assistant", "a2", "u2"),
      ]),
    ).toBe(false);
  });

  test("a missing middle is a gap", async () => {
    const { file, first } = await fixture([
      row("user", "u1", null),
      row("assistant", "a1", "u1"),
      // u2 (a1 → u2 → a2) lost
      row("assistant", "a2", "u2"),
      row("user", "u3", "a2"),
      row("assistant", "a3", "u3"),
    ]);
    // The SDK silently replays from the orphan on.
    expect(first).toBe("a2");
    expect(await transcriptHasMissingParent(file, first!, base)).toBe(true);
  });

  test("a compacted session is not a gap", async () => {
    expect(
      await gap([
        row("user", "u1", null),
        row("assistant", "a1", "u1"),
        {
          type: "system",
          subtype: "compact_boundary",
          uuid: "b1",
          parentUuid: null,
          logicalParentUuid: "a1",
          content: "Conversation compacted",
          isSidechain: false,
          timestamp: "2026-11-01T13:00:00.000Z",
          compactMetadata: { trigger: "manual", preTokens: 1000 },
        },
        row("user", "s1", "b1", {
          isCompactSummary: true,
          isVisibleInTranscriptOnly: true,
          message: { role: "user", content: "This session is being continued from a previous conversation." },
        }),
        row("user", "u2", "s1"),
        row("assistant", "a2", "u2"),
      ]),
    ).toBe(false);
  });

  test("a compaction that preserved a recent segment is not a gap", async () => {
    // The SDK relinks the kept segment under the summary; its raw parents
    // still point into the pre-compact chain.
    const { file, first } = await fixture([
      row("user", "u1", null),
      row("assistant", "a1", "u1"),
      row("user", "h1", "a1"),
      row("assistant", "t1", "h1"),
      {
        type: "system",
        subtype: "compact_boundary",
        uuid: "b1",
        parentUuid: null,
        logicalParentUuid: "t1",
        content: "Conversation compacted",
        isSidechain: false,
        timestamp: "2026-11-01T13:00:00.000Z",
        compactMetadata: {
          trigger: "auto",
          preTokens: 1000,
          preservedSegment: { headUuid: "h1", anchorUuid: "s1", tailUuid: "t1" },
        },
      },
      row("user", "s1", "b1", {
        isCompactSummary: true,
        message: { role: "user", content: "This session is being continued from a previous conversation." },
      }),
      row("user", "u3", "s1"),
      row("assistant", "a3", "u3"),
    ]);
    expect(first).toBeTruthy();
    expect(await transcriptHasMissingParent(file, first!, base)).toBe(false);
  });

  test("a compact summary whose parent is missing is not a gap", async () => {
    // The CLI exempts isCompactSummary rows from the cut-off rule.
    expect(
      await gap([
        row("user", "u1", null),
        row("assistant", "a1", "u1"),
        row("user", "s1", "gone", {
          isCompactSummary: true,
          message: { role: "user", content: "This session is being continued from a previous conversation." },
        }),
        row("user", "u2", "s1"),
        row("assistant", "a2", "u2"),
      ]),
    ).toBe(false);
  });

  test("sidechain rows with missing parents don't count", async () => {
    expect(
      await gap([
        row("user", "u1", null),
        row("assistant", "a1", "u1"),
        row("user", "x1", "elsewhere", { isSidechain: true }),
        row("assistant", "x2", "x1", { isSidechain: true }),
        row("user", "u2", "a1"),
        row("assistant", "a2", "u2"),
      ]),
    ).toBe(false);
  });

  test("the file's opening turn may name a parent from another file (fork / copied tail)", async () => {
    expect(
      await gap([
        row("user", "u1", "from-the-original-session"),
        row("assistant", "a1", "u1"),
        row("user", "u2", "a1"),
        row("assistant", "a2", "u2"),
      ]),
    ).toBe(false);
  });

  test("a parent that's in the file as another row type is not missing", async () => {
    expect(
      await gap([
        row("user", "u1", null),
        row("assistant", "a1", "u1"),
        { type: "custom-marker", uuid: "m1", parentUuid: "a1" },
        row("assistant", "a2", "m1"),
        row("user", "u3", "a2"),
        row("assistant", "a3", "u3"),
      ]),
    ).toBe(false);
  });

  test("the walk crosses progress / system rows to the chain's root", async () => {
    // The CLI's loader bridges progress rows (a child takes the progress
    // row's parent), so u2 is its first row and names the missing "lost".
    expect(
      await gap([
        row("user", "u1", null),
        row("assistant", "a1", "u1"),
        { type: "progress", uuid: "p1", parentUuid: "lost", isSidechain: false, timestamp: "2026-11-01T12:30:00.000Z", data: {} },
        row("user", "u2", "p1"),
        row("assistant", "a2", "u2"),
      ]),
    ).toBe(true);
  });

  test("a first loaded uuid that isn't in the scanned file can't be judged", async () => {
    const { file } = await fixture([row("user", "u1", null), row("assistant", "a1", "u1")]);
    expect(await transcriptHasMissingParent(file, "not-in-this-file", base)).toBe(false);
  });

  test("a torn or unreadable file never reports a gap", async () => {
    const dir = join(base, encodeProjectDir(CWD));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "torn.jsonl");
    writeFileSync(file, `${JSON.stringify(row("assistant", "a2", "u2"))}\n{"type":"user","uuid":"u3","par`);
    expect(await transcriptHasMissingParent(file, "a2", base)).toBe(false);
    expect(await transcriptHasMissingParent(join(dir, "nope.jsonl"), "a2", base)).toBe(false);
  });

  test("a path outside the projects dir is refused", async () => {
    const outside = join(home, "elsewhere.jsonl");
    writeFileSync(outside, JSON.stringify(row("user", "u1", null)) + "\n");
    expect(await readTranscriptLinks(outside, base)).toBeNull();
    expect(await readTranscriptLinks(join(base, "..", "..", "elsewhere.jsonl"), base)).toBeNull();
  });
});

describe("withPagedResumeGap", () => {
  const gapNotice = { uuid: "resume-gap-s1", content: RESUME_GAP_NOTICE };

  test("adds an anchorless warning when the top page carries the notice", () => {
    expect(withPagedResumeGap([], gapNotice)).toEqual([
      { uuid: "resume-gap-s1", afterMessageUuid: "", kind: "info", label: RESUME_GAP_NOTICE, infoLevel: "warning" },
    ]);
  });

  test("no-op when absent or already shown from the replay", () => {
    const prev = withPagedResumeGap([], gapNotice);
    expect(withPagedResumeGap(prev, gapNotice)).toBe(prev);
    expect(withPagedResumeGap(prev, undefined)).toBe(prev);
    expect(withPagedResumeGap([], { uuid: "x", content: "" })).toEqual([]);
  });
});

describe("the notice's place in the replay", () => {
  // `start()` stamps the notice with the earliest replayed time and
  // broadcasts it before the history, so the chronological replay keeps it
  // on top; a short tail window leaves it out (the paged route covers that).
  const T = Date.UTC(2026, 10, 1, 12);
  const notice: ServerEvent = {
    type: "sdk",
    at: T,
    message: {
      type: "system",
      subtype: "informational",
      level: "warning",
      content: RESUME_GAP_NOTICE,
      uuid: "resume-gap-s1",
    } as never,
  };
  const user = (uuid: string, at: number): ServerEvent => ({
    type: "sdk",
    at,
    message: { type: "user", uuid, message: { content: [{ type: "text", text: uuid }] } } as never,
  });
  const reply = (uuid: string, at: number): ServerEvent => ({
    type: "sdk",
    at,
    message: { type: "assistant", uuid, message: { content: [{ type: "text", text: uuid }] } } as never,
  });
  const buffer = [notice, user("u1", T), reply("a1", T + 1), user("u2", T + 2), reply("a2", T + 3)];

  test("stays first when the whole history replays", () => {
    const { events, hasMoreAbove } = selectReplayWindow(buffer, 20);
    expect(hasMoreAbove).toBe(false);
    expect(events[0]).toBe(notice);
  });

  test("is left above a tail window", () => {
    const { events, hasMoreAbove } = selectReplayWindow(buffer, 2);
    expect(hasMoreAbove).toBe(true);
    expect(events).not.toContain(notice);
  });
});
