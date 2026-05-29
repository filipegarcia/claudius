import {
  pathFor,
  readSettings,
  writeSettings,
  type ClaudeSettings,
  type SettingsScope,
} from "./settings";
import type { HookEvent, HookGroup, HooksMap } from "@/lib/shared/hook-events";

export type ScopedHooks = {
  scope: SettingsScope;
  path: string;
  disableAllHooks: boolean;
  hooks: HooksMap;
};

function readHooks(settings: ClaudeSettings): HooksMap {
  const raw = settings.hooks as unknown;
  if (!raw || typeof raw !== "object") return {};
  return raw as HooksMap;
}

export async function listAll(cwd: string): Promise<ScopedHooks[]> {
  const scopes: SettingsScope[] = ["user", "project", "local"];
  const out: ScopedHooks[] = [];
  for (const scope of scopes) {
    const settings = await readSettings(scope, cwd);
    out.push({
      scope,
      path: pathFor(scope, cwd),
      disableAllHooks: Boolean(settings.disableAllHooks),
      hooks: readHooks(settings),
    });
  }
  return out;
}

export async function addGroup(
  scope: SettingsScope,
  cwd: string,
  event: HookEvent,
  group: HookGroup,
): Promise<void> {
  const settings = await readSettings(scope, cwd);
  const hooks = readHooks(settings);
  const arr = (hooks[event] ?? []).slice();
  arr.push(group);
  const next: ClaudeSettings = { ...settings, hooks: { ...hooks, [event]: arr } as Record<string, unknown> };
  await writeSettings(scope, cwd, next);
}

export async function removeGroup(
  scope: SettingsScope,
  cwd: string,
  event: HookEvent,
  index: number,
): Promise<boolean> {
  const settings = await readSettings(scope, cwd);
  const hooks = readHooks(settings);
  const arr = (hooks[event] ?? []).slice();
  if (index < 0 || index >= arr.length) return false;
  arr.splice(index, 1);
  const nextHooks = { ...hooks } as HooksMap;
  if (arr.length === 0) delete nextHooks[event];
  else nextHooks[event] = arr;
  const next: ClaudeSettings = { ...settings, hooks: nextHooks as Record<string, unknown> };
  await writeSettings(scope, cwd, next);
  return true;
}

export async function setDisableAllHooks(
  scope: SettingsScope,
  cwd: string,
  disabled: boolean,
): Promise<void> {
  const settings = await readSettings(scope, cwd);
  const next: ClaudeSettings = { ...settings, disableAllHooks: disabled };
  if (!disabled && "disableAllHooks" in next) delete next.disableAllHooks;
  await writeSettings(scope, cwd, next);
}
