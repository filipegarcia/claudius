/**
 * CC 2.1.327 — "Added a list in /status of broken agent, skill, command and
 * output style files, keybinding errors, …".
 *
 * Claudius parses agent/skill frontmatter itself and used to drop malformed
 * YAML silently — the agent listed as a normal row with no description. Now
 * `/status` gets a Problems row (count from `GET /api/doctor/files`, scoped
 * to the chat's workspace) linking to /doctor's new Config files section,
 * which names each broken file and the YAML error.
 *
 * Both endpoints are mocked here; the real handlers (temp HOME with broken
 * files) are covered by tests/unit/cc-parity-2.1.327-status-problems.test.ts.
 *
 * Screenshot targets: docs/cc-parity/2.1.327/status-problems.png,
 * docs/cc-parity/2.1.327/doctor-broken-files.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.327");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "cccccccc-1111-2222-3333-0000003327st";

type SdkEvent = Record<string, unknown>;

function sseBody(events: SdkEvent[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

const PRELUDE: SdkEvent[] = [
  { type: "ready", sessionId: FAKE_SESSION_ID },
  {
    type: "sdk",
    message: { type: "system", subtype: "init", uuid: "sys-init-0", model: "claude-sonnet-4-6" },
  },
  { type: "replay_done", hasMoreAbove: false },
];

async function mockChatBackend(page: Page): Promise<void> {
  await page.route("**/api/sessions", async (route: Route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ id: FAKE_SESSION_ID }),
    });
  });
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/stream*`, async (route: Route) => {
    return route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
      body: sseBody(PRELUDE),
    });
  });
  await page.route("**/api/sessions/open-tabs", async (route: Route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ activeId: null, tabs: [] }),
    });
  });
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/pending-prompts`, async (route: Route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ asks: [], permissions: [] }),
    });
  });
  await page.route("**/api/limits*", async (route: Route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ limits: { sessionUsd: 0, projectDailyUsd: 0 } }),
    });
  });
}

type Problem = { kind: string; scope: string; name: string; path: string; reason: string };

const PROBLEMS: Problem[] = [
  {
    kind: "agent",
    scope: "user",
    name: "reviewer",
    path: "/Users/me/.claude/agents/reviewer.md",
    reason: "Nested mappings are not allowed in compact mappings (line 3)",
  },
  {
    kind: "keybindings",
    scope: "user",
    name: "keybindings.json",
    path: "/Users/me/.claude/keybindings.json",
    reason: "Expected double-quoted property name in JSON at position 14 (line 2 column 3)",
  },
];

function doctorReport() {
  return {
    runtime: { node: "22.0.0", platform: "darwin", arch: "arm64" },
    sdk: { version: "0.3.327" },
    checks: [
      { id: "node", label: "Node.js", status: "ok", detail: "v22.0.0" },
      { id: "auth", label: "Auth", status: "ok", detail: "ANTHROPIC_API_KEY set" },
      { id: "git", label: "git", status: "ok", detail: "git version 2.43.0" },
      {
        id: "config-file:agent:user:reviewer",
        label: "Broken agent — reviewer (user)",
        status: "warn",
        detail: `${PROBLEMS[0].path} — ${PROBLEMS[0].reason}`,
        link: { href: "/agents", label: "Open Agents" },
        category: "config-files",
      },
      {
        id: "config-file:keybindings:user:keybindings.json",
        label: "Broken keybindings.json",
        status: "warn",
        detail: `${PROBLEMS[1].path} — ${PROBLEMS[1].reason}`,
        link: { href: "/keybindings", label: "Open Keybindings" },
        category: "config-files",
      },
    ],
  };
}

async function openStatus(page: Page): Promise<void> {
  await page.goto("/");
  const composer = page.getByTestId("prompt-input");
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.fill("/status");
  await page.getByTestId("prompt-send").click();
  await expect(page.getByText("Session status")).toBeVisible({ timeout: 5_000 });
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test.describe("/status lists broken config files (CC 2.1.327 parity)", () => {
  test("shows a Problems count that opens the Config files section of /doctor", async ({ page }) => {
    await mockChatBackend(page);
    const filesUrls: string[] = [];
    await page.route("**/api/doctor/files*", async (route: Route) => {
      filesUrls.push(route.request().url());
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ problems: PROBLEMS, checks: [] }),
      });
    });
    await page.route("**/api/doctor", async (route: Route) => {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(doctorReport()) });
    });

    await openStatus(page);
    const problems = page.getByTestId("status-problems");
    await expect(problems).toBeVisible({ timeout: 5_000 });
    await expect(problems).toContainText("2 problems");
    await expect(page.getByTestId("status-problems-link")).toHaveText("Open /doctor");
    // Scoped to the chat's workspace.
    expect(filesUrls.some((u) => new URL(u).searchParams.get("workspaceId"))).toBe(true);

    await page.waitForTimeout(150);
    await page.screenshot({ path: resolve(SHOTS_DIR, "status-problems.png"), fullPage: false });

    await page.getByTestId("status-problems-link").click();
    await expect(page).toHaveURL(/\/doctor\?section=config-files$/);

    const section = page.getByTestId("doctor-config-files-section");
    await expect(section).toBeVisible({ timeout: 15_000 });
    await expect(section.getByText("Config files")).toBeVisible();
    const agentRow = section.locator("li", { hasText: "Broken agent — reviewer (user)" });
    await expect(agentRow).toBeVisible();
    await expect(agentRow).toContainText("/Users/me/.claude/agents/reviewer.md");
    await expect(agentRow).toContainText("(line 3)");
    await expect(page.getByTestId("doctor-link-config-file:agent:user:reviewer")).toHaveText("Open Agents");
    await expect(section.locator("li", { hasText: "Broken keybindings.json" })).toBeVisible();
    // Not duplicated in the general Checks list.
    await expect(page.locator("li", { hasText: "Broken agent — reviewer" })).toHaveCount(1);

    await page.waitForTimeout(200);
    await page.screenshot({ path: resolve(SHOTS_DIR, "doctor-broken-files.png"), fullPage: false });
  });

  test("says No problems when every file is fine", async ({ page }) => {
    await mockChatBackend(page);
    await page.route("**/api/doctor/files*", async (route: Route) => {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ problems: [], checks: [] }),
      });
    });

    await openStatus(page);
    const problems = page.getByTestId("status-problems");
    await expect(problems).toHaveText("No problems", { timeout: 5_000 });
    await expect(page.getByTestId("status-problems-link")).toHaveCount(0);
  });
});
