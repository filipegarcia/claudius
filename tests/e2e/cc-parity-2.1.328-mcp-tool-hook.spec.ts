/**
 * CC 2.1.328 — "Added `"onFailure": "block"` for `mcp_tool` hooks, as for
 * command and HTTP hooks: a hook whose call fails blocks the action".
 *
 * The /hooks editor saved mcp_tool hooks as `{tool: "mcp__srv__tool",
 * arguments}`; the engine's schema is `{server, tool, input?}` with `server`
 * required, so none of them ever loaded. The form now has separate Server and
 * Tool fields, saves `input`, and offers the onFailure toggle (with the
 * engine's wider ignored-events set: Setup and SessionStart as well). Old
 * entries are flagged in the list.
 *
 * `/api/hooks` is mocked (POSTs are asserted and folded into the GET), so
 * nothing touches disk.
 *
 * Screenshot target: docs/cc-parity/2.1.328/hook-mcp-tool-onfailure.png
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.328");
mkdirSync(SHOTS_DIR, { recursive: true });

type Group = { matcher?: string; hooks: Array<Record<string, unknown>> };

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test("mcp_tool hooks save {server, tool, input} and can block on failure", async ({ page }) => {
  const { workspaces } = (await (await page.request.get("/api/workspaces")).json()) as {
    workspaces: { id: string; name: string }[];
  };
  const ws = workspaces.find((w) => w.name === "claudius");
  expect(ws, "seeded claudius workspace").toBeTruthy();

  // A hook an earlier Claudius build saved in the old shape.
  const project: Record<string, Group[]> = {
    PreToolUse: [
      { matcher: "Bash", hooks: [{ type: "mcp_tool", tool: "mcp__slack__notify", arguments: { channel: "alerts" } }] },
    ],
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

  const preToolUse = page.getByRole("button", { name: /^PreToolUse\b/ });
  if ((await page.getByTestId("hook-mcp-tool-legacy").count()) === 0) await preToolUse.click();
  const legacy = page.getByTestId("hook-mcp-tool-legacy");
  await expect(legacy).toHaveText("won't run — no server");

  // Add a fail-closed mcp_tool hook. A first-visit dev-server remount can
  // wipe the form mid-fill, so (re)open and fill until it sticks.
  const form = page.locator("form").filter({ hasText: "Add hook to Project scope" });
  const toggle = form.getByTestId("hook-onfailure-block-toggle");
  await expect(async () => {
    if (!(await form.isVisible())) await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect(form).toBeVisible({ timeout: 2_000 });
    await form.locator("select").first().selectOption("PreToolUse");
    await form.locator("select").nth(1).selectOption("mcp_tool");
    await form.getByPlaceholder("tool name (e.g. Bash, Read) or regex").fill("Bash");
    await form.getByTestId("hook-mcp-server-input").fill("guard");
    await form.getByTestId("hook-mcp-tool-input").fill("check_command");
    await form.getByTestId("hook-mcp-input").fill('{"command":"${tool_input.command}"}');
    await toggle.check();
    await expect(form.getByTestId("hook-mcp-server-input")).toHaveValue("guard", { timeout: 1_000 });
    await expect(form.getByTestId("hook-mcp-tool-input")).toHaveValue("check_command", { timeout: 1_000 });
    await expect(toggle).toBeChecked({ timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
  // The command/http-only async toggles aren't offered for mcp_tool.
  await expect(form.locator("label").filter({ hasText: /^async$/ })).toHaveCount(0);
  await expect(form.locator("label").filter({ hasText: /^asyncRewake$/ })).toHaveCount(0);
  await expect(form.getByTestId("hook-mcp-onfailure-note")).toContainText("must answer with a hook's JSON output");

  await page.screenshot({ path: resolve(SHOTS_DIR, "hook-mcp-tool-onfailure.png"), fullPage: false });

  await form.getByRole("button", { name: "Save" }).click();
  await expect(form).toHaveCount(0);
  expect(posted).toHaveLength(1);
  expect(posted[0].event).toBe("PreToolUse");
  expect(posted[0].group).toEqual({
    matcher: "Bash",
    hooks: [
      {
        type: "mcp_tool",
        server: "guard",
        tool: "check_command",
        input: { command: "${tool_input.command}" },
        onFailure: "block",
      },
    ],
  });

  await expect(page.getByText("(2 configured)")).toBeVisible();
  if ((await page.getByTestId("hook-onfailure-badge").count()) === 0) await preToolUse.click();
  await expect(page.getByTestId("hook-onfailure-badge")).toHaveText("onFailure=block");
  await expect(page.getByText("guard · check_command")).toBeVisible();
  // Only the old entry is flagged.
  await expect(page.getByTestId("hook-mcp-tool-legacy")).toHaveCount(1);

  // A pasted mcp__server__tool name in the Tool field is caught.
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(form).toBeVisible();
  await form.locator("select").nth(1).selectOption("mcp_tool");
  await form.getByTestId("hook-mcp-server-input").fill("slack");
  await form.getByTestId("hook-mcp-tool-input").fill("mcp__slack__notify");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form).toContainText("not mcp__server__tool");
  expect(posted).toHaveLength(1);

  // The engine ignores an mcp_tool block on SessionStart (unlike command/http).
  await form.locator("select").first().selectOption("SessionStart");
  await form.getByTestId("hook-mcp-tool-input").fill("notify");
  await form.getByTestId("hook-onfailure-block-toggle").check();
  await expect(form.getByTestId("hook-onfailure-event-hint")).toContainText("ignores onFailure: block on SessionStart");
  await form.locator("select").nth(1).selectOption("command");
  await expect(form.getByTestId("hook-onfailure-event-hint")).toHaveCount(0);
});
