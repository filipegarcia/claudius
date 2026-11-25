/**
 * CC 2.1.331 parity — "Added an API connectivity section to `claude doctor`
 * that reports whether the API can be reached, with the HTTP status or the
 * error, or says why it wasn't tested".
 *
 * /doctor gets an "API connectivity" section fed by its own route,
 * `/api/doctor/connectivity` (mocked here; the test itself is covered by
 * tests/unit/cc-parity-2.1.331-doctor-api-connectivity.test.ts). It shows
 * the engine's lines: the HTTP status or the error, the network settings in
 * play, and the proxy/firewall pointer when the test fails — or why it wasn't
 * tested.
 *
 * Screenshot target: docs/cc-parity/2.1.331/doctor-api-connectivity.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.331");
mkdirSync(SHOTS_DIR, { recursive: true });

const HINT =
  "A proxy, firewall, VPN or security software between this machine and the host can cause these results. See https://code.claude.com/docs/en/network-config";

async function mockDoctor(page: Page, connectivity: Record<string, unknown>) {
  await page.route("**/api/doctor", (route: Route) =>
    route.fulfill({
      json: {
        runtime: { node: "22.0.0", platform: "darwin", arch: "arm64" },
        sdk: { version: "0.3.332" },
        checks: [
          { id: "node", label: "Node.js", status: "ok", detail: "v22.0.0" },
          { id: "auth", label: "Auth", status: "ok", detail: "OAuth credentials file present" },
        ],
      },
    }),
  );
  await page.route("**/api/doctor/connectivity", (route: Route) => route.fulfill({ json: connectivity }));
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test("/doctor reports a failed API connectivity test with the error and the network pointer", async ({ page }) => {
  await mockDoctor(page, {
    tested: true,
    passed: false,
    lines: [
      "API (api.anthropic.com): failed after 31 ms: ECONNREFUSED",
      "ANTHROPIC_BASE_URL: not set · NODE_EXTRA_CA_CERTS: not set · CLAUDE_CODE_CLIENT_CERT: not set",
    ],
    hint: HINT,
  });
  await page.goto("/doctor");
  const section = page.getByTestId("doctor-api-connectivity-section");
  await expect(section).toHaveAttribute("data-state", "fail", { timeout: 15_000 });
  await expect(section.getByText("API connectivity")).toBeVisible();
  const lines = section.getByTestId("doctor-api-connectivity-line");
  await expect(lines).toHaveText([
    "API (api.anthropic.com): failed after 31 ms: ECONNREFUSED",
    "ANTHROPIC_BASE_URL: not set · NODE_EXTRA_CA_CERTS: not set · CLAUDE_CODE_CLIENT_CERT: not set",
  ]);
  await expect(section).toContainText(HINT);
  await page.waitForTimeout(150);
  await page.screenshot({ path: resolve(SHOTS_DIR, "doctor-api-connectivity.png"), fullPage: false });
});

test("/doctor shows a reachable API, and why a test was skipped", async ({ page }) => {
  await mockDoctor(page, {
    tested: true,
    passed: true,
    lines: [
      "API (api.anthropic.com): answered HTTP 200 in 84 ms",
      "ANTHROPIC_BASE_URL: not set · NODE_EXTRA_CA_CERTS: not set · CLAUDE_CODE_CLIENT_CERT: not set",
    ],
  });
  await page.goto("/doctor");
  const section = page.getByTestId("doctor-api-connectivity-section");
  await expect(section).toHaveAttribute("data-state", "ok", { timeout: 15_000 });
  await expect(section).toContainText("answered HTTP 200 in 84 ms");
  await expect(section).not.toContainText("A proxy, firewall");

  await page.unroute("**/api/doctor/connectivity");
  await page.route("**/api/doctor/connectivity", (route: Route) =>
    route.fulfill({
      json: {
        tested: false,
        passed: true,
        lines: ["Not tested: CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is set"],
      },
    }),
  );
  await page.getByRole("button", { name: "Re-run" }).click();
  await expect(section).toHaveAttribute("data-state", "skipped", { timeout: 15_000 });
  await expect(section.getByTestId("doctor-api-connectivity-line")).toHaveText(
    "Not tested: CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is set",
  );
});
