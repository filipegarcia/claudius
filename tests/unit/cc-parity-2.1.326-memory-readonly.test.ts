import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MEMORY_READONLY_NOTICE,
  formatClaudeMdWriteError,
} from "@/lib/shared/claudemd-writable";

/**
 * CC 2.1.326 parity — "Fixed /memory opening a read-only file with no
 * warning that changes may not save". `readScope` reports `writable`, and a
 * failed write is described by `formatClaudeMdWriteError`.
 */

const { readScope } = await import("@/lib/server/claudemd");

// Root passes W_OK regardless of mode bits, so the chmod cases can't fail there.
const isRoot = process.getuid?.() === 0;

describe("formatClaudeMdWriteError", () => {
  test("names the file and errno with a hint", () => {
    const err = Object.assign(new Error("EACCES: permission denied, open '/p/CLAUDE.md'"), {
      code: "EACCES",
      path: "/p/CLAUDE.md",
    });
    expect(formatClaudeMdWriteError(err)).toBe("Couldn't save /p/CLAUDE.md: EACCES (permission denied)");
  });

  test("read-only file system", () => {
    expect(formatClaudeMdWriteError({ code: "EROFS", path: "/ro/CLAUDE.md" })).toBe(
      "Couldn't save /ro/CLAUDE.md: EROFS (read-only file system)",
    );
  });

  test("unknown errno is shown bare", () => {
    expect(formatClaudeMdWriteError({ code: "EIO", path: "/p/x.md" })).toBe("Couldn't save /p/x.md: EIO");
  });

  test("falls back to the given path and the message when the error has neither", () => {
    expect(formatClaudeMdWriteError(new Error("boom"), "/p/CLAUDE.local.md")).toBe(
      "Couldn't save /p/CLAUDE.local.md: boom",
    );
    expect(formatClaudeMdWriteError(null)).toBe("Couldn't save file: unknown error");
  });

  test("notice copy", () => {
    expect(MEMORY_READONLY_NOTICE).toBe("This file is read-only — changes may not save.");
  });
});

describe("readScope writable flag", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await fs.mkdtemp(join(tmpdir(), "claudius-claudemd-ro-"));
  });

  afterEach(async () => {
    await fs.chmod(projectDir, 0o755).catch(() => {});
    await fs.chmod(join(projectDir, "CLAUDE.md"), 0o644).catch(() => {});
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  test("existing writable file is writable", async () => {
    await fs.writeFile(join(projectDir, "CLAUDE.md"), "# hi\n", "utf8");
    const file = await readScope("project", projectDir);
    expect(file.exists).toBe(true);
    expect(file.writable).toBe(true);
  });

  test.skipIf(isRoot)("existing read-only file is not writable", async () => {
    await fs.writeFile(join(projectDir, "CLAUDE.md"), "# hi\n", "utf8");
    await fs.chmod(join(projectDir, "CLAUDE.md"), 0o444);
    const file = await readScope("project", projectDir);
    expect(file.exists).toBe(true);
    expect(file.writable).toBe(false);
  });

  test("missing file in a writable dir is writable", async () => {
    const file = await readScope("local", projectDir);
    expect(file.exists).toBe(false);
    expect(file.writable).toBe(true);
  });

  test("missing file under a missing subdir walks up to the nearest existing parent", async () => {
    // project-claude lives at <cwd>/.claude/CLAUDE.md — .claude doesn't exist yet.
    const file = await readScope("project-claude", projectDir);
    expect(file.exists).toBe(false);
    expect(file.writable).toBe(true);
  });

  test.skipIf(isRoot)("missing file under a read-only parent is not writable", async () => {
    await fs.chmod(projectDir, 0o555);
    const file = await readScope("project-claude", projectDir);
    expect(file.exists).toBe(false);
    expect(file.writable).toBe(false);
  });
});
