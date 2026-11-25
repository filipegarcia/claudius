import { mkdtempSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { DELETE } from "@/app/api/mcp/[name]/route";
import { mcpRemoveHint } from "@/lib/client/useMcp";
import { createWorkspace } from "@/lib/server/workspaces-store";
import { makeTempHome, type TmpHome } from "./helpers/tmp-home";

/**
 * CC 2.1.330 — "Fixed `claude mcp remove` giving no way forward for a
 * claude.ai connector: it now says to turn it off in /mcp or remove it on
 * claude.ai". On /mcp every row had a Remove button; for a claude.ai
 * connector, a plugin's server or any other server outside a file Claudius
 * edits, it asked "Remove … from undefined?" and then silently did nothing.
 */

describe("mcpRemoveHint", () => {
  test("a claude.ai connector points at claude.ai's connector settings", () => {
    const hint = mcpRemoveHint("claude.ai Linear", "claudeai");
    expect(hint.label).toBe("Remove on claude.ai");
    expect(hint.href).toBe("https://claude.ai/customize/connectors");
    expect(hint.title).toContain("Claude Code can't remove");
    expect(hint.title).toContain("Disable it");
  });

  test("a plugin's server points at Plugins and names the plugin", () => {
    const hint = mcpRemoveHint("plugin:github-tools:github", "dynamic");
    expect(hint.label).toBe("Manage in Plugins");
    expect(hint.href).toBe("/plugins");
    expect(hint.title).toContain("github-tools");
  });

  test("a file-scope server Claudius doesn't read gives the CLI command", () => {
    const hint = mcpRemoveHint("notes", "user");
    expect(hint.href).toBeUndefined();
    expect(hint.title).toContain('claude mcp remove "notes" -s user');
  });

  test("sdk / managed servers say where they come from", () => {
    expect(mcpRemoveHint("inproc", "sdk").title).toBe("Comes from SDK configuration, not a file Claudius edits.");
    expect(mcpRemoveHint("corp", "managed").title).toBe("Comes from Managed configuration, not a file Claudius edits.");
  });
});

describe("DELETE /api/mcp/[name] says why nothing was removed", () => {
  let home: TmpHome;
  let root: string;

  beforeEach(async () => {
    home = makeTempHome();
    root = mkdtempSync(join(home.home, "proj-"));
    await createWorkspace({ name: "Proj", rootPath: root });
  });
  afterEach(() => home.restore());

  test("a server that isn't in the file is a 404 with a readable reason", async () => {
    const res = await DELETE(
      new Request(`http://localhost/api/mcp/ghost?scope=local&cwd=${encodeURIComponent(root)}`, { method: "DELETE" }),
      { params: Promise.resolve({ name: "ghost" }) },
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe(
      "\"ghost\" isn't in the local config any more. Refresh to see the current list.",
    );
  });
});
