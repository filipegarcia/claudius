import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SystemPill } from "@/components/chat/SystemPill";
import type { SystemEntry } from "@/lib/client/types";
import { nextTranscriptPath, withPagedCompactBoundary } from "@/lib/client/use-session";

/**
 * CC 2.1.301 — "Fixed the compaction row in a resumed session offering ctrl+o
 * for history that is not loaded; it now says where the earlier messages are
 * saved". A resumed session replays from the boundary on, so a top-of-thread
 * compaction row names the transcript file holding the earlier turns.
 */
const PATH = "~/.claude/projects/-Users-me-proj/0b0e2c1d-aaaa-bbbb-cccc-000000000001.jsonl";

function render(entry: Partial<SystemEntry>, transcriptPath: string | null) {
  const full: SystemEntry = {
    uuid: "c1",
    afterMessageUuid: "",
    kind: "compact_boundary",
    label: "Compacted earlier conversation",
    ...entry,
  };
  return renderToStaticMarkup(
    createElement(SystemPill, { entry: full, levers: { resumedTranscriptPath: transcriptPath } }),
  );
}

describe("compaction row in a resumed session", () => {
  test("top-of-thread boundary in a resumed session names the transcript file", () => {
    const html = render({}, PATH);
    expect(html).toContain('data-testid="compact-earlier-saved"');
    expect(html).toContain(PATH);
    expect(html).toContain("aren&#x27;t loaded");
  });

  test("a boundary with earlier messages above it (live compaction) stays as before", () => {
    expect(render({ afterMessageUuid: "a-123" }, PATH)).not.toContain("compact-earlier-saved");
  });

  test("a fresh (non-resumed) session never shows the line", () => {
    expect(render({}, null)).not.toContain("compact-earlier-saved");
  });

  test("the summary toggle still only appears when a summary was loaded", () => {
    expect(render({}, PATH)).not.toContain("show summary");
    expect(render({ compactSummary: "Summary text" }, PATH)).toContain("show summary");
  });
});

describe("the transcript path survives the stream's trailing bare ready", () => {
  test("a ready without the field keeps the path the replayed ready set", () => {
    // The stream route sends `{ type: "ready", sessionId }` after the replay.
    expect(nextTranscriptPath(PATH, {})).toBe(PATH);
  });

  test("a ready carrying the field sets it", () => {
    expect(nextTranscriptPath(null, { transcriptPath: PATH })).toBe(PATH);
    expect(nextTranscriptPath("~/old.jsonl", { transcriptPath: PATH })).toBe(PATH);
  });

  test("an explicit undefined clears it", () => {
    expect(nextTranscriptPath(PATH, { transcriptPath: undefined })).toBeNull();
  });
});

describe("compaction row restored from the page that reaches the top of a resumed history", () => {
  const SUMMARY_TEXT = "This session is being continued from a previous conversation that ran out of context.";
  // `getSessionMessages` starts the resumed chain at the boundary: a bare
  // system record (no subtype on disk), then the continuation summary.
  const page = [
    { type: "system", uuid: "cb-disk" },
    { type: "user", uuid: "summary-1", isCompactSummary: true, message: { role: "user", content: SUMMARY_TEXT } },
    { type: "user", uuid: "u-1", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
  ];

  test("adds a top-of-thread divider (with the summary) when the page holds the summary", () => {
    const out = withPagedCompactBoundary([], page, false);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      uuid: "summary-1",
      afterMessageUuid: "",
      kind: "compact_boundary",
      compactSummary: SUMMARY_TEXT,
    });
    // ...which is exactly the row that names the transcript file.
    const html = renderToStaticMarkup(
      createElement(SystemPill, { entry: out[0], levers: { resumedTranscriptPath: PATH } }),
    );
    expect(html).toContain('data-testid="compact-earlier-saved"');
  });

  test("recognises the summary by content when the envelope flag is missing", () => {
    const unflagged = [{ type: "user", uuid: "s2", message: { role: "user", content: SUMMARY_TEXT } }];
    expect(withPagedCompactBoundary([], unflagged, false)).toHaveLength(1);
  });

  test("nothing while there's still history above the page", () => {
    const prev: SystemEntry[] = [];
    expect(withPagedCompactBoundary(prev, page, true)).toBe(prev);
  });

  test("nothing when the page holds no summary", () => {
    const prev: SystemEntry[] = [];
    expect(withPagedCompactBoundary(prev, page.slice(2), false)).toBe(prev);
  });

  test("no second row when the replay window already included the boundary", () => {
    const anchorless: SystemEntry[] = [
      { uuid: "summary-1", afterMessageUuid: "", kind: "compact_boundary", label: "Compacted earlier conversation" },
    ];
    expect(withPagedCompactBoundary(anchorless, page, false)).toBe(anchorless);
    // A live compaction's divider is anchored under the last pre-compaction
    // assistant and keyed by the system event's uuid — still the same row.
    const live: SystemEntry[] = [
      { uuid: "cb-disk", afterMessageUuid: "a-9", kind: "compact_boundary", label: "Compacted earlier conversation" },
    ];
    expect(withPagedCompactBoundary(live, page, false)).toBe(live);
    const fromSummary: SystemEntry[] = [
      { uuid: "summary-1", afterMessageUuid: "a-9", kind: "compact_boundary", label: "Compacted earlier conversation" },
    ];
    expect(withPagedCompactBoundary(fromSummary, page, false)).toBe(fromSummary);
  });

  test("other anchorless pills don't count as the divider", () => {
    const prev: SystemEntry[] = [{ uuid: "i1", afterMessageUuid: "", kind: "info", label: "Ran /x" }];
    expect(withPagedCompactBoundary(prev, page, false)).toHaveLength(2);
  });
});
