/**
 * CC 2.1.280 parity — "[VSCode] Added each skill's source, token estimate
 * and on/off state to the Slash commands dialog, with a click to change the
 * state, and a typed `/skills` that opens it."
 *
 * Claudius already has a `/skills` overlay (`components/overlays/
 * SkillsOverlay.tsx`), opened the same way, but it only ever showed bare
 * skill names. This release enriches each row with:
 *   - source + token estimate, reused from the same `/api/sessions/[id]/
 *     context` endpoint the `/skill-doctor` `ContextOverlay` already uses
 *     (no new server-side computation for that half).
 *   - a click-to-toggle on/off state, backed by the SDK's
 *     `Settings.skillOverrides` passthrough key
 *     (`lib/server/settings.ts`'s `updateSkillOverride`, project-scoped).
 *
 * We can't drive a real SDK session, so the session/stream/context layer is
 * fixtured via SSE mocking (mirrors `cc-parity-2.1.251-cost-overlay-cache-
 * spend.spec.ts`). The settings toggle, however, is exercised for real
 * against a disposable temp-dir workspace — `/api/settings/skill-overrides`
 * is a plain settings-file CRUD with no SDK dependency, so mocking it would
 * only prove the UI trusts its own fetch, not that the round trip works.
 *
 * Screenshot target: docs/cc-parity/2.1.280/skills-overlay-toggle.png
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.280");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "eeeeeeee-1111-2222-3333-444444444280";

type SdkEvent = Record<string, unknown>;

function sseBody(events: SdkEvent[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

async function mockChatBackend(page: Page, cwd: string): Promise<void> {
  await page.route("**/api/sessions", async (route: Route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ id: FAKE_SESSION_ID, cwd }),
    });
  });

  const events: SdkEvent[] = [
    { type: "ready", sessionId: FAKE_SESSION_ID },
    {
      type: "sdk",
      message: {
        type: "system",
        subtype: "init",
        uuid: "sys-init-0",
        model: "claude-sonnet-4-6",
        cwd,
        skills: ["pdf-fill", "code-review"],
      },
    },
    { type: "replay_done", hasMoreAbove: false },
  ];
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/stream*`, async (route: Route) => {
    return route.fulfill({
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
      body: sseBody(events),
    });
  });

  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/context*`, async (route: Route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        totalTokens: 5000,
        maxTokens: 200000,
        percentage: 2,
        skills: {
          includedSkills: 2,
          totalSkills: 2,
          tokens: 1540,
          skillFrontmatter: [
            { name: "pdf-fill", source: "project", tokens: 1200 },
            { name: "code-review", source: "user", tokens: 340 },
          ],
        },
      }),
    });
  });

  await page.route("**/api/sessions/open-tabs", async (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ activeId: null, tabs: [] }),
    }),
  );
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/pending-prompts`, async (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ asks: [], permissions: [] }),
    }),
  );
}

test.describe("SkillsOverlay — per-skill source, token estimate, on/off toggle (CC 2.1.280 parity)", () => {
  test("shows source + token estimate per skill, and the toggle round-trips through real settings", async ({
    page,
    baseURL,
  }) => {
    test.setTimeout(60_000);

    const dir = mkdtempSync(join(tmpdir(), "claudius-skills-toggle-"));

    try {
      const created = await page.request.post(`${baseURL}/api/workspaces`, {
        data: { name: `skills-toggle-${Date.now()}`, rootPath: dir },
      });
      expect(created.ok(), "creating the throwaway workspace").toBeTruthy();
      const ws = (await created.json()) as { id: string };
      await page.request.post(`${baseURL}/api/workspaces/${ws.id}/select`);

      await mockChatBackend(page, dir);
      await page.goto("/");

      const composer = page.getByTestId("prompt-input");
      await expect(composer).toBeVisible({ timeout: 30_000 });
      await expect(composer).toBeEnabled({ timeout: 30_000 });
      await page.waitForTimeout(500);
      // Enter would be intercepted by the slash-autocomplete menu instead of
      // submitting — same reasoning as the cost-overlay spec's second case.
      await composer.fill("/skills");
      await page.getByTestId("prompt-send").click();

      await expect(page.getByText("Skills, agents & commands")).toBeVisible({ timeout: 10_000 });

      const rows = page.getByTestId("skills-overlay-skill-row");
      await expect(rows).toHaveCount(2, { timeout: 10_000 });

      // Source + token estimate render per row, reused from the /context data.
      await expect(rows.filter({ hasText: "pdf-fill" })).toContainText("project");
      await expect(rows.filter({ hasText: "pdf-fill" })).toContainText("1.2k");
      await expect(rows.filter({ hasText: "code-review" })).toContainText("user");
      await expect(rows.filter({ hasText: "code-review" })).toContainText("340");

      // Both start "on" (no override written yet).
      const pdfToggle = page.locator('[data-testid="skills-overlay-toggle"][data-skill="pdf-fill"]');
      await expect(pdfToggle).toHaveAttribute("data-state", "on");

      // Toggle pdf-fill off — real POST to /api/settings/skill-overrides,
      // written into the temp workspace's own .claude/settings.json.
      await pdfToggle.click();
      await expect(pdfToggle).toHaveAttribute("data-state", "off", { timeout: 10_000 });
      await expect(rows.filter({ hasText: "pdf-fill" }).locator("span.line-through")).toBeVisible();

      const settingsPath = join(dir, ".claude", "settings.json");
      await expect
        .poll(() => {
          try {
            return JSON.parse(readFileSync(settingsPath, "utf8"));
          } catch {
            return null;
          }
        }, { timeout: 10_000 })
        .toEqual({ skillOverrides: { "pdf-fill": "off" } });

      await page.waitForTimeout(200);
      await page.screenshot({
        path: resolve(SHOTS_DIR, "skills-overlay-toggle.png"),
        fullPage: false,
      });

      // Toggle it back on — the settings key is removed entirely (not set to
      // "on"), matching updateSkillOverride's "absent = on" contract.
      await pdfToggle.click();
      await expect(pdfToggle).toHaveAttribute("data-state", "on", { timeout: 10_000 });
      await expect
        .poll(() => {
          try {
            return JSON.parse(readFileSync(settingsPath, "utf8"));
          } catch {
            return null;
          }
        }, { timeout: 10_000 })
        .toEqual({});
    } finally {
      const list = await page.request
        .get(`${baseURL}/api/workspaces`)
        .then((r) => r.json() as Promise<{ workspaces: { id: string; rootPath: string }[] }>)
        .catch(() => ({ workspaces: [] }));
      const ws = list.workspaces.find((w) => w.rootPath === dir);
      if (ws) await page.request.delete(`${baseURL}/api/workspaces/${ws.id}`).catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
