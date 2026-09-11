import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";

/**
 * SDK 0.3.268 — `canUseTool`'s options gained two rendering hints, neither
 * mentioned in the prose changelog (found by diffing `sdk.d.ts`):
 *
 *   - `defaultToNo`: the prompt must not be approvable by a single stray
 *     keystroke — open on the decline option, offer no one-key approve.
 *   - `suppressAlwaysAllowRule`: the ask must not offer a persistent
 *     "always allow" choice — the rule it would write grants more than
 *     this ask's own action.
 *
 * `Session.canUseTool` (lib/server/session.ts) forwards both onto the
 * `permission_request` SSE event; `PermissionPrompt.tsx` renders them: the
 * deny panel opens pre-expanded with focus on "Deny without feedback" for
 * `defaultToNo`, and all three "Always" buttons plus the auto-mode tip
 * (itself a one-click standing grant) are hidden for either hint.
 *
 * Exercised via a synthetic `permission_request` SSE event, same strategy
 * as cc-parity-2.1.247-permission-auto-mode-tip.spec.ts. No real SDK
 * required.
 *
 * Screenshot target: docs/sdk-updates/0.3.268/permission-default-to-no.png
 */

const SHOTS_DIR = resolve(process.cwd(), "docs/sdk-updates/0.3.268");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "00000000-1111-2222-3333-agent0003268";

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
      uuid: "sys-3268",
      model: "claude-sonnet-4-6",
    },
  },
  { type: "replay_done", hasMoreAbove: false },
];

function permissionEvent(requestId: string, opts: { defaultToNo?: boolean; suppressAlwaysAllowRule?: boolean }): SdkEvent {
  return {
    type: "permission_request",
    requestId,
    toolName: "Bash",
    toolUseId: `toolu_bash_3268_${requestId}`,
    input: { command: "rm -rf node_modules/.cache" },
    title: "Run a shell command",
    description: "Execute `rm -rf node_modules/.cache` in the project directory.",
    displayName: "Run Bash",
    ...opts,
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
    if (route.request().method() === "POST") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    }
    return route.fallback();
  });

  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/mode`, async (route: Route) => {
    if (route.request().method() === "POST") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    }
    return route.fallback();
  });
}

test.describe("SDK 0.3.268 — canUseTool defaultToNo / suppressAlwaysAllowRule", () => {
  test("defaultToNo opens on the decline panel, focused, with no standing-grant affordances", async ({
    page,
  }) => {
    await mockChatBackend(page, [
      ...PRELUDE,
      permissionEvent("req-3268-deny", { defaultToNo: true, suppressAlwaysAllowRule: true }),
    ]);
    await page.goto("/");

    const modal = page.locator("[data-permission-modal]");
    await expect(modal).toBeVisible({ timeout: 15_000 });
    await expect(modal).toHaveAttribute("data-default-to-no", "true");

    // Decline panel is open without clicking "Deny…" first, and the
    // no-feedback deny button — the one-keystroke decline path — has focus.
    const denyButton = page.getByRole("button", { name: "Deny without feedback" });
    await expect(denyButton).toBeVisible();
    await expect(denyButton).toBeFocused();

    // No standing-grant affordance survives: neither the three "Always"
    // buttons nor the auto-mode tip (itself a one-click standing grant).
    await expect(page.getByRole("button", { name: "Always (session)" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Always (project)" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Always (user)" })).toHaveCount(0);
    await expect(page.getByTestId("permission-auto-mode-tip")).toHaveCount(0);

    await page.waitForTimeout(200);
    await page.screenshot({
      path: resolve(SHOTS_DIR, "permission-default-to-no.png"),
      fullPage: false,
    });

    await denyButton.click();
    await expect(modal).not.toBeVisible({ timeout: 5_000 });
  });

  test("suppressAlwaysAllowRule alone hides standing-grant buttons but leaves the deny panel closed", async ({
    page,
  }) => {
    await mockChatBackend(page, [
      ...PRELUDE,
      permissionEvent("req-3268-suppress", { suppressAlwaysAllowRule: true }),
    ]);
    await page.goto("/");

    const modal = page.locator("[data-permission-modal]");
    await expect(modal).toBeVisible({ timeout: 15_000 });
    await expect(modal).not.toHaveAttribute("data-default-to-no", "true");

    // "Allow once" still works — only the standing-grant affordances go.
    await expect(page.getByRole("button", { name: "Allow once" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Always (session)" })).toHaveCount(0);
    await expect(page.getByTestId("permission-auto-mode-tip")).toHaveCount(0);
    // Not `defaultToNo`, so the decline panel stays collapsed until clicked.
    await expect(page.getByRole("button", { name: "Deny without feedback" })).toHaveCount(0);
  });
});
