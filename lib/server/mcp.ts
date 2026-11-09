import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathFor, readSettings, writeSettings } from "./settings";
import { assertWithin } from "./safe-path";

export type McpStdioConfig = {
  type?: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  alwaysLoad?: boolean;
  /**
   * Claude Code 2.1.287 escape hatch: advertise the bare (pre-2025-11-25)
   * elicitation capability. Set it when a server stopped connecting after
   * the CLI started offering URL elicitation.
   */
  bareElicitationCapability?: boolean;
};

export type McpHttpConfig = {
  type: "http";
  url: string;
  headers?: Record<string, string>;
  alwaysLoad?: boolean;
  /**
   * Claude Code 2.1.287 escape hatch: advertise the bare (pre-2025-11-25)
   * elicitation capability. Set it when a server stopped connecting after
   * the CLI started offering URL elicitation.
   */
  bareElicitationCapability?: boolean;
};

export type McpSseConfig = {
  type: "sse";
  url: string;
  headers?: Record<string, string>;
  alwaysLoad?: boolean;
  /**
   * Claude Code 2.1.287 escape hatch: advertise the bare (pre-2025-11-25)
   * elicitation capability. Set it when a server stopped connecting after
   * the CLI started offering URL elicitation.
   */
  bareElicitationCapability?: boolean;
};

export type McpServerConfig = McpStdioConfig | McpHttpConfig | McpSseConfig;

export type McpScope = "user" | "project" | "local";

export type ConfiguredServer = {
  scope: McpScope;
  name: string;
  config: McpServerConfig;
  /** Hidden leading/trailing whitespace found in this server's config values
   * (CC 2.1.218 parity — a pasted URL/header/env value with a stray space or
   * newline silently breaks the connection with no visual cue). Empty when
   * clean; omitted from the JSON payload only when there's nothing to warn about. */
  warnings?: string[];
};

const HAS_EDGE_WHITESPACE = /^\s|\s$/;

/** Pure — used both by `listConfigured` and its own unit tests. Flags any
 * string in the config (url, command, env/header keys+values) that carries
 * leading or trailing whitespace, which json/yaml editors don't visually
 * distinguish from a clean value. */
export function findConfigWhitespaceWarnings(config: McpServerConfig): string[] {
  const warnings: string[] = [];
  const flag = (label: string, value: string | undefined) => {
    if (value != null && HAS_EDGE_WHITESPACE.test(value)) warnings.push(`${label} has leading/trailing whitespace`);
  };

  if ("url" in config) flag("url", config.url);
  if ("command" in config) flag("command", config.command);

  const record = "env" in config ? config.env : "headers" in config ? config.headers : undefined;
  const recordLabel = "env" in config ? "env" : "header";
  if (record) {
    for (const [key, value] of Object.entries(record)) {
      flag(`${recordLabel} key "${key}"`, key);
      flag(`${recordLabel} value for "${key}"`, value);
    }
  }

  return warnings;
}

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
    // CC 2.1.299 parity — "Fixed claude mcp list, claude doctor and /status
    // reporting an empty .mcp.json as invalid". An empty (or whitespace-only)
    // file is a missing file, not a parse error: `JSON.parse("")` throws,
    // which 500'd GET /api/mcp and failed an add into that file. Upserting
    // then writes a fresh, valid `{ mcpServers }` object over it.
    if (!buf.trim()) return null;
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
  const body = JSON.stringify(value, null, 2) + "\n";
  // CC 2.1.319 parity — "Fixed ~/.claude.json, settings and edited files
  // ending up empty or cut off when the disk fills during a save". A plain
  // `fs.writeFile` truncates the target before writing, so ENOSPC (or a kill)
  // mid-write left `.mcp.json` empty or cut off — and the engine then loads
  // no MCP servers. Same tmp + rename shape as `writeSettings`, including the
  // write-through for a symlinked file (rename would sever a dotfiles link).
  const st = await fs.lstat(target).catch(() => null);
  if (st?.isSymbolicLink()) {
    await fs.writeFile(target, body, "utf8");
    return;
  }
  const tmpPath = assertWithin(dir, `.${basename(target)}.tmp-${process.pid}-${writeSeq++}`);
  const mode = st ? st.mode & 0o777 : undefined;
  try {
    await fs.writeFile(tmpPath, body, "utf8");
    if (mode !== undefined) await fs.chmod(tmpPath, mode);
    await fs.rename(tmpPath, target);
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
}

/** Per-process counter so concurrent `writeJson` calls never share a temp name. */
let writeSeq = 0;

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

  for (const server of out) {
    const warnings = findConfigWhitespaceWarnings(server.config);
    if (warnings.length > 0) server.warnings = warnings;
  }

  return out;
}

/**
 * CC 2.1.318 parity — "Fixed `claude mcp add` and `remove` writing the config
 * without its lock". Claudius's add / remove are read-modify-write on one
 * file with no serialization, so two overlapping requests (a double-submit,
 * two tabs) could each read the old file and the second write would drop the
 * first one's server. Serialize them per target file. This is an in-process
 * lock — it can't stop the engine (another process) from writing between our
 * read and write, the same limit the engine states for its own fix.
 */
const fileChains = new Map<string, Promise<unknown>>();

function withFileLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const prev = fileChains.get(file) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(
    () => {},
    () => {},
  );
  fileChains.set(file, tail);
  void tail.then(() => {
    if (fileChains.get(file) === tail) fileChains.delete(file);
  });
  return run;
}

function mcpTargetFile(scope: McpScope, cwd: string): string {
  if (scope === "project") return projectMcpJsonPath(cwd);
  return pathFor(scope === "user" ? "user" : "local", cwd);
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
  return withFileLock(mcpTargetFile(scope, cwd), () => upsertServerUnlocked(scope, cwd, name, config));
}

async function upsertServerUnlocked(
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
  return withFileLock(mcpTargetFile(scope, cwd), () => removeServerUnlocked(scope, cwd, name));
}

async function removeServerUnlocked(scope: McpScope, cwd: string, name: string): Promise<boolean> {
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
