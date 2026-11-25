/**
 * CC 2.1.331 parity — "[VSCode] Changed permission cards to show only Yes
 * and No when `allowManagedPermissionRulesOnly` is set and the card would
 * offer an allow rule; key 2 on those cards now answers No".
 *
 * A permission request sent while managed settings turn that policy on
 * carries `managedRulesOnly`, and the card then offers only "Allow once" and
 * "Deny…". The "Always (session/project/user)" buttons and the rule hint
 * under them would write a rule the engine ignores. Claudius's card has no
 * digit keys, so the "key 2" half doesn't apply. The resolver and the
 * session.ts wiring are unit-tested in
 * tests/unit/cc-parity-2.1.331-permission-managed-only.test.ts.
 *
 * Screenshot target: docs/cc-parity/2.1.331/permission-managed-only.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";
import { initEvent, mockChatBackend, type SdkEvent } from "./helpers/mock-chat";

const SCREENSHOT_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.331");
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-000002331b12";

const EVENTS: SdkEvent[] = [
  { type: "ready", sessionId: FAKE_SESSION_ID },
  initEvent("sys-331-managed"),
  { type: "replay_done", hasMoreAbove: false },
  {
    type: "permission_request",
    requestId: "req-331-managed",
    toolName: "Bash",
    toolUseId: "tu-331-managed",
    input: { command: "npm run build" },
    title: "Claude wants to run npm run build",
    suggestedRules: [{ toolName: "Bash", ruleContent: "npm run build:*" }],
    managedRulesOnly: true,
  },
];

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
  await mockChatBackend(page, FAKE_SESSION_ID, EVENTS);
});

test("under managed-only rules the card offers only Allow once and Deny", async ({ page }) => {
  await page.goto("/");
  const card = page.getByTestId("permission-card");
  await expect(card).toBeVisible({ timeout: 15_000 });

  await expect(card.getByRole("button", { name: "Allow once" })).toBeVisible();
  await expect(card.getByRole("button", { name: /^Deny/ })).toBeVisible();
  await expect(card.getByRole("button", { name: /^Always/ })).toHaveCount(0);
  await expect(page.getByTestId("permission-always-rule")).toHaveCount(0);

  await card.screenshot({ path: resolve(SCREENSHOT_DIR, "permission-managed-only.png") });
});
