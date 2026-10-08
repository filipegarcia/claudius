/**
 * Claude Code 2.1.295 parity — "Added onFailure: \"block\" for command and HTTP
 * hooks: a hook that can't start, times out, or exits with an unexpected code
 * blocks the action instead of letting it through".
 *
 * Claudius's Hooks editor gains a "block on failure" toggle for command/http
 * handlers (saved as `onFailure: "block"`; absent when unchecked), an amber
 * hint when it's combined with `async` (a background hook can't block), and an
 * "onFailure: block" badge in the handler list.
 *
 * The form writes to Project scope by default, and the e2e "claudius"
 * workspace may point at this repo — so `/api/hooks` is mocked: the POST
 * payload is asserted and folded into the GET fixture. Nothing touches disk.
 *
 * Screenshot target: docs/cc-parity/2.1.295/hook-onfailure-block.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.295");
mkdirSync(SHOTS_DIR, { recursive: true });

type Group = { matcher?: string; hooks: Array<Record<string, unknown>> };

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test("Hooks editor saves onFailure: \"block\" and badges the handler", async ({ page }) => {
  const { workspaces } = (await (await page.request.get("/api/workspaces")).json()) as {
    workspaces: { id: string; name: string }[];
  };
  const ws = workspaces.find((w) => w.name === "claudius");
  expect(ws, "seeded claudius workspace").toBeTruthy();

  // Mutable fixture: POSTs land here and the follow-up GET serves them back.
  const project: Record<string, Group[]> = {};
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
  await expect(page.getByText("(0 configured)")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("loading…")).toHaveCount(0);
  // Let a first-visit dev-server remount settle before typing into the form.
  await page.waitForTimeout(1_500);

  // ── Add a fail-closed command hook on PreToolUse ──
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const form = page.locator("form").filter({ hasText: "Add hook to Project scope" });
  await expect(form).toBeVisible();
  await form.locator("select").first().selectOption("PreToolUse");
  await form.getByPlaceholder("/path/to/script.sh").fill("./scripts/guard.sh");
  const toggle = page.getByTestId("hook-onfailure-block-toggle");
  await toggle.check();
  await expect(toggle).toBeChecked();
  await expect(page.getByTestId("hook-onfailure-async-hint")).toHaveCount(0);
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form).toHaveCount(0);

  expect(posted).toHaveLength(1);
  expect(posted[0].scope).toBe("project");
  expect(posted[0].event).toBe("PreToolUse");
  expect(posted[0].group.hooks[0]).toEqual({
    type: "command",
    command: "./scripts/guard.sh",
    onFailure: "block",
  });

  // The row mounted while empty, so it doesn't auto-expand — open it.
  await expect(page.getByText("(1 configured)")).toBeVisible();
  await page.getByRole("button", { name: /^PreToolUse\b/ }).click();
  const badge = page.getByTestId("hook-onfailure-badge");
  await expect(badge).toHaveCount(1);
  await expect(badge).toHaveText("onFailure: block");

  // ── Re-open the form: block + async shows the "can't block" hint ──
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(form).toBeVisible();
  await form.locator("select").first().selectOption("PreToolUse");
  await form.getByPlaceholder("/path/to/script.sh").fill("./scripts/audit.sh");
  await page.getByTestId("hook-onfailure-block-toggle").check();
  await form.locator("label").filter({ hasText: /^async$/ }).locator("input").check();
  const hint = page.getByTestId("hook-onfailure-async-hint");
  await expect(hint).toBeVisible();
  await expect(hint).toContainText("can't block the action");

  await page.screenshot({ path: resolve(SHOTS_DIR, "hook-onfailure-block.png"), fullPage: false });

  // An unchecked toggle saves no `onFailure` key at all.
  await page.getByTestId("hook-onfailure-block-toggle").uncheck();
  await expect(hint).toHaveCount(0);
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form).toHaveCount(0);
  expect(posted).toHaveLength(2);
  expect(posted[1].group.hooks[0]).toEqual({ type: "command", command: "./scripts/audit.sh", async: true });
});
