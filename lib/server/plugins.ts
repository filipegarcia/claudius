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
import {
  addExtraMarketplace as addExtraEntry,
  readExtraMarketplaces,
  readPolicyMarketplaces,
  removeExtraMarketplace as removeExtraEntry,
  removePolicyMarketplace,
  type ExtraMarketplaceView,
  type MarketplaceSource,
  type MarketplaceSourceView,
} from "@/lib/shared/marketplace-settings";

export type PluginsByScope = {
  scope: SettingsScope;
  path: string;
  enabledPlugins: Record<string, boolean>;
  /**
   * G1 — redacted views of the three marketplace keys (SDK object/array
   * shapes). Header values and headersHelper text are withheld; they never
   * leave the server. `legacyExtra` flags a pre-G1 Claudius `string[]` that
   * can't be migrated automatically (the user removes those entries).
   */
  extraKnownMarketplaces: ExtraMarketplaceView[];
  strictKnownMarketplaces: MarketplaceSourceView[];
  blockedMarketplaces: MarketplaceSourceView[];
  legacyExtra: boolean;
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

/**
 * Claude Code 2.1.232 added two settings aliases: `additionalMarketplaces`
 * aliases `extraKnownMarketplaces`, and `allowedMarketplaces` aliases
 * `strictKnownMarketplaces`. The canonical spelling wins when both keys are
 * present in the same file (the alias is ignored with a warning), so we only
 * fall back to the alias when the canonical key is absent — mirroring the CLI.
 */
function aliased(settings: ClaudeSettings, canonical: string, alias: string): unknown {
  const s = settings as Record<string, unknown>;
  return canonical in s ? s[canonical] : s[alias];
}

export async function listAll(cwd: string): Promise<PluginsByScope[]> {
  const scopes: SettingsScope[] = ["user", "project", "local"];
  const out: PluginsByScope[] = [];
  for (const scope of scopes) {
    const settings = await readSettings(scope, cwd);
    const ep = settings.enabledPlugins;
    const extraRaw = aliased(settings, "extraKnownMarketplaces", "additionalMarketplaces");
    out.push({
      scope,
      path: pathFor(scope, cwd),
      enabledPlugins: typeof ep === "object" && ep ? (ep as Record<string, boolean>) : {},
      extraKnownMarketplaces: readExtraMarketplaces(extraRaw),
      strictKnownMarketplaces: readPolicyMarketplaces(
        aliased(settings, "strictKnownMarketplaces", "allowedMarketplaces"),
      ),
      blockedMarketplaces: readPolicyMarketplaces(
        (settings as { blockedMarketplaces?: unknown }).blockedMarketplaces,
      ),
      legacyExtra: Array.isArray(extraRaw),
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

/**
 * G1 — structural marketplace edits. Each op reads the raw stored value,
 * applies one change via the pure helpers (which preserve every untouched
 * entry and any source kind this code doesn't model), and writes under the
 * canonical key, dropping the alias so the two spellings can't coexist. No
 * full-list rewrite, so a rich object/array config is never clobbered.
 */
export async function addExtraMarketplace(
  scope: SettingsScope,
  cwd: string,
  name: string,
  source: MarketplaceSource,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const settings = await readSettings(scope, cwd);
  const raw = aliased(settings, "extraKnownMarketplaces", "additionalMarketplaces");
  const res = addExtraEntry(raw, name, source);
  if (!res.ok) return res;
  const next = { ...settings } as Record<string, unknown>;
  delete next.additionalMarketplaces;
  next.extraKnownMarketplaces = res.value;
  await writeSettings(scope, cwd, next as ClaudeSettings);
  return { ok: true };
}

export async function removeExtraMarketplace(
  scope: SettingsScope,
  cwd: string,
  name: string,
): Promise<void> {
  const settings = await readSettings(scope, cwd);
  const raw = aliased(settings, "extraKnownMarketplaces", "additionalMarketplaces");
  const value = removeExtraEntry(raw, name);
  const next = { ...settings } as Record<string, unknown>;
  delete next.additionalMarketplaces;
  if (value === undefined) delete next.extraKnownMarketplaces;
  else next.extraKnownMarketplaces = value;
  await writeSettings(scope, cwd, next as ClaudeSettings);
}

export async function removePolicyMarketplaceEntry(
  scope: SettingsScope,
  cwd: string,
  list: "strict" | "blocked",
  index: number,
): Promise<void> {
  const settings = await readSettings(scope, cwd);
  const next = { ...settings } as Record<string, unknown>;
  if (list === "strict") {
    const raw = aliased(settings, "strictKnownMarketplaces", "allowedMarketplaces");
    const value = removePolicyMarketplace(raw, index);
    delete next.allowedMarketplaces;
    if (value === undefined) delete next.strictKnownMarketplaces;
    else next.strictKnownMarketplaces = value;
  } else {
    const value = removePolicyMarketplace((settings as { blockedMarketplaces?: unknown }).blockedMarketplaces, index);
    if (value === undefined) delete next.blockedMarketplaces;
    else next.blockedMarketplaces = value;
  }
  await writeSettings(scope, cwd, next as ClaudeSettings);
}
