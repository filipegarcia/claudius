import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

import { fsListErrorText } from "@/components/chat/AtMentionPicker";
import {
  BINARY_SAVE_TITLE,
  ENCODING_READONLY_SAVE_TITLE,
  saveButtonTitle,
} from "@/components/files/BinaryFilePlaceholder";

/**
 * CC 2.1.301 follow-ups for the binary-file placeholder and the @-picker's
 * "Search failed" row.
 */
describe("saveButtonTitle", () => {
  test("a binary file gets a binary tooltip, not the encoding one", () => {
    // Binary files are also read-only; the encoding wording would mislead.
    expect(saveButtonTitle({ binary: true, readOnly: true })).toBe(BINARY_SAVE_TITLE);
    expect(BINARY_SAVE_TITLE).not.toMatch(/encoding/i);
  });
  test("non-binary read-only keeps the encoding tooltip; editable has none", () => {
    expect(saveButtonTitle({ binary: false, readOnly: true })).toBe(ENCODING_READONLY_SAVE_TITLE);
    expect(saveButtonTitle({ binary: false, readOnly: false })).toBeUndefined();
  });
});

describe("fsListErrorText (@-picker)", () => {
  test("a 400 such as 'unknown cwd' stays quiet", () => {
    expect(fsListErrorText(400, { error: "unknown cwd" })).toBeNull();
    expect(fsListErrorText(404, {})).toBeNull();
  });
  test("403 / 5xx 'Search failed' responses are shown", () => {
    expect(fsListErrorText(403, { error: "Search failed: permission denied" })).toBe("Search failed: permission denied");
    expect(fsListErrorText(500, { error: "Search failed: boom" })).toBe("Search failed: boom");
    expect(fsListErrorText(502, {})).toBe("Search failed (HTTP 502)");
  });
});

describe("FileEditor file-switch reset", () => {
  // Structural check: the unit suite has no DOM renderer, and the reset is a
  // render-phase "store previous props" block that only runs on re-render.
  test("clears the binary placeholder state when the file changes", () => {
    const src = readFileSync(resolve(__dirname, "../../components/git/FileEditor.tsx"), "utf8");
    const start = src.indexOf("if (lastFileKey !== fileKey) {");
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf("\n  }\n", start));
    expect(block).toContain("setReadOnlyReason(null);");
    expect(block).toContain("setBinarySize(null);");
  });
});
