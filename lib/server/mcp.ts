import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readSettings, writeSettings } from "./settings";
import { assertWithin } from "./safe-path";

export type McpStdioConfig = {
  type?: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  alwaysLoad?: boolean;
};

export type McpHttpConfig = {
  type: "http";
  url: string;
  headers?: Record<string, string>;
  alwaysLoad?: boolean;
};

export type McpSseConfig = {
  type: "sse";
  url: string;
  headers?: Record<string, string>;
  alwaysLoad?: boolean;
};

export type McpServerConfig = McpStdioConfig | McpHttpConfig | McpSseConfig;

export type McpScope = "user" | "project" | "local";

export type ConfiguredServer = {
  scope: McpScope;
  name: string;
  config: McpServerConfig;
};

export function projectMcpJsonPath(cwd: string): string {
  // assertWithin acts as the path-injection barrier on the cwd → fs.*
  // flow that follows. The relative segment is a constant.
  return assertWithin(cwd, ".mcp.json");
}

export function userMcpJsonPath(): string {
  // Claude Code's CLI also stores per-user MCP servers inside settings.json under `mcpServers`,
  // but the canonical project file is `.mcp.json`. We mirror both.
  return assertWithin(join(homedir(), ".claude"), "mcp.json");
}

async function readJson<T>(p: string): Promise<T | null> {
  try {
    const buf = await fs.readFile(p, "utf8");
    return JSON.parse(buf) as T;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return null;
    throw err;
  }
}

async function writeJson(p: string, value: unknown): Promise<void> {
  // The directory must contain `p`, which is what assertWithin guarantees
  // upstream in `projectMcpJsonPath` / `userMcpJsonPath`. Re-asserting here
  // gives CodeQL the sanitizer directly at the fs.* call site.
  const dir = dirname(p);
  const target = assertWithin(dir, p);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(target, JSON.stringify(value, null, 2) + "\n", "utf8");
}

type McpJsonShape = { mcpServers?: Record<string, McpServerConfig> };

export async function listConfigured(cwd: string): Promise<ConfiguredServer[]> {
  const out: ConfiguredServer[] = [];

  // user — settings.json mcpServers + ~/.claude/mcp.json
  const userSettings = await readSettings("user", cwd);
  for (const [name, cfg] of Object.entries(userSettings.mcpServers ?? {})) {
    out.push({ scope: "user", name, config: cfg as McpServerConfig });
  }
  const userJson = await readJson<McpJsonShape>(userMcpJsonPath());
  for (const [name, cfg] of Object.entries(userJson?.mcpServers ?? {})) {
    if (out.some((s) => s.scope === "user" && s.name === name)) continue;
    out.push({ scope: "user", name, config: cfg });
  }

  // project — .mcp.json
  const projJson = await readJson<McpJsonShape>(projectMcpJsonPath(cwd));
  for (const [name, cfg] of Object.entries(projJson?.mcpServers ?? {})) {
    out.push({ scope: "project", name, config: cfg });
  }

  // local — settings.local.json mcpServers
  const localSettings = await readSettings("local", cwd);
  for (const [name, cfg] of Object.entries(localSettings.mcpServers ?? {})) {
    out.push({ scope: "local", name, config: cfg as McpServerConfig });
  }

  return out;
}

/**
 * Upsert a server in the chosen scope.
 *  - project → .mcp.json
 *  - user    → settings.json mcpServers
 *  - local   → settings.local.json mcpServers
 */
export async function upsertServer(
  scope: McpScope,
  cwd: string,
  name: string,
  config: McpServerConfig,
): Promise<void> {
  if (scope === "project") {
    const path = projectMcpJsonPath(cwd);
    const current = (await readJson<McpJsonShape>(path)) ?? {};
    current.mcpServers = { ...(current.mcpServers ?? {}), [name]: config };
    await writeJson(path, current);
    return;
  }
  const settingsScope = scope === "user" ? "user" : "local";
  const settings = await readSettings(settingsScope, cwd);
  const next = {
    ...settings,
    mcpServers: { ...(settings.mcpServers ?? {}), [name]: config } as Record<string, McpServerConfig>,
  };
  await writeSettings(settingsScope, cwd, next as Parameters<typeof writeSettings>[2]);
}

export async function removeServer(scope: McpScope, cwd: string, name: string): Promise<boolean> {
  if (scope === "project") {
    const path = projectMcpJsonPath(cwd);
    const current = await readJson<McpJsonShape>(path);
    if (!current?.mcpServers || !(name in current.mcpServers)) return false;
    delete current.mcpServers[name];
    await writeJson(path, current);
    return true;
  }
  const settingsScope = scope === "user" ? "user" : "local";
  const settings = await readSettings(settingsScope, cwd);
  const servers = settings.mcpServers as Record<string, unknown> | undefined;
  if (!servers || !(name in servers)) return false;
  delete servers[name];
  await writeSettings(settingsScope, cwd, settings);
  return true;
}
