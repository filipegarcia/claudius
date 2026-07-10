import { describe, expect, test } from "vitest";
import { CLAUDE_MD_WARN_LINES, claudeMdSizeWarning } from "@/lib/server/claudemd";

/**
 * Coverage for CC 2.1.206 parity ("Added a `/doctor` check that proposes
 * trimming checked-in CLAUDE.md files by cutting content Claude could
 * derive from the codebase").
 *
 * `claudeMdSizeWarning()` is the pure boundary extracted out of
 * `app/api/doctor/route.ts` specifically so this threshold/link logic is
 * unit-testable without a workspace store or filesystem — the Playwright
 * spec (`cc-parity-2.1.206-doctor-claude-md.spec.ts`) only exercises the
 * mocked API response, not this function.
 */
describe("claudeMdSizeWarning", () => {
  test("returns null for empty content", () => {
    expect(claudeMdSizeWarning("wks_1", "")).toBeNull();
  });

  test("returns null at exactly the threshold", () => {
    const content = Array.from({ length: CLAUDE_MD_WARN_LINES }, (_, i) => `line ${i}`).join("\n");
    expect(content.split("\n").length).toBe(CLAUDE_MD_WARN_LINES);
    expect(claudeMdSizeWarning("wks_1", content)).toBeNull();
  });

  test("warns one line past the threshold", () => {
    const content = Array.from({ length: CLAUDE_MD_WARN_LINES + 1 }, (_, i) => `line ${i}`).join("\n");
    const warning = claudeMdSizeWarning("wks_1", content);
    expect(warning).not.toBeNull();
    expect(warning!.lines).toBe(CLAUDE_MD_WARN_LINES + 1);
    expect(warning!.detail).toContain(`${CLAUDE_MD_WARN_LINES + 1} lines`);
  });

  test("computes KB from byte length, not char length", () => {
    // 1024 non-ASCII (2-byte) chars → 2KB, well past the line threshold.
    const content = Array.from({ length: CLAUDE_MD_WARN_LINES + 5 }, () => "é".repeat(20)).join("\n");
    const warning = claudeMdSizeWarning("wks_1", content);
    expect(warning).not.toBeNull();
    expect(warning!.kb).toBeGreaterThan(content.length / 1024);
  });

  test("builds a link into the workspace's Memory page", () => {
    const content = Array.from({ length: CLAUDE_MD_WARN_LINES + 1 }, () => "x").join("\n");
    const warning = claudeMdSizeWarning("wks_abc123", content);
    expect(warning!.link).toEqual({ href: "/wks_abc123/memory", label: "Review in Memory" });
  });
});
