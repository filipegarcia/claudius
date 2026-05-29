import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { assertWithin } from "./safe-path";

export type SettingsScope = "user" | "project" | "local";

export type PermissionRules = {
  allow?: string[];
  ask?: string[];
  deny?: string[];
  defaultMode?: string;
  additionalDirectories?: string[];
};

export type ClaudeSettings = {
  model?: string;
  theme?: string;
  outputStyle?: string;
  permissions?: PermissionRules;
  hooks?: Record<string, unknown>;
  mcpServers?: Record<string, unknown>;
  enabledPlugins?: Record<string, boolean>;
  autoMemoryEnabled?: boolean;
  // Predicted next-user-prompt chips (PromptSuggestions). The SDK's canonical
  // settings key: "When false, prompt suggestions are disabled. When absent or
  // true, prompt suggestions are enabled." Read at session start in
  // `session.ts` and forwarded to the SDK's `Options.promptSuggestions`.
  promptSuggestionEnabled?: boolean;
  // Catch-all for keys we don't yet know about — we never strip them.
  [key: string]: unknown;
};

export function pathFor(scope: SettingsScope, projectCwd: string): string {
  // assertWithin acts as the path-injection barrier on the projectCwd →
  // fs.* flow. The relative segment is always a constant string, so this
  // is effectively a "stays inside the workspace's .claude dir" guard.
  if (scope === "user") return assertWithin(join(homedir(), ".claude"), "settings.json");
  if (scope === "project") return assertWithin(projectCwd, join(".claude", "settings.json"));
  return assertWithin(projectCwd, join(".claude", "settings.local.json"));
}

export async function readSettings(scope: SettingsScope, projectCwd: string): Promise<ClaudeSettings> {
  const path = pathFor(scope, projectCwd);
  try {
    const buf = await fs.readFile(path, "utf8");
    return JSON.parse(buf) as ClaudeSettings;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return {};
    throw err;
  }
}

export async function writeSettings(
  scope: SettingsScope,
  projectCwd: string,
  next: ClaudeSettings,
): Promise<void> {
  const path = pathFor(scope, projectCwd);
  await fs.mkdir(dirname(path), { recursive: true });
  // Pretty-print with 2 spaces, matches Claude Code conventions.
  await fs.writeFile(path, JSON.stringify(next, null, 2) + "\n", "utf8");
}

export async function updatePermissions(
  scope: SettingsScope,
  projectCwd: string,
  patch: Partial<PermissionRules>,
): Promise<ClaudeSettings> {
  const current = await readSettings(scope, projectCwd);
  const next: ClaudeSettings = {
    ...current,
    permissions: {
      ...(current.permissions ?? {}),
      ...patch,
    },
  };
  await writeSettings(scope, projectCwd, next);
  return next;
}
