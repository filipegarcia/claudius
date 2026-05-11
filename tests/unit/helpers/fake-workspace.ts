import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

import { workspacesFile } from "@/lib/server/workspaces-store";
import type { Workspace } from "@/lib/server/workspaces-store";
import type { WorkspaceNotificationPrefs } from "@/lib/shared/notifications";

/**
 * Writes a synthetic `workspaces.json` under the current HOME (set by
 * `makeTempHome`). Returns the Workspace object the rest of the test can
 * pass to `notificationBus` calls.
 *
 * The bus's `lookupWorkspace` filters by `rootPath` exact-match, so every
 * test gets its own `rootPath` to avoid two parallel files colliding on the
 * same fake cwd.
 */
export function writeFakeWorkspace(input: {
  rootPath?: string;
  notifications?: WorkspaceNotificationPrefs;
} = {}): Workspace {
  const id = "wks_" + randomUUID().replace(/-/g, "").slice(0, 12);
  const rootPath = input.rootPath ?? `/tmp/fake-${id}`;
  const ws: Workspace = {
    id,
    name: "fixture",
    rootPath,
    icon: { kind: "letter", letter: "F", color: "#000000" },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...(input.notifications
      ? { defaults: { notifications: input.notifications } }
      : {}),
  };
  const file = workspacesFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({ version: 1, activeId: id, workspaces: [ws] }, null, 2),
    "utf8",
  );
  return ws;
}
