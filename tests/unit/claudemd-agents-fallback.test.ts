import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Coverage for Claude Code 2.1.277 parity ("Added AGENTS.md support: in a
 * project with no CLAUDE.md, Claude Code reads AGENTS.md instead") —
 * Claudius's own Memory page (`readScope`/`writeScope` "project" scope)
 * mirrors that fallback so it shows the same file the live agent session
 * actually reads.
 */

const { readScope, writeScope } = await import("@/lib/server/claudemd");

describe("claudemd — AGENTS.md project-instructions fallback", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await fs.mkdtemp(join(tmpdir(), "claudius-claudemd-agents-"));
  });

  afterEach(async () => {
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  test("read falls back to AGENTS.md when no CLAUDE.md exists", async () => {
    await fs.writeFile(join(projectDir, "AGENTS.md"), "# Agents\n\nBuild with bun.\n", "utf8");

    const file = await readScope("project", projectDir);

    expect(file.exists).toBe(true);
    expect(file.usingAgentsFallback).toBe(true);
    expect(file.path).toBe(join(projectDir, "AGENTS.md"));
    expect(file.content).toContain("Build with bun.");
  });

  test("read prefers CLAUDE.md when both CLAUDE.md and AGENTS.md exist", async () => {
    await fs.writeFile(join(projectDir, "CLAUDE.md"), "# Claude\n", "utf8");
    await fs.writeFile(join(projectDir, "AGENTS.md"), "# Agents\n", "utf8");

    const file = await readScope("project", projectDir);

    expect(file.usingAgentsFallback).toBeUndefined();
    expect(file.path).toBe(join(projectDir, "CLAUDE.md"));
    expect(file.content).toBe("# Claude\n");
  });

  test("read reports missing (no fallback) when neither file exists", async () => {
    const file = await readScope("project", projectDir);

    expect(file.exists).toBe(false);
    expect(file.usingAgentsFallback).toBeUndefined();
    expect(file.path).toBe(join(projectDir, "CLAUDE.md"));
  });

  test("write targets AGENTS.md when it's the active fallback", async () => {
    await fs.writeFile(join(projectDir, "AGENTS.md"), "# Agents\n", "utf8");

    const { path } = await writeScope("project", projectDir, "# Agents\n\nUpdated.\n");

    expect(path).toBe(join(projectDir, "AGENTS.md"));
    await expect(fs.readFile(join(projectDir, "AGENTS.md"), "utf8")).resolves.toContain("Updated.");
    await expect(fs.access(join(projectDir, "CLAUDE.md"))).rejects.toThrow();
  });

  test("write targets CLAUDE.md when neither file exists yet", async () => {
    const { path } = await writeScope("project", projectDir, "# New project\n");

    expect(path).toBe(join(projectDir, "CLAUDE.md"));
    await expect(fs.readFile(join(projectDir, "CLAUDE.md"), "utf8")).resolves.toBe(
      "# New project\n",
    );
  });

  test("write targets CLAUDE.md when it already exists, even if AGENTS.md is also present", async () => {
    await fs.writeFile(join(projectDir, "CLAUDE.md"), "# Claude\n", "utf8");
    await fs.writeFile(join(projectDir, "AGENTS.md"), "# Agents\n", "utf8");

    const { path } = await writeScope("project", projectDir, "# Claude\n\nUpdated.\n");

    expect(path).toBe(join(projectDir, "CLAUDE.md"));
    await expect(fs.readFile(join(projectDir, "AGENTS.md"), "utf8")).resolves.toBe("# Agents\n");
  });
});
