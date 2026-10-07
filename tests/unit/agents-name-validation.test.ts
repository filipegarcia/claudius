import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { writeAgent, readAgent } from "@/lib/server/agents";

/**
 * CC 2.1.218 parity — "agent markdown files reject names containing ':',
 * reserved for plugin namespacing". The on-disk filename was already
 * `\w`-restricted (agentPath's `/^[\w.\-]+$/` check predates this release
 * and incidentally excludes ':'); this release closes the other half —
 * the free-text frontmatter `name:` field a user can type directly into
 * the raw markdown textarea, previously unvalidated.
 */
describe("writeAgent — frontmatter name colon rejection", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await fs.mkdtemp(join(tmpdir(), "claudius-agents-test-"));
  });

  afterEach(async () => {
    await fs.rm(cwd, { recursive: true, force: true });
  });

  test("rejects a frontmatter name containing ':'", async () => {
    const raw = ["---", "name: my-plugin:sub-agent", "---", "Prompt body.", ""].join("\n");
    await expect(writeAgent("project", cwd, "my-agent", raw)).rejects.toThrow(/reserved for plugin namespacing/);
  });

  test("accepts a clean frontmatter name with no colon", async () => {
    const raw = ["---", "name: my-agent", "---", "Prompt body.", ""].join("\n");
    await expect(writeAgent("project", cwd, "my-agent", raw)).resolves.toBeUndefined();
    const file = await readAgent("project", cwd, "my-agent");
    expect(file?.frontmatter.name).toBe("my-agent");
  });

  test("still rejects an invalid on-disk filename regardless of frontmatter content", async () => {
    const raw = ["---", "name: fine", "---", "Prompt body.", ""].join("\n");
    await expect(writeAgent("project", cwd, "bad:name", raw)).rejects.toThrow(/invalid agent name/);
  });

  test("CC 2.1.292: rejects a frontmatter name over 256 characters, accepts exactly 256", async () => {
    const long = ["---", `name: ${"a".repeat(257)}`, "---", "Body.", ""].join("\n");
    await expect(writeAgent("project", cwd, "long-fm", long)).rejects.toThrow(/too long/);
    const ok = ["---", `name: ${"a".repeat(256)}`, "---", "Body.", ""].join("\n");
    await expect(writeAgent("project", cwd, "ok-fm", ok)).resolves.toBeUndefined();
  });

  test("CC 2.1.292: rejects an on-disk name over 256 characters", async () => {
    const raw = ["---", "name: fine", "---", "Body.", ""].join("\n");
    await expect(writeAgent("project", cwd, "b".repeat(257), raw)).rejects.toThrow(/too long/);
  });

  test("agents with no name field in frontmatter are unaffected", async () => {
    const raw = ["---", "description: no name field here", "---", "Prompt body.", ""].join("\n");
    await expect(writeAgent("project", cwd, "nameless", raw)).resolves.toBeUndefined();
  });
});
