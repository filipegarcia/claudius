/**
 * SDK 0.3.332 — `HOOK_EVENTS` gained `PreSkillShellCommand` (CC 2.1.332:
 * "Added a `PreSkillShellCommand` hook event that can refuse a skill or
 * command's inline shell commands as it loads").
 *
 * `/hooks` had no row for it, so a hook the CLI wrote was invisible, and the
 * Add form couldn't target it. The bundled 2.1.332 CLI refuses prompt and
 * agent handlers there ("prompt and agent hooks don't run on
 * PreSkillShellCommand", reported as a blocking error that refuses every
 * command), so the form doesn't offer them on that event and a hand-written
 * one is flagged in the list.
 *
 * `/api/hooks` is mocked (the POST is asserted and folded into the GET), so
 * nothing touches disk.
 *
 * Screenshot target: docs/sdk-updates/0.3.332/pre-skill-shell-command.png
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/sdk-updates/0.3.332");
mkdirSync(SHOTS_DIR, { recursive: true });

type Group = { matcher?: string; hooks: Array<Record<string, unknown>> };

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test("Hooks editor lists PreSkillShellCommand and only offers handlers that run there", async ({ page }) => {
  const { workspaces } = (await (await page.request.get("/api/workspaces")).json()) as {
    workspaces: { id: string; name: string }[];
  };
  const ws = workspaces.find((w) => w.name === "claudius");
  expect(ws, "seeded claudius workspace").toBeTruthy();

  // A hand-written prompt hook on the new event — the engine refuses every
  // skill shell command because of it.
  const project: Record<string, Group[]> = {
    PreSkillShellCommand: [{ matcher: "Bash", hooks: [{ type: "prompt", prompt: "Is this command safe?" }] }],
  };
  const posted: Array<{ scope: string; event: string; group: Group }> = [];
  await page.route(
    (url) => url.pathname === "/api/hooks",
    async (route) => {
      const req = route.request();
      if (req.method() === "POST") {
        const body = req.postDataJSON() as { scope: string; event: string; group: Group };
        posted.push(body);
        (project[body.event] ??= []).push(body.group);
        return route.fulfill({ json: { ok: true } });
      }
      if (req.method() === "GET") {
        return route.fulfill({
          json: {
            cwd: "/tmp/claudius",
            scopes: [
              { scope: "user", path: "~/.claude/settings.json", disableAllHooks: false, hooks: {} },
              { scope: "project", path: "/tmp/claudius/.claude/settings.json", disableAllHooks: false, hooks: project },
              { scope: "local", path: "/tmp/claudius/.claude/settings.local.json", disableAllHooks: false, hooks: {} },
            ],
          },
        });
      }
      return route.continue();
    },
  );

  await page.goto(`/${ws!.id}/hooks`);
  await expect(page.getByText("(1 configured)")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("loading…")).toHaveCount(0);

  // The event has a row under Tool lifecycle, and the existing hook shows.
  const row = page.getByRole("button", { name: /^PreSkillShellCommand\b/ });
  await expect(row).toBeVisible();
  await expect(row).toContainText("can block");
  if ((await page.getByTestId("hook-handler-disallowed").count()) === 0) await row.click();
  const flagged = page.getByTestId("hook-handler-disallowed");
  await expect(flagged).toHaveText("won't run on PreSkillShellCommand");
  await expect(flagged).toHaveAttribute("title", /won't run a prompt hook on this event/);

  // In the Add form, a prompt handler picked on another event falls back to
  // `command` when the event changes, and prompt/agent aren't offered.
  const form = page.locator("form").filter({ hasText: "Add hook to Project scope" });
  const eventSelect = form.locator("select").first();
  const typeSelect = form.locator("select").nth(1);
  await expect(async () => {
    if (!(await form.isVisible())) await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect(form).toBeVisible({ timeout: 2_000 });
    await eventSelect.selectOption("PreToolUse");
    await typeSelect.selectOption("prompt");
    await expect(typeSelect).toHaveValue("prompt", { timeout: 1_000 });
    await eventSelect.selectOption("PreSkillShellCommand");
    await expect(eventSelect).toHaveValue("PreSkillShellCommand", { timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
  await expect(typeSelect).toHaveValue("command");
  await expect(typeSelect.locator("option")).toHaveText(["command", "http", "mcp_tool"]);
  await expect(form.getByTestId("hook-handler-types-hint")).toHaveText(
    "prompt and agent handlers can't run on PreSkillShellCommand — use command or http.",
  );
  await expect(form.getByPlaceholder("Bash | PowerShell")).toBeVisible();

  await form.getByPlaceholder("Bash | PowerShell").fill("Bash");
  await form.getByPlaceholder("/path/to/script.sh").fill("./scripts/skill-guard.sh");
  await page.waitForTimeout(200);
  await page.screenshot({ path: resolve(SHOTS_DIR, "pre-skill-shell-command.png"), fullPage: false });

  await form.getByRole("button", { name: "Save" }).click();
  await expect(form).toHaveCount(0);
  expect(posted).toHaveLength(1);
  expect(posted[0].event).toBe("PreSkillShellCommand");
  expect(posted[0].group).toEqual({
    matcher: "Bash",
    hooks: [{ type: "command", command: "./scripts/skill-guard.sh" }],
  });
  await expect(page.getByText("(2 configured)")).toBeVisible();

  // Other events still offer every handler type.
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(form).toBeVisible();
  await eventSelect.selectOption("PreToolUse");
  await expect(typeSelect.locator("option")).toHaveText(["command", "http", "prompt", "agent", "mcp_tool"]);
  await expect(form.getByTestId("hook-handler-types-hint")).toHaveCount(0);
});
