import { describe, expect, test } from "vitest";
import { hasIsolationWorktree, setIsolationWorktree } from "@/lib/client/agent-frontmatter";
import { parseFrontmatter } from "@/lib/server/agents";

/**
 * The agents UI exposes an "Isolated worktree" toggle that surgically edits the
 * `isolation: worktree` flag in an agent file's YAML frontmatter without
 * disturbing the rest of the block (key order, the template's `# Optional …`
 * comments, CRLF vs LF). These tests pin that round-trip and confirm the
 * resulting text still parses the way the server reads it.
 */
describe("agent-frontmatter isolation helpers", () => {
  test("hasIsolationWorktree detects the flag and ignores absent/body-only files", () => {
    expect(hasIsolationWorktree("---\nname: a\nisolation: worktree\n---\nBody\n")).toBe(true);
    expect(hasIsolationWorktree("---\nname: a\n---\nBody\n")).toBe(false);
    expect(hasIsolationWorktree("no frontmatter here\n")).toBe(false);
    // A commented-out template line must NOT count as enabled.
    expect(hasIsolationWorktree("---\n# isolation: worktree\n---\n")).toBe(false);
    // A different isolation value is not "worktree".
    expect(hasIsolationWorktree("---\nisolation: none\n---\n")).toBe(false);
  });

  test("setIsolationWorktree(on) appends the flag and preserves existing keys", () => {
    const raw = "---\nname: a\nmodel: claude-opus-4-7\n---\nBody.\n";
    const out = setIsolationWorktree(raw, true);
    expect(hasIsolationWorktree(out)).toBe(true);
    const { frontmatter, body } = parseFrontmatter(out);
    expect(frontmatter.name).toBe("a");
    expect(frontmatter.model).toBe("claude-opus-4-7");
    expect(frontmatter.isolation).toBe("worktree");
    expect(body).toBe("Body.\n");
  });

  test("turning it off removes only the isolation line and leaves a clean block", () => {
    const raw = "---\nname: a\nisolation: worktree\nmodel: x\n---\nBody.\n";
    const out = setIsolationWorktree(raw, false);
    expect(out).toBe("---\nname: a\nmodel: x\n---\nBody.\n");
    expect(hasIsolationWorktree(out)).toBe(false);
  });

  test("toggling on/off round-trips back to the original text", () => {
    const raw = "---\nname: a\nmodel: x\n---\nBody.\n";
    expect(setIsolationWorktree(setIsolationWorktree(raw, true), false)).toBe(raw);
  });

  test("set is idempotent and replaces a stale isolation value in place", () => {
    const onTwice = setIsolationWorktree(setIsolationWorktree("---\nname: a\n---\nB\n", true), true);
    expect(onTwice).toBe("---\nname: a\nisolation: worktree\n---\nB\n");
    const replaced = setIsolationWorktree("---\nisolation: none\nname: a\n---\nB\n", true);
    expect(replaced).toBe("---\nisolation: worktree\nname: a\n---\nB\n");
  });

  test("a body-only file gains a frontmatter block when enabled, and is a no-op when disabled", () => {
    const body = "Just a prompt.\n";
    expect(setIsolationWorktree(body, false)).toBe(body);
    const out = setIsolationWorktree(body, true);
    expect(out).toBe("---\nisolation: worktree\n---\nJust a prompt.\n");
    expect(hasIsolationWorktree(out)).toBe(true);
  });

  test("preserves CRLF line endings", () => {
    const raw = "---\r\nname: a\r\n---\r\nBody.\r\n";
    const out = setIsolationWorktree(raw, true);
    expect(out).toBe("---\r\nname: a\r\nisolation: worktree\r\n---\r\nBody.\r\n");
    expect(hasIsolationWorktree(out)).toBe(true);
  });
});
