import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { makeTempHome, type TmpHome } from "./helpers/tmp-home";
import { listConfigured, removeServer, upsertServer } from "@/lib/server/mcp";

/**
 * CC 2.1.299 parity — "Fixed claude mcp list, claude doctor and /status
 * reporting an empty .mcp.json as invalid". An empty or whitespace-only
 * `.mcp.json` (project) or `~/.claude/mcp.json` (user) reads as "no servers"
 * instead of throwing — GET /api/mcp used to 500 on it.
 */
describe("empty .mcp.json", () => {
  let home: TmpHome;
  let cwd: string;

  beforeEach(async () => {
    home = makeTempHome();
    cwd = await fs.mkdtemp(join(tmpdir(), "claudius-empty-mcp-"));
  });
  afterEach(async () => {
    home.restore();
    await fs.rm(cwd, { recursive: true, force: true });
  });

  test.each([
    ["empty", ""],
    ["whitespace-only", "  \n\t\n"],
  ])("an %s project .mcp.json lists no servers", async (_label, body) => {
    await fs.writeFile(join(cwd, ".mcp.json"), body);
    await expect(listConfigured(cwd)).resolves.toEqual([]);
  });

  test("an empty user mcp.json lists no servers", async () => {
    await fs.mkdir(join(home.home, ".claude"), { recursive: true });
    await fs.writeFile(join(home.home, ".claude", "mcp.json"), "");
    await expect(listConfigured(cwd)).resolves.toEqual([]);
  });

  test("adding a project server into an empty file writes valid JSON", async () => {
    const file = join(cwd, ".mcp.json");
    await fs.writeFile(file, "\n");
    await upsertServer("project", cwd, "fs", { command: "npx", args: ["-y", "fs-mcp"] });

    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({
      mcpServers: { fs: { command: "npx", args: ["-y", "fs-mcp"] } },
    });
    const listed = await listConfigured(cwd);
    expect(listed).toEqual([{ scope: "project", name: "fs", config: { command: "npx", args: ["-y", "fs-mcp"] } }]);
  });

  test("removing from an empty file is a no-op miss, not a throw", async () => {
    await fs.writeFile(join(cwd, ".mcp.json"), "");
    await expect(removeServer("project", cwd, "fs")).resolves.toBe(false);
  });

  test("malformed (non-empty) JSON still throws", async () => {
    await fs.writeFile(join(cwd, ".mcp.json"), "{ nope");
    await expect(listConfigured(cwd)).rejects.toThrow();
  });
});
