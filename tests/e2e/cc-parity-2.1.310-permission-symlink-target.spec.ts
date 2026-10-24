import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";

/**
 * Claude Code 2.1.310 — "Fixed file read permission prompts not showing where
 * a symbolic link leads."
 *
 * Claudius resolves the link server-side (`lib/server/permission-symlink.ts`)
 * and attaches `symlink` to the `permission_request` event; the modal
 * (`PermissionPrompt.tsx`) shows a warning row using Claude Code's wording:
 * "This will read X (outside working directory) via a symlink" or
 * "Symlink target: X". The server-side resolution is covered by
 * tests/unit/permission-symlink.test.ts; this spec drives the UI with a
 * synthetic SSE event (same strategy as the 2.1.247 auto-mode-tip spec).
 *
 * Screenshot target: docs/cc-parity/2.1.310/permission-symlink-target.png
 */

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.310");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "00000000-1111-2222-3333-agent0002310";

type SdkEvent = Record<string, unknown>;

function sseBody(events: SdkEvent[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

const PRELUDE: SdkEvent[] = [
  { type: "ready", sessionId: FAKE_SESSION_ID },
  {
    type: "sdk",
    message: {
      type: "system",
      subtype: "init",
      uuid: "sys-2310",
      model: "claude-sonnet-4-6",
    },
  },
  { type: "replay_done", hasMoreAbove: false },
];

function readPermission(id: string, filePath: string, symlink?: SdkEvent): SdkEvent {
  return {
    type: "permission_request",
    requestId: `req-2310-${id}`,
    toolName: "Read",
    toolUseId: `toolu_read_2310_${id}`,
    input: { file_path: filePath },
    title: `Claude wants to read ${filePath}`,
    displayName: "Read",
    ...(symlink ? { symlink } : {}),
  };
}

async function mockChatBackend(page: Page, events: SdkEvent[]): Promise<void> {
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
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
      body: sseBody(events),
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
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/permission`, async (route: Route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });
}

test.describe("Claude Code 2.1.310 — symlink target on file permission prompts", () => {
  test("a Read through a link leading outside the project names the real file", async ({ page }) => {
    await mockChatBackend(page, [
      ...PRELUDE,
      readPermission("outside", "/Users/dev/project/notes.txt", {
        target: "/Users/dev/.ssh/id_ed25519",
        outsideWorkingDirs: true,
        operation: "read",
      }),
    ]);
    await page.goto("/");

    const modal = page.locator("[data-permission-modal]");
    await expect(modal).toBeVisible({ timeout: 15_000 });
    await expect(modal).toContainText("notes.txt");

    const row = page.getByTestId("permission-symlink-target");
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute("data-outside-working-dirs", "true");
    await expect(row).toHaveText(
      "This will read /Users/dev/.ssh/id_ed25519 (outside working directory) via a symlink",
    );

    await page.waitForTimeout(200);
    await page.screenshot({
      path: resolve(SHOTS_DIR, "permission-symlink-target.png"),
      fullPage: false,
    });

    // The row is display-only: the prompt still resolves normally.
    await page.getByRole("button", { name: "Allow once" }).click();
    await expect(modal).not.toBeVisible({ timeout: 5_000 });
  });

  test("a link inside the project shows the plain target line", async ({ page }) => {
    await mockChatBackend(page, [
      ...PRELUDE,
      readPermission("inside", "/Users/dev/project/current.log", {
        target: "/Users/dev/project/logs/2026-10-24.log",
        outsideWorkingDirs: false,
        operation: "read",
      }),
    ]);
    await page.goto("/");

    const row = page.getByTestId("permission-symlink-target");
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).not.toHaveAttribute("data-outside-working-dirs", "true");
    await expect(row).toHaveText("Symlink target: /Users/dev/project/logs/2026-10-24.log");
  });

  test("a regular file shows no symlink row", async ({ page }) => {
    await mockChatBackend(page, [...PRELUDE, readPermission("plain", "/Users/dev/project/README.md")]);
    await page.goto("/");

    await expect(page.locator("[data-permission-modal]")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("permission-symlink-target")).toHaveCount(0);
  });
});
