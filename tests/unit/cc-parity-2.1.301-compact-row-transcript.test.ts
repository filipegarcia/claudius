import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SystemPill } from "@/components/chat/SystemPill";
import type { SystemEntry } from "@/lib/client/types";

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
