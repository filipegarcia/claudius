/**
 * CC 2.1.300 parity — "Fixed agent hooks ignoring their model: aliases like
 * haiku now resolve, a subagent's model no longer overrides it, and an
 * unavailable model falls back to the caller's instead of allowing the
 * action".
 *
 * The engine fix makes an agent hook's `model` matter. Claudius's Hooks editor
 * (`app/[workspaceId]/hooks/page.tsx`) couldn't set one, and it wrote agent
 * hooks as `{type:"agent", agent:"<name>"}`. The engine's schema is
 * `{type:"agent", prompt, model?}` (a verifier prompt run on a model, Haiku by
 * default). Checked against the bundled 2.1.300 engine: it skips the old
 * shape at load ("Invalid agent hook (prompt: … received undefined); entry
 * ignored"), so no agent hook saved from Claudius ever ran.
 *
 * Now the form asks for what to verify plus an optional Model (alias or id),
 * on agent and prompt hooks alike, and saves the engine shape. Entries saved
 * in the old shape get an amber "won't run — no prompt" badge so the user can
 * re-create them.
 *
 * `/api/hooks` is mocked (the e2e workspace may point at this repo): the POST
 * payload is asserted and folded into the GET fixture.
 *
 * Screenshot targets: docs/cc-parity/2.1.300/agent-hook-model.png (the form)
 * and docs/cc-parity/2.1.300/agent-hook-legacy.png (the Stop row: the new
 * hook's model badge and the old-shape entry's badge).
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.300");
mkdirSync(SHOTS_DIR, { recursive: true });

type Group = { matcher?: string; hooks: Array<Record<string, unknown>> };

const VERIFY = "Verify that the unit tests ran and passed before stopping. $ARGUMENTS";

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test("Hooks editor saves agent hooks as {prompt, model} and flags the old shape", async ({ page }) => {
  const { workspaces } = (await (await page.request.get("/api/workspaces")).json()) as {
    workspaces: { id: string; name: string }[];
  };
  const ws = workspaces.find((w) => w.name === "claudius");
  expect(ws, "seeded claudius workspace").toBeTruthy();

  // A hook an earlier Claudius build saved in the old shape.
  const project: Record<string, Group[]> = {
    Stop: [{ hooks: [{ type: "agent", agent: "test-verifier" }] }],
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

  // The old-shape entry is flagged as never running.
  const stopRow = page.getByRole("button", { name: /^Stop\b/ });
  if ((await page.getByTestId("hook-agent-legacy").count()) === 0) await stopRow.click();
  const legacy = page.getByTestId("hook-agent-legacy");
  await expect(legacy).toHaveCount(1);
  await expect(legacy).toHaveText("won't run — no prompt");

  // Add an agent hook on Stop with a model alias. A first-visit dev-server
  // remount can wipe the form mid-fill, so (re)open and fill until it sticks.
  const form = page.locator("form").filter({ hasText: "Add hook to Project scope" });
  await expect(async () => {
    if (!(await form.isVisible())) await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect(form).toBeVisible({ timeout: 2_000 });
    await form.locator("select").first().selectOption("Stop");
    await form.locator("select").nth(1).selectOption("agent");
    await form.getByTestId("hook-prompt-input").fill(VERIFY);
    await form.getByTestId("hook-model-input").fill("haiku");
    await form.getByTestId("hook-timeout-input").fill("120");
    await expect(form.getByTestId("hook-prompt-input")).toHaveValue(VERIFY, { timeout: 1_000 });
    await expect(form.getByTestId("hook-timeout-input")).toHaveValue("120", { timeout: 1_000 });
    await expect(form.getByTestId("hook-model-input")).toHaveValue("haiku", { timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
  // The old "Agent name" field is gone; the prompt is labelled for an agent.
  await expect(form.getByText("Agent name")).toHaveCount(0);
  await expect(form.getByText("What to verify")).toBeVisible();

  await page.screenshot({ path: resolve(SHOTS_DIR, "agent-hook-model.png"), fullPage: false });

  await form.getByRole("button", { name: "Save" }).click();
  await expect(form).toHaveCount(0);

  // The engine's shape: prompt + model, and no `agent` key.
  expect(posted).toHaveLength(1);
  expect(posted[0].event).toBe("Stop");
  expect(posted[0].group.hooks[0]).toEqual({ type: "agent", prompt: VERIFY, model: "haiku", timeout: 120 });
  expect(posted[0].group.hooks[0]).not.toHaveProperty("agent");

  await expect(page.getByText("(2 configured)")).toBeVisible();
  if ((await page.getByTestId("hook-model-badge").count()) === 0) await stopRow.click();
  await expect(page.getByTestId("hook-model-badge")).toHaveText("model=haiku");
  // Only the old entry is flagged.
  await expect(page.getByTestId("hook-agent-legacy")).toHaveCount(1);
  await page.getByTestId("hook-model-badge").scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await page.screenshot({ path: resolve(SHOTS_DIR, "agent-hook-legacy.png"), fullPage: false });

  // A prompt hook can carry a model too; leaving it empty saves no key.
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(form).toBeVisible();
  await form.locator("select").first().selectOption("Stop");
  await form.locator("select").nth(1).selectOption("prompt");
  await form.getByTestId("hook-prompt-input").fill("Summarise what changed.");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form).toHaveCount(0);
  expect(posted).toHaveLength(2);
  expect(posted[1].group.hooks[0]).toEqual({ type: "prompt", prompt: "Summarise what changed." });
});
