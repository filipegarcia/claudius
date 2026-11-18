import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { makeTempHome, type TmpHome } from "./helpers/tmp-home";
import { hasTopLevelServers, listConfigured, McpJsonShapeError, upsertServer } from "@/lib/server/mcp";

const trusted = { resolveTrustedCwd: vi.fn<(cwd: unknown) => Promise<string | null>>() };
vi.mock("@/lib/server/trusted-cwd", () => trusted);
vi.mock("@/lib/server/session-manager", () => ({ sessionManager: { get: () => undefined } }));

const { POST } = await import("@/app/api/mcp/route");

/**
 * CC 2.1.327 parity — "Changed claude mcp add --scope project to stop,
 * instead of overwriting the file, when .mcp.json lists its servers at the
 * top level with no mcpServers key". Claudius used to turn a flat
 * `{ foo: {...} }` into a mixed `{ foo, mcpServers: { new } }`.
 */
describe("project .mcp.json shape on add", () => {
  let home: TmpHome;
  let cwd: string;
  let file: string;
  const added = { command: "npx", args: ["-y", "fs-mcp"] };

  beforeEach(async () => {
    home = makeTempHome();
    cwd = await fs.mkdtemp(join(tmpdir(), "claudius-mcp-shape-"));
    file = join(cwd, ".mcp.json");
  });
  afterEach(async () => {
    home.restore();
    await fs.rm(cwd, { recursive: true, force: true });
  });

  const read = async () => JSON.parse(await fs.readFile(file, "utf8"));

  test("a missing file is created with mcpServers", async () => {
    await upsertServer("project", cwd, "fs", added);
    expect(await read()).toEqual({ mcpServers: { fs: added } });
  });

  test("an empty {} file gets mcpServers", async () => {
    await fs.writeFile(file, "{}\n");
    await upsertServer("project", cwd, "fs", added);
    expect(await read()).toEqual({ mcpServers: { fs: added } });
  });

  test("a file with only $schema keeps it and gets mcpServers", async () => {
    await fs.writeFile(file, JSON.stringify({ $schema: "https://example.com/mcp.schema.json" }));
    await upsertServer("project", cwd, "fs", added);
    expect(await read()).toEqual({ $schema: "https://example.com/mcp.schema.json", mcpServers: { fs: added } });
  });

  test("a normal file keeps its servers and adds the new one", async () => {
    await fs.writeFile(file, JSON.stringify({ mcpServers: { linear: { type: "http", url: "https://x/mcp" } } }));
    await upsertServer("project", cwd, "fs", added);
    expect(await read()).toEqual({ mcpServers: { linear: { type: "http", url: "https://x/mcp" }, fs: added } });
  });

  test("a file that has mcpServers plus a server-looking top-level key still writes", async () => {
    await fs.writeFile(file, JSON.stringify({ mcpServers: {}, stray: { command: "x" } }));
    await upsertServer("project", cwd, "fs", added);
    expect(await read()).toEqual({ mcpServers: { fs: added }, stray: { command: "x" } });
  });

  test("a top-level object that doesn't look like a server still writes", async () => {
    await fs.writeFile(file, JSON.stringify({ foo: { bar: 1 } }));
    await upsertServer("project", cwd, "fs", added);
    expect(await read()).toEqual({ foo: { bar: 1 }, mcpServers: { fs: added } });
  });

  test.each([
    ["command", { foo: { command: "node", args: ["server.js"] } }],
    ["url", { foo: { url: "https://example.com/mcp" } }],
    ["type", { foo: { type: "sse", url: "https://example.com/sse" } }],
  ])("a flat file (server with %s) is refused and left untouched", async (_label, flat) => {
    const before = JSON.stringify(flat, null, 2);
    await fs.writeFile(file, before);
    const err = await upsertServer("project", cwd, "fs", added).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpJsonShapeError);
    expect((err as Error).message).toBe(
      '.mcp.json lists its servers at the top level. Move them under "mcpServers" first, then add this server.',
    );
    expect(await fs.readFile(file, "utf8")).toBe(before);
  });

  test("other scopes are unaffected by the project file's shape", async () => {
    await fs.writeFile(file, JSON.stringify({ foo: { command: "node" } }));
    await expect(upsertServer("local", cwd, "fs", added)).resolves.toBeUndefined();
  });

  test("POST /api/mcp answers 409 with the reason for a flat file", async () => {
    trusted.resolveTrustedCwd.mockResolvedValue(cwd);
    await fs.writeFile(file, JSON.stringify({ foo: { command: "node" } }));
    const res = await POST(
      new Request("http://localhost/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope: "project", cwd, name: "fs", config: added }),
      }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: new McpJsonShapeError().message });
  });

  test("POST /api/mcp turns a malformed body into a JSON 400", async () => {
    const res = await POST(new Request("http://localhost/api/mcp", { method: "POST", body: "{ nope" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid JSON body" });
  });

  test("POST /api/mcp turns other write failures into a JSON 500", async () => {
    trusted.resolveTrustedCwd.mockResolvedValue(cwd);
    await fs.writeFile(file, "{ nope");
    const res = await POST(
      new Request("http://localhost/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope: "project", cwd, name: "fs", config: added }),
      }),
    );
    expect(res.status).toBe(500);
    expect(typeof (await res.json()).error).toBe("string");
  });

  test("hasTopLevelServers", () => {
    expect(hasTopLevelServers(null)).toBe(false);
    expect(hasTopLevelServers([])).toBe(false);
    expect(hasTopLevelServers({})).toBe(false);
    expect(hasTopLevelServers({ $schema: "x" })).toBe(false);
    expect(hasTopLevelServers({ foo: null, bar: [{ command: "x" }] })).toBe(false);
    expect(hasTopLevelServers({ foo: { command: "x" } })).toBe(true);
    expect(hasTopLevelServers({ mcpServers: {}, foo: { command: "x" } })).toBe(false);
  });

  test("project servers named in disabledMcpjsonServers (any scope) are marked rejected", async () => {
    await fs.writeFile(file, JSON.stringify({ mcpServers: { linear: added, sentry: added, jira: added } }));
    await fs.mkdir(join(cwd, ".claude"), { recursive: true });
    await fs.writeFile(join(cwd, ".claude", "settings.local.json"), JSON.stringify({ disabledMcpjsonServers: ["sentry"] }));
    await fs.writeFile(join(cwd, ".claude", "settings.json"), JSON.stringify({ disabledMcpjsonServers: ["jira"] }));
    const byName = Object.fromEntries((await listConfigured(cwd)).map((s) => [s.name, s.rejected ?? false]));
    expect(byName).toEqual({ linear: false, sentry: true, jira: true });
  });

  test("a project settings.json that doesn't load doesn't fail the list", async () => {
    await fs.writeFile(file, JSON.stringify({ mcpServers: { linear: added } }));
    await fs.mkdir(join(cwd, ".claude"), { recursive: true });
    await fs.writeFile(join(cwd, ".claude", "settings.json"), "{ not json");
    expect((await listConfigured(cwd)).map((s) => [s.name, s.rejected])).toEqual([["linear", undefined]]);
  });
});
