import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  pathFor,
  readSettings,
  writeSettings,
  type ClaudeSettings,
  type SettingsScope,
} from "./settings";

export type PluginsByScope = {
  scope: SettingsScope;
  path: string;
  enabledPlugins: Record<string, boolean>;
  extraKnownMarketplaces: string[];
  strictKnownMarketplaces: boolean;
  blockedMarketplaces: string[];
};

export type AvailablePlugin = {
  /** The marketplace directory name (matches the install ref's `@…` part). */
  marketplace: string;
  name: string;
  description?: string;
  author?: { name?: string; email?: string } | string;
  category?: string;
  homepage?: string;
  /** Public unique-install count from Anthropic's plugin counts cache, when known. */
  installs?: number;
};

function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export async function listAll(cwd: string): Promise<PluginsByScope[]> {
  const scopes: SettingsScope[] = ["user", "project", "local"];
  const out: PluginsByScope[] = [];
  for (const scope of scopes) {
    const settings = await readSettings(scope, cwd);
    const ep = settings.enabledPlugins;
    out.push({
      scope,
      path: pathFor(scope, cwd),
      enabledPlugins: typeof ep === "object" && ep ? (ep as Record<string, boolean>) : {},
      extraKnownMarketplaces: strArr((settings as { extraKnownMarketplaces?: unknown }).extraKnownMarketplaces),
      strictKnownMarketplaces: Boolean(
        (settings as { strictKnownMarketplaces?: unknown }).strictKnownMarketplaces,
      ),
      blockedMarketplaces: strArr((settings as { blockedMarketplaces?: unknown }).blockedMarketplaces),
    });
  }
  return out;
}

export async function setEnabled(
  scope: SettingsScope,
  cwd: string,
  pluginId: string,
  enabled: boolean,
): Promise<void> {
  const settings = await readSettings(scope, cwd);
  const ep =
    typeof settings.enabledPlugins === "object" && settings.enabledPlugins
      ? { ...(settings.enabledPlugins as Record<string, boolean>) }
      : {};
  if (enabled) ep[pluginId] = true;
  else delete ep[pluginId];
  const next: ClaudeSettings = {
    ...settings,
    enabledPlugins: Object.keys(ep).length ? ep : undefined,
  };
  if (next.enabledPlugins === undefined) delete next.enabledPlugins;
  await writeSettings(scope, cwd, next);
}

/**
 * Read Anthropic's install-counts cache (`~/.claude/plugins/install-counts-cache.json`).
 * Best-effort — returns an empty Map if the file is missing or malformed.
 */
async function readInstallCounts(): Promise<Map<string, number>> {
  const path = join(homedir(), ".claude", "plugins", "install-counts-cache.json");
  try {
    const raw = await fs.readFile(path, "utf8");
    const parsed = JSON.parse(raw) as {
      counts?: Array<{ plugin?: unknown; unique_installs?: unknown }>;
    };
    const out = new Map<string, number>();
    if (Array.isArray(parsed.counts)) {
      for (const c of parsed.counts) {
        if (typeof c?.plugin === "string" && typeof c.unique_installs === "number") {
          out.set(c.plugin, c.unique_installs);
        }
      }
    }
    return out;
  } catch {
    return new Map();
  }
}

/**
 * Walks every cached marketplace under `~/.claude/plugins/marketplaces/`,
 * parses its `marketplace.json`, and returns a flat list of available
 * plugins keyed by marketplace name. Result is sorted by public install
 * count (most popular first), then alphabetically by name for ties.
 */
export async function listAvailable(): Promise<AvailablePlugin[]> {
  const root = join(homedir(), ".claude", "plugins", "marketplaces");
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return [];
    throw err;
  }
  const counts = await readInstallCounts();
  const out: AvailablePlugin[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(root, entry.name, ".claude-plugin", "marketplace.json");
    try {
      const raw = await fs.readFile(manifestPath, "utf8");
      const manifest = JSON.parse(raw) as {
        plugins?: Array<{
          name?: unknown;
          description?: unknown;
          author?: unknown;
          category?: unknown;
          homepage?: unknown;
        }>;
      };
      if (!Array.isArray(manifest.plugins)) continue;
      for (const p of manifest.plugins) {
        if (typeof p?.name !== "string" || !p.name) continue;
        const ref = `${p.name}@${entry.name}`;
        out.push({
          marketplace: entry.name,
          name: p.name,
          description: typeof p.description === "string" ? p.description : undefined,
          author:
            typeof p.author === "string"
              ? p.author
              : p.author && typeof p.author === "object"
                ? (p.author as { name?: string; email?: string })
                : undefined,
          category: typeof p.category === "string" ? p.category : undefined,
          homepage: typeof p.homepage === "string" ? p.homepage : undefined,
          installs: counts.get(ref),
        });
      }
    } catch {
      // Manifest missing or malformed — skip silently.
    }
  }
  // Most installs first; missing counts sort last; ties → alphabetical name.
  out.sort((a, b) => {
    const ai = a.installs ?? -1;
    const bi = b.installs ?? -1;
    if (bi !== ai) return bi - ai;
    return a.name.localeCompare(b.name);
  });
  return out;
}

export async function setMarketplaces(
  scope: SettingsScope,
  cwd: string,
  patch: {
    extraKnownMarketplaces?: string[];
    strictKnownMarketplaces?: boolean;
    blockedMarketplaces?: string[];
  },
): Promise<void> {
  const settings = await readSettings(scope, cwd);
  const next: ClaudeSettings = { ...settings };
  if (patch.extraKnownMarketplaces !== undefined) {
    if (patch.extraKnownMarketplaces.length === 0) delete (next as Record<string, unknown>).extraKnownMarketplaces;
    else (next as Record<string, unknown>).extraKnownMarketplaces = patch.extraKnownMarketplaces;
  }
  if (patch.strictKnownMarketplaces !== undefined) {
    if (!patch.strictKnownMarketplaces) delete (next as Record<string, unknown>).strictKnownMarketplaces;
    else (next as Record<string, unknown>).strictKnownMarketplaces = true;
  }
  if (patch.blockedMarketplaces !== undefined) {
    if (patch.blockedMarketplaces.length === 0) delete (next as Record<string, unknown>).blockedMarketplaces;
    else (next as Record<string, unknown>).blockedMarketplaces = patch.blockedMarketplaces;
  }
  await writeSettings(scope, cwd, next);
}
