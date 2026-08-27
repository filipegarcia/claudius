import { describe, expect, it } from "vitest";
import { firstLine, peerMessagePreview } from "@/lib/shared/peer-message-preview";

describe("firstLine", () => {
  it("returns the first non-empty line, trimmed", () => {
    expect(firstLine("Deploy finished successfully.")).toBe("Deploy finished successfully.");
    expect(firstLine("  leading space\nsecond line")).toBe("leading space");
    expect(firstLine("\n\nfirst real line\nsecond")).toBe("first real line");
  });

  it("returns an empty string for blank input", () => {
    expect(firstLine("")).toBe("");
    expect(firstLine("   \n  \n")).toBe("");
  });
});

describe("peerMessagePreview", () => {
  it("formats a one-line preview with the sender name and first line", () => {
    expect(peerMessagePreview("Release Bot", "Deploy finished successfully.")).toBe(
      "Message from Release Bot: Deploy finished successfully.",
    );
  });

  it("truncates to only the first line of a multi-line body", () => {
    expect(peerMessagePreview("Release Bot", "Deploy finished.\nAll checks passed.")).toBe(
      "Message from Release Bot: Deploy finished.",
    );
  });

  it("omits the colon when the body is blank", () => {
    expect(peerMessagePreview("Release Bot", "")).toBe("Message from Release Bot");
  });
});
