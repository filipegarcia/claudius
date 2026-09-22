/**
 * Per-session account attribution.
 *
 * Sessions are *pinned* to the account profile they were spawned under
 * (`Session.resolveAccountProfile()` persists `accountProfileId` into the
 * session's JSON state bag), so on a multi-account install two sessions side
 * by side can be billed to different identities. Until now that was only
 * visible on the StatusLine of a *live* session; every listing surface was
 * silent, and `/api/sessions/[id]/account` 404s once a session is reaped.
 *
 * These specs cover the listing side of that pin:
 *   - `/api/sessions/all` reports `accountId` / `accountLabel` per session
 *     plus an `accountsConfigured` count;
 *   - the sessions page renders the label on the metadata row;
 *   - and — the easy thing to regress — the badge is SUPPRESSED when only
 *     one profile exists, because then every row would read the same.
 *
 * Strategy: stub `/api/sessions/all` rather than provisioning real account
 * profiles. The pin lives in a per-project SQLite DB and the profiles in a
 * 0600 file under the real `~/.claude`; writing either from a test would
 * mutate the developer's actual accounts. The contract under test is
 * "route shape → rendered badge", which the stub exercises exactly.
 */
import { test, expect, type Page } from "../helpers/test";

const SESSION_A = "aaaaaaaa-bbbb-cccc-dddd-00000000ac01";
const SESSION_B = "aaaaaaaa-bbbb-cccc-dddd-00000000ac02";
const SESSION_C = "aaaaaaaa-bbbb-cccc-dddd-00000000ac03";

/**
 * Stub the listing endpoint with two pinned sessions and one unpinned.
 * `accountsConfigured` is the gate the UI reads.
 */
async function stubSessions(page: Page, accountsConfigured: number) {
  await page.route("**/api/sessions/all**", async (route) => {
    const now = Date.now();
    // The sessions page scopes rows to the active workspace root
    // (`scopedSessions` filters on `s.cwd === workspaceRoot`) and passes
    // that root as `?dir=`. Echo it back as each row's cwd so the stub
    // survives on any machine instead of hardcoding a checkout path.
    const dir = new URL(route.request().url()).searchParams.get("dir") ?? "/tmp/acct-spec";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        accountsConfigured,
        sessions: [
          {
            sessionId: SESSION_A,
            claudiusTitle: "Billed to work",
            summary: "",
            lastModified: now,
            fileSize: 1024,
            cwd: dir,
            accountId: "acc_work",
            accountLabel: "Work Max",
          },
          {
            sessionId: SESSION_B,
            claudiusTitle: "Billed to personal",
            summary: "",
            lastModified: now - 1000,
            fileSize: 2048,
            cwd: dir,
            accountId: "acc_personal",
            accountLabel: "Personal",
          },
          {
            // Predates account pinning — must render NO badge rather than
            // being silently attributed to the active account.
            sessionId: SESSION_C,
            claudiusTitle: "Legacy, never pinned",
            summary: "",
            lastModified: now - 2000,
            fileSize: 512,
            cwd: dir,
          },
        ],
      }),
    });
  });
}

test.describe("per-session account attribution", () => {
  test("sessions page labels each session with its pinned account", async ({ page }) => {
    await stubSessions(page, 3);
    await page.goto("/sessions");

    const badges = page.getByTestId("session-account");
    await expect(badges).toHaveCount(2);
    await expect(badges.nth(0)).toHaveText("Work Max");
    await expect(badges.nth(1)).toHaveText("Personal");

    // The account id rides along for styling / debugging hooks.
    await expect(badges.nth(0)).toHaveAttribute("data-account", "acc_work");

    // The unpinned session is present but unbadged — "unknown" must not be
    // rendered as the active account.
    await expect(page.getByText("Legacy, never pinned")).toBeVisible();
  });

  test("badge is suppressed when only one account is configured", async ({ page }) => {
    // Same rows, but a single-profile install. Even though the payload
    // carries labels, the UI must stay quiet: with one account the answer
    // is never ambiguous and the badge is pure noise.
    await stubSessions(page, 1);
    await page.goto("/sessions");

    await expect(page.getByText("Billed to work")).toBeVisible();
    await expect(page.getByTestId("session-account")).toHaveCount(0);
  });
});
