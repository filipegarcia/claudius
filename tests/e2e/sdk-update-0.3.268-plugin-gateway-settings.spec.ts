/**
 * SDK 0.3.268 — three new `Settings` passthrough keys, none mentioned in the
 * prose changelog (found by diffing `sdk.d.ts`):
 *
 *   - `prependPlugins` / `appendPlugins`: managed plugins whose hooks run
 *     first/last among plugins (outermost/innermost), in listed order.
 *   - `gatewayInternalNetworks`: IPv4 CIDR blocks a Cloud gateway sits in,
 *     letting `/login` reach a gateway numbered from a public range.
 *
 * All three are reachable via `ClaudeSettings`'s index signature already —
 * this adds them to the generic SDK-settings catalog on `/settings`
 * (`app/settings/page.tsx`) as `string[]` rows, same round-trip pattern
 * `promptCacheTtl` used in 0.3.245 (see
 * sdk-update-0.3.245-prompt-cache-ttl.spec.ts, which this spec mirrors).
 *
 * Screenshot target: docs/sdk-updates/0.3.268/plugin-gateway-settings.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/sdk-updates/0.3.268");
mkdirSync(SHOTS_DIR, { recursive: true });

type UserSettings = Record<string, unknown>;

async function clearSettings(page: Page): Promise<void> {
  const res = await page.request.get("/api/settings?scope=user");
  const body = (await res.json()) as { settings: UserSettings };
  const rest = { ...body.settings };
  delete rest.prependPlugins;
  delete rest.appendPlugins;
  delete rest.gatewayInternalNetworks;
  await page.request.put("/api/settings/full", {
    data: { scope: "user", settings: rest },
  });
}

async function readSettings(page: Page): Promise<UserSettings> {
  const res = await page.request.get("/api/settings?scope=user");
  const body = (await res.json()) as { settings: UserSettings };
  return body.settings;
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
  await clearSettings(page);
});

test.afterEach(async ({ page }) => {
  await clearSettings(page);
});

test.describe("Plugins ordering + gateway-internal-networks settings (SDK 0.3.268)", () => {
  test("prependPlugins/appendPlugins/gatewayInternalNetworks render as string[] rows and round-trip", async ({
    page,
  }) => {
    await page.goto("/settings");

    await page.getByLabel("Search settings").fill("prependPlugins");
    const prepend = page.getByTestId("catalog-field-prependPlugins");
    await expect(prepend).toBeVisible({ timeout: 15_000 });
    await prepend.locator("input").fill("acme@marketplace");

    await page.getByLabel("Search settings").fill("appendPlugins");
    const append = page.getByTestId("catalog-field-appendPlugins");
    await expect(append).toBeVisible();
    await append.locator("input").fill("zeta@marketplace, omega@marketplace");

    await page.getByLabel("Search settings").fill("gatewayInternalNetworks");
    const gateway = page.getByTestId("catalog-field-gatewayInternalNetworks");
    await expect(gateway).toBeVisible();
    await gateway.locator("input").fill("203.0.113.0/24");

    // Screenshot the Plugins/Authentication section with the gateway row
    // filled in and visible — the last-focused row's context.
    await page.waitForTimeout(150);
    await page.screenshot({
      path: resolve(SHOTS_DIR, "plugin-gateway-settings.png"),
      fullPage: false,
    });

    await page.getByRole("button", { name: /^Save$/ }).click();

    await expect
      .poll(async () => await readSettings(page), { timeout: 10_000 })
      .toMatchObject({
        prependPlugins: ["acme@marketplace"],
        appendPlugins: ["zeta@marketplace", "omega@marketplace"],
        gatewayInternalNetworks: ["203.0.113.0/24"],
      });
  });
});
