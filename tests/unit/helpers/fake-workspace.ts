import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { workspacesFile } from "@/lib/server/workspaces-store";
import type { Workspace } from "@/lib/server/workspaces-store";
import {
  ALL_NOTIFICATION_KINDS,
  type WorkspaceNotificationPrefs,
} from "@/lib/shared/notifications";

/**
 * Writes a synthetic `workspaces.json` under the current HOME (set by
 * `makeTempHome`). Returns the Workspace object the rest of the test can
 * pass to `notificationBus` calls.
 *
 * The bus's `lookupWorkspace` filters by `rootPath` exact-match, so every
 * test gets its own `rootPath` to avoid two parallel files colliding on the
 * same fake cwd.
 *
 * Notifications default to ALL kinds enabled (including the opt-in
 * `session_error`) so test cases can exercise every event type without
 * having to thread an explicit `enabledKinds` through every fixture call.
 * Tests that want to assert the default-policy behavior pass an explicit
 * `notifications` prop.
 */
export function writeFakeWorkspace(input: {
  rootPath?: string;
  notifications?: WorkspaceNotificationPrefs;
} = {}): Workspace {
  // Refuse to write outside tmpdir so a missing `makeTempHome()` can't clobber the real workspaces.json.
  const target = resolve(workspacesFile());
  const tmpRoot = resolve(tmpdir());
  if (!target.startsWith(tmpRoot + "/")) {
    throw new Error(
      `writeFakeWorkspace refuses to write outside tmpdir (target=${target}, tmpdir=${tmpRoot}). ` +
        `Call makeTempHome() in beforeEach before invoking this helper.`,
    );
  }
  const id = "wks_" + randomUUID().replace(/-/g, "").slice(0, 12);
  const rootPath = input.rootPath ?? `/tmp/fake-${id}`;
  const notifications: WorkspaceNotificationPrefs = input.notifications ?? {
    enabledKinds: ALL_NOTIFICATION_KINDS,
  };
  const ws: Workspace = {
    id,
    name: "fixture",
    rootPath,
    icon: { kind: "letter", letter: "F", color: "#000000" },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    defaults: { notifications },
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
