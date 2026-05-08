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
