import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { appendMemoryIndex, autoMemoryDir, writeMemoryFile } from "@/lib/server/auto-memory";
import { makeTempHome, type TmpHome } from "./helpers/tmp-home";

/**
 * CC 2.1.210 parity: "Memory writes that leave a MEMORY.md index over its
 * read limit now produce an explicit error instead of silent truncation."
 * `auto-memory.ts` is Claudius's own reimplementation of Claude Code's
 * project-memory index (the SDK ships no memory-tool logic at all), and
 * previously `appendMemoryIndex` had no size guard — it appended forever.
 */
describe("auto-memory MEMORY.md read limit", () => {
  let tmp: TmpHome;
  const cwd = "/tmp/some-project";

  beforeEach(() => {
    tmp = makeTempHome();
  });

  afterEach(() => {
    tmp.restore();
  });

  test("appendMemoryIndex succeeds and writes the line under the limit", async () => {
    // appendMemoryIndex is always called after writeMemoryFile has already
    // mkdir'd the memory dir for the file it just wrote — mirror that here.
    const { mkdirSync } = await import("node:fs");
    mkdirSync(autoMemoryDir(cwd), { recursive: true });
    const result = await appendMemoryIndex(cwd, "notes.md", "Notes", "Some short description");
    expect(result).toEqual({ ok: true });
    const indexPath = join(autoMemoryDir(cwd), "MEMORY.md");
    expect(readFileSync(indexPath, "utf8")).toContain("- [Notes](notes.md) — Some short description");
  });

  test("appendMemoryIndex refuses with 413 instead of truncating when over the limit", async () => {
    // Pre-seed MEMORY.md right up against the limit so the next append tips
    // it over — asserting the file is refused, not silently truncated.
    const dir = autoMemoryDir(cwd);
    const indexPath = join(dir, "MEMORY.md");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(dir, { recursive: true });
    const filler = "- [padding](padding.md) — ".padEnd(19_950, "x") + "\n";
    writeFileSync(indexPath, filler, "utf8");
    const before = readFileSync(indexPath, "utf8");

    const result = await appendMemoryIndex(cwd, "overflow.md", "Overflow", "Pushes the index over the limit");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(413);
      expect(result.error).toMatch(/read limit/);
    }
    // Not silently truncated: the file on disk is exactly what it was before.
    expect(readFileSync(indexPath, "utf8")).toBe(before);
  });

  test("writeMemoryFile rolls back the memory file when the index append is refused", async () => {
    const dir = autoMemoryDir(cwd);
    const indexPath = join(dir, "MEMORY.md");
    const { mkdirSync, writeFileSync, existsSync } = await import("node:fs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(indexPath, "- [padding](padding.md) — ".padEnd(19_950, "x") + "\n", "utf8");

    const result = await writeMemoryFile(cwd, {
      filename: "overflow.md",
      type: "user",
      name: "Overflow",
      description: "Pushes the index over the limit",
      body: "body",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(413);
    expect(existsSync(join(dir, "overflow.md"))).toBe(false);
  });
});
