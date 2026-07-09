/**
 * CC 2.1.203 parity — proactive "your login is about to expire" warning
 *
 * When the active account profile's OAuth token falls within
 * `TOKEN_EXPIRY_WARNING_WINDOW_MS` of expiring, the server fires a one-shot
 * `token_expiring_required` SSE event (`Session.noteTokenExpiringAtStartup()`
 * in `lib/server/session.ts`). The client renders a dismissible amber
 * `TokenExpiringPanel` banner above the composer, next to the reactive
 * `AuthFailedPanel` sibling, linking to `/usage#accounts`.
 *
 * Test strategy
 * -------------
 * Same approach as the 2.1.193 MCP needs-auth notice spec: we can't drive a
 * real SDK session end-to-end in the e2e suite, so we stub `EventSource` to
 * emit `{ type: "ready" }` followed by `{ type: "token_expiring_required",
 * expiresAt }`, exercising the client-side SSE contract (event shape +
 * handler registration + rendered banner) without real account/token infra.
 */
import { test, expect } from "../helpers/test";

const SESSION_ID = "cc204-aaaa-bbbb-cccc-token-expiring-test";
// ~2 hours out, comfortably inside the 24h warning window.
const EXPIRES_IN_MS = 2 * 60 * 60 * 1000;

test.describe("CC 2.1.204 — proactive login-expiry warning", () => {
  test.beforeEach(async ({ page }) => {
    // Stub EventSource so the SSE stream emits what we want deterministically.
    await page.addInitScript((expiresInMs) => {
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
            // 1. Signal session ready (enables the composer).
            this.onmessage?.call(
              this as unknown as EventSource,
              new MessageEvent("message", {
                data: JSON.stringify({ type: "ready" }),
              }),
            );
            // 2. Emit the token-expiring nudge — the CC 2.1.203 feature.
            this.onmessage?.call(
              this as unknown as EventSource,
              new MessageEvent("message", {
                data: JSON.stringify({
                  type: "token_expiring_required",
                  expiresAt: Date.now() + expiresInMs,
                }),
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
    }, EXPIRES_IN_MS);

    // Stub /api/sessions so the tab strip shows our fake session.
    await page.route("**/api/sessions**", async (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify([
            { id: SESSION_ID, cwd: process.cwd(), model: null, title: null, status: "idle" },
          ]),
        });
      }
      return route.fallback();
    });

    await page.route("**/api/sessions/all**", async (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ sessions: [] }),
      }),
    );

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

  test("token_expiring_required SSE event produces the amber banner with a working CTA", async ({
    page,
  }) => {
    const banner = page.locator('[data-pane-name="token-expiring"]');
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await expect(banner).toContainText(/your login expires in about 2h/i);
    await expect(banner).toContainText(/re-authenticate now/i);
    const cta = banner.getByRole("link", { name: "Open accounts" });
    await expect(cta).toHaveAttribute("href", /\/usage#accounts$/);
  });

  test("screenshot — proactive login-expiry banner in chat surface (CC 2.1.203)", async ({
    page,
  }) => {
    const banner = page.locator('[data-pane-name="token-expiring"]');
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await page.screenshot({
      path: "docs/cc-parity/2.1.204/token-expiring-notice.png",
      fullPage: false,
    });
  });
});
