import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  autoMemoryDir,
  parseMemoryFrontmatter,
  patchMemoryFile,
  readMemoryFile,
  writeMemoryFile,
} from "@/lib/server/auto-memory";
import { makeTempHome, type TmpHome } from "./helpers/tmp-home";

/**
 * CC 2.1.214 parity: "Added an ISO `modified` timestamp to memory file
 * frontmatter." `auto-memory.ts` is Claudius's own reimplementation of
 * Claude Code's per-project auto-memory files (the SDK ships no memory-tool
 * logic at all), so this is a bucket-B item — stamped/refreshed here rather
 * than arriving via the SDK updater.
 */
describe("auto-memory frontmatter modified timestamp", () => {
  let tmp: TmpHome;
  const cwd = "/tmp/some-project";

  beforeEach(() => {
    tmp = makeTempHome();
  });

  afterEach(() => {
    tmp.restore();
  });

  test("writeMemoryFile stamps a modified ISO timestamp in the frontmatter", async () => {
    const before = Date.now();
    const result = await writeMemoryFile(cwd, {
      filename: "notes.md",
      type: "user",
      name: "Notes",
      description: "Some notes",
      body: "body text",
    });
    expect(result.ok).toBe(true);

    const raw = await readMemoryFile(cwd, "notes.md");
    expect(raw).not.toBeNull();
    const parsed = parseMemoryFrontmatter(raw!);
    expect(parsed?.modified).toBeTruthy();
    const modifiedMs = new Date(parsed!.modified!).getTime();
    expect(modifiedMs).toBeGreaterThanOrEqual(before);
    expect(modifiedMs).toBeLessThanOrEqual(Date.now());
  });

  test("patchMemoryFile refreshes the modified timestamp on every patch", async () => {
    await writeMemoryFile(cwd, {
      filename: "notes.md",
      type: "user",
      name: "Notes",
      description: "Some notes",
      body: "body text",
    });
    const first = await readMemoryFile(cwd, "notes.md");
    const firstModified = parseMemoryFrontmatter(first!)?.modified;
    expect(firstModified).toBeTruthy();

    // Ensure the clock has moved forward at least 1ms so the timestamps
    // can't collide.
    await new Promise((r) => setTimeout(r, 5));

    const patched = await patchMemoryFile(cwd, { filename: "notes.md", body: "updated body" });
    expect(patched.ok).toBe(true);
    if (patched.ok) {
      expect(patched.parsed.modified).toBeTruthy();
      expect(new Date(patched.parsed.modified!).getTime()).toBeGreaterThan(
        new Date(firstModified!).getTime(),
      );
    }

    const second = await readMemoryFile(cwd, "notes.md");
    const secondModified = parseMemoryFrontmatter(second!)?.modified;
    expect(secondModified).toBe(patched.ok ? patched.parsed.modified : undefined);
  });

  test("parseMemoryFrontmatter tolerates files written before this parity change (no modified line)", () => {
    const legacy = "---\nname: Legacy\ndescription: pre-existing file\ntype: user\n---\n\nbody\n";
    const parsed = parseMemoryFrontmatter(legacy);
    expect(parsed?.name).toBe("Legacy");
    expect(parsed?.modified).toBeUndefined();
  });

  test("autoMemoryDir still resolves for the test cwd (sanity)", () => {
    expect(autoMemoryDir(cwd)).toContain("memory");
  });
});
