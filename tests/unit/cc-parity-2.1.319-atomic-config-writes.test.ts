import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { makeTempHome, type TmpHome } from "./helpers/tmp-home";
import { removeServer, upsertServer } from "@/lib/server/mcp";
import { readKeybindings, writeKeybindings } from "@/lib/server/keybindings";

/**
 * CC 2.1.319 parity — "Fixed `~/.claude.json`, settings and edited files
 * ending up empty or cut off when the disk fills during a save".
 *
 * Claudius's `writeSettings` was already tmp + rename. Two other Claudius
 * writers of files the engine reads — `.mcp.json` / `~/.claude/mcp.json`
 * (`mcp.ts` `writeJson`) and `~/.claude/keybindings.json` — truncated the file
 * in place, so a failed write (ENOSPC) left it empty or cut off. They now
 * write a sibling temp file and rename it into place.
 */

/**
 * Fail every write the way a full disk does: the file is truncated, half the
 * body lands, then ENOSPC. On the old in-place write this cut the real file.
 */
function failWritesLikeFullDisk() {
  const real = fs.writeFile.bind(fs);
  return vi.spyOn(fs, "writeFile").mockImplementation(async (file, data, opts) => {
    const body = String(data);
    await real(file, body.slice(0, Math.floor(body.length / 2)), opts as never);
    throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
  });
}

async function leftoverTemps(dir: string): Promise<string[]> {
  return (await fs.readdir(dir)).filter((n) => n.includes(".tmp-"));
}

describe("CC 2.1.319 — config saves survive a failed write", () => {
  let home: TmpHome;
  let cwd: string;

  beforeEach(async () => {
    home = makeTempHome();
    cwd = await fs.mkdtemp(join(tmpdir(), "claudius-atomic-cfg-"));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    home.restore();
    await fs.rm(cwd, { recursive: true, force: true });
  });

  test("a failed .mcp.json save leaves the previous file whole", async () => {
    await upsertServer("project", cwd, "fs", { command: "npx", args: ["fs-mcp"] });
    const file = join(cwd, ".mcp.json");
    const before = await fs.readFile(file, "utf8");

    failWritesLikeFullDisk();
    await expect(upsertServer("project", cwd, "git", { command: "git-mcp" })).rejects.toThrow(/ENOSPC/);
    vi.restoreAllMocks();

    expect(await fs.readFile(file, "utf8")).toBe(before);
    expect(await leftoverTemps(cwd)).toEqual([]);
  });

  test("a .mcp.json save keeps the file's mode", async () => {
    await upsertServer("project", cwd, "fs", { command: "npx" });
    const file = join(cwd, ".mcp.json");
    await fs.chmod(file, 0o600);
    await upsertServer("project", cwd, "git", { command: "git-mcp" });
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect(Object.keys(JSON.parse(await fs.readFile(file, "utf8")).mcpServers)).toEqual(["fs", "git"]);
  });

  test("a symlinked .mcp.json is written through, not replaced", async () => {
    const real = join(cwd, "dotfiles-mcp.json");
    await fs.writeFile(real, "{}\n");
    await fs.symlink(real, join(cwd, ".mcp.json"));
    await upsertServer("project", cwd, "fs", { command: "npx" });
    expect((await fs.lstat(join(cwd, ".mcp.json"))).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await fs.readFile(real, "utf8")).mcpServers.fs).toEqual({ command: "npx" });
  });

  test("a failed keybindings save leaves the previous file whole", async () => {
    await writeKeybindings({ bindings: [{ key: "ctrl+k", command: "palette" }] });
    const { path } = await readKeybindings();
    const before = await fs.readFile(path, "utf8");

    failWritesLikeFullDisk();
    await expect(writeKeybindings({ bindings: [] })).rejects.toThrow(/ENOSPC/);
    vi.restoreAllMocks();

    expect(await fs.readFile(path, "utf8")).toBe(before);
    expect(await leftoverTemps(join(home.home, ".claude"))).toEqual([]);
    expect((await readKeybindings()).data.bindings).toEqual([{ key: "ctrl+k", command: "palette" }]);
  });
});

/**
 * CC 2.1.318 parity — "Fixed `claude mcp add` and `remove` writing the config
 * without its lock". Overlapping adds into the same file are serialized, so
 * neither drops the other's server.
 */
describe("CC 2.1.318 — overlapping MCP adds don't lose a server", () => {
  let home: TmpHome;
  let cwd: string;

  beforeEach(async () => {
    home = makeTempHome();
    cwd = await fs.mkdtemp(join(tmpdir(), "claudius-mcp-lock-"));
  });
  afterEach(async () => {
    home.restore();
    await fs.rm(cwd, { recursive: true, force: true });
  });

  test("project scope: five concurrent adds all land", async () => {
    const names = ["a", "b", "c", "d", "e"];
    await Promise.all(names.map((n) => upsertServer("project", cwd, n, { command: n })));
    const servers = JSON.parse(await fs.readFile(join(cwd, ".mcp.json"), "utf8")).mcpServers;
    expect(Object.keys(servers).sort()).toEqual(names);
  });

  test("user scope: concurrent add + remove of different servers both apply", async () => {
    await upsertServer("user", cwd, "keep-me", { command: "x" });
    await upsertServer("user", cwd, "drop-me", { command: "y" });
    await Promise.all([
      upsertServer("user", cwd, "new-one", { command: "z" }),
      removeServer("user", cwd, "drop-me"),
    ]);
    const settings = JSON.parse(await fs.readFile(join(home.home, ".claude", "settings.json"), "utf8"));
    expect(Object.keys(settings.mcpServers).sort()).toEqual(["keep-me", "new-one"]);
  });

  test("a failing write doesn't wedge the lock for the next caller", async () => {
    const spy = vi.spyOn(fs, "writeFile").mockRejectedValueOnce(new Error("EIO"));
    await expect(upsertServer("project", cwd, "a", { command: "a" })).rejects.toThrow("EIO");
    spy.mockRestore();
    await upsertServer("project", cwd, "b", { command: "b" });
    expect(Object.keys(JSON.parse(await fs.readFile(join(cwd, ".mcp.json"), "utf8")).mcpServers)).toEqual(["b"]);
  });
});
