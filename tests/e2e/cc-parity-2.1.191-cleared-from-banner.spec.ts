/**
 * CC 2.1.191 parity — "/rewind after /clear"
 *
 * When a user runs /clear, Claudius opens a fresh empty session.
 * A yellow banner now appears at the top of that new session so they
 * can navigate back to the cleared session via the Rewind button (or
 * /rewind in the slash command bar).  This spec drives the browser into
 * that state and:
 *   1. Asserts the banner text and testids are present.
 *   2. Captures a screenshot that shows the banner in context (tab strip,
 *      side nav, session chrome, and the message area below).
 *   3. Asserts the dismiss button removes the banner.
 *
 * Session-creation lifecycle
 * --------------------------
 * The banner is shown when:
 *   (a) `sessionStorage["cleared:<newId>"] === "<oldId>"` exists when the
 *       page mounts with `?session=<newId>`, AND
 *   (b) the session has no user-role messages yet (empty transcript).
 *
 * We seed (a) via `addInitScript` before navigation.  Condition (b) is
 * satisfied by the FakeES stub, which emits only a `ready` event and no
 * messages.
 */
import { test, expect } from "../helpers/test";

const OLD_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const NEW_SESSION_ID = "11111111-2222-3333-4444-555555555555";

test.describe("ClearedFromBanner — /rewind after /clear (CC 2.1.191)", () => {
  test.beforeEach(async ({ page }) => {
    // Stub EventSource so the SDK stream emits `{type:"ready"}` synchronously.
    // Without this, PromptInput stays disabled and tests time out after 60 s.
    // The proxy only intercepts the session-stream URL; notifications keep
    // their real connection to the dev server.
    await page.addInitScript(() => {
      class FakeES extends EventTarget {
        readonly CONNECTING = 0 as const;
        readonly OPEN = 1 as const;
        readonly CLOSED = 2 as const;
        readyState = 1;
        readonly url: string;
        readonly withCredentials = false;
        onopen: ((this: EventSource, ev: Event) => unknown) | null = null;
        onmessage: ((this: EventSource, ev: MessageEvent) => unknown) | null = null;
        onerror: ((this: EventSource, ev: Event) => unknown) | null = null;
        constructor(u: string | URL) {
          super();
          this.url = String(u);
          queueMicrotask(() => {
            this.onopen?.call(this as unknown as EventSource, new Event("open"));
            const readyEv = new MessageEvent("message", {
              data: JSON.stringify({ type: "ready" }),
            });
            this.onmessage?.call(this as unknown as EventSource, readyEv);
          });
        }
        close() {
          this.readyState = 2;
        }
      }
      const Real = window.EventSource;
      window.EventSource = new Proxy(Real, {
        construct(target, args) {
          const u = String(args[0]);
          if (/\/api\/sessions\/[^/]+\/stream/.test(u)) {
            return new FakeES(u) as unknown as EventSource;
          }
          return Reflect.construct(target, args);
        },
      }) as unknown as typeof EventSource;
    });

    // Seed sessionStorage BEFORE navigation so the React render-time latch
    // (`lastClearedSessionId`) picks it up on the first pass.
    await page.addInitScript(
      ({ newId, oldId }: { newId: string; oldId: string }) => {
        // Runs in the browser before any scripts — sets the storage entry
        // that `ClearedFromBanner` reads on mount.
        window.sessionStorage.setItem(`cleared:${newId}`, oldId);
      },
      { newId: NEW_SESSION_ID, oldId: OLD_SESSION_ID },
    );

    // Stub the GET /api/sessions so the tab strip shows our session.
    await page.route("**/api/sessions**", async (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify([
            { id: NEW_SESSION_ID, cwd: process.cwd(), model: null, title: null, status: "idle" },
          ]),
        });
      }
      return route.fallback();
    });

    // Stub /api/sessions/all to return the same session list.
    await page.route("**/api/sessions/all**", async (route) => {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ sessions: [] }),
      });
    });

    // Stub prompt-draft GET so the composer comes up empty.
    await page.route(`**/api/sessions/${NEW_SESSION_ID}/prompt-draft`, async (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ text: "", images: [] }),
        });
      }
      return route.fallback();
    });

    // Stub prompt-color GET (avoids a 404 that would log noise).
    await page.route(`**/api/sessions/${NEW_SESSION_ID}/prompt-color`, async (route) => {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ color: null }),
      });
    });

    // Stub commands GET — avoids a 500 from the SDK not finding our fake session.
    await page.route(`**/api/sessions/${NEW_SESSION_ID}/commands**`, async (route) => {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ commands: [] }),
      });
    });
    // Also stub commands for the old session (rewind target).
    await page.route(`**/api/sessions/${OLD_SESSION_ID}/commands**`, async (route) => {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ commands: [] }),
      });
    });

    // Navigate directly to the new session — simulates landing after /clear.
    await page.goto(`/?session=${NEW_SESSION_ID}`);
  });

  test("banner appears in a fresh cleared session and shows correct text", async ({ page }) => {
    const banner = page.getByTestId("cleared-from-banner");

    // Banner should be visible.
    await expect(banner).toBeVisible({ timeout: 15_000 });

    // Copy check the banner text includes the key phrase.
    await expect(banner).toContainText("Session cleared");
    await expect(banner).toContainText("rewind to return");

    // Both action buttons must be present.
    await expect(page.getByTestId("cleared-from-banner-rewind")).toBeVisible();
    await expect(page.getByTestId("cleared-from-banner-dismiss")).toBeVisible();
  });

  test("banner disappears after dismiss", async ({ page }) => {
    const banner = page.getByTestId("cleared-from-banner");
    await expect(banner).toBeVisible({ timeout: 15_000 });

    await page.getByTestId("cleared-from-banner-dismiss").click();
    await expect(banner).not.toBeVisible({ timeout: 5_000 });
  });

  test("screenshot — cleared-from banner in context (CC 2.1.191)", async ({ page }) => {
    await expect(page.getByTestId("cleared-from-banner")).toBeVisible({ timeout: 15_000 });

    await page.screenshot({
      path: "docs/cc-parity/2.1.191/cleared-from-banner.png",
      fullPage: false,
    });
  });
});
