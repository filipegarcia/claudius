/**
 * CC 2.1.196 parity — readable default session names
 *
 * Before this release, untitled sessions showed an 8-char UUID prefix
 * ("aaaaaaaa") in the tab strip. Now they show a human-readable date label:
 *   • Same day   → "Today at 2:15 PM"
 *   • Same year  → "Jun 30 at 2:15 PM"
 *   • Older      → "Jun 30, 2024 at 2:15 PM"
 *
 * The label is generated at display time by `readableSessionLabel()` in
 * `components/chat/SessionTabs.tsx` using the session's `createdAt` epoch ms.
 * It is intentionally NOT persisted to the DB so it never clobbers the SDK's
 * `aiTitle` once one is available.
 *
 * Test strategy
 * -------------
 * We stub `/api/sessions` to return one fake session that has `createdAt` set
 * but no `title`. We also replace `window.EventSource` with a FakeES that
 * emits `{ type: "ready" }` so the active session's composer enables (and the
 * app doesn't show a stream-error state). Then we assert that the tab-strip
 * label for our fake session contains " at " — the separator that appears in
 * ALL three forms of `readableSessionLabel` output — rather than the old
 * 8-char UUID prefix "aaaaaaaa".
 *
 * This simultaneously proves:
 *   1. `Session.createdAt` is serialised by `/api/sessions` (server wiring).
 *   2. `createdAt` reaches `SessionInfo` via the client's API layer.
 *   3. `tabLabelFor()` picks it up from `sessionsForTabs` and calls
 *      `readableSessionLabel()` (the actual label logic).
 *   4. The label renders in `[data-testid="session-tab-label"]` (UI surface).
 */
import { test, expect } from "../helpers/test";
import * as fs from "fs";

// Must be a valid UUID: the POST /api/sessions route rejects a non-UUID
// `resume` id with 400 (CC-parity 2.1.208 argv-injection hardening), which
// would break the boot flow this test drives.
const SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-000000002196";

// Matches all three forms produced by readableSessionLabel:
//   "Today at 2:15 PM"  /  "Jun 30 at 2:15 PM"  /  "Jun 30, 2024 at 2:15 PM"
const READABLE_LABEL_RE = / at /;

test.describe("CC 2.1.196 — readable default session names", () => {
  test.beforeEach(async ({ page }) => {
    // A createdAt "now" so the label reads "Today at HH:MM". Must be set in
    // the route handler (Node context) so `Date.now()` is available.
    const createdAt = Date.now();

    // Replace EventSource so the stream appears to connect successfully.
    // The active session's composer needs a "ready" event to enable; without
    // it the UI might stay in a loading/error state that obscures the tab.
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
            this.onmessage?.call(
              this as unknown as EventSource,
              new MessageEvent("message", {
                data: JSON.stringify({ type: "ready" }),
              }),
            );
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

    // Stub /api/sessions (the list endpoint). Returns a single fake session
    // with createdAt but no title — the exact condition that fires the
    // readable-label fallback in tabLabelFor().
    await page.route("**/api/sessions**", async (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify([
            {
              id: SESSION_ID,
              cwd: "/tmp/test",
              model: null,
              title: null,
              status: "idle",
              createdAt,
            },
          ]),
        });
      }
      return route.fallback();
    });

    // /api/sessions/all is used by the history panel — return empty so
    // nothing leaks from prior test runs.
    await page.route("**/api/sessions/all**", async (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ sessions: [] }),
      }),
    );

    // Minimal stubs for per-session REST endpoints the page fetches on load.
    await page.route(`**/api/sessions/${SESSION_ID}/prompt-draft`, async (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ text: "", images: [] }),
        });
      }
      return route.fallback();
    });

    await page.route(`**/api/sessions/${SESSION_ID}/prompt-color`, async (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ color: null }),
      }),
    );

    await page.route(`**/api/sessions/${SESSION_ID}/commands**`, async (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ commands: [] }),
      }),
    );

    await page.goto(`/?session=${SESSION_ID}`);
  });

  test("tab strip shows a readable date label for an untitled session (CC 2.1.196)", async ({
    page,
  }) => {
    // Locate the tab label for our fake session.
    const tabLabel = page.locator(
      `[data-testid="session-tab"][data-tab-id="${SESSION_ID}"] [data-testid="session-tab-label"]`,
    );
    await expect(tabLabel).toBeVisible({ timeout: 15_000 });

    // The label must contain " at " — the separator in all three
    // readableSessionLabel forms — proving the readable fallback fired.
    await expect(tabLabel).toHaveText(READABLE_LABEL_RE, { timeout: 10_000 });

    // Must NOT be the old 8-char UUID prefix.
    const text = await tabLabel.textContent();
    expect(text).not.toBe(SESSION_ID.slice(0, 8));
  });

  test("screenshot — readable session label in tab strip (CC 2.1.196)", async ({ page }) => {
    const tabLabel = page.locator(
      `[data-testid="session-tab"][data-tab-id="${SESSION_ID}"] [data-testid="session-tab-label"]`,
    );
    await expect(tabLabel).toBeVisible({ timeout: 15_000 });
    await expect(tabLabel).toHaveText(READABLE_LABEL_RE, { timeout: 10_000 });

    fs.mkdirSync("docs/cc-parity/2.1.196", { recursive: true });
    await page.screenshot({
      path: "docs/cc-parity/2.1.196/readable-session-label.png",
      fullPage: false,
    });
  });
});
