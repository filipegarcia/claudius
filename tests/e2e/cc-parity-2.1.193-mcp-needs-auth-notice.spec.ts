/**
 * CC 2.1.193 parity — MCP needs-auth startup notice
 *
 * When any configured MCP server is in `needs-auth` state at session start,
 * the server broadcasts a `mcp_needs_auth_notice` SSE event. The client
 * injects a `kind: "info"` transcript pill pointing the user at `/mcp` to
 * authenticate.
 *
 * Test strategy
 * -------------
 * We can't drive a real SDK session in the e2e suite, so we exercise the
 * client-side SSE handler directly: `FakeES` intercepts the session stream
 * and emits `{ type: "ready" }` (required for the composer to enable)
 * followed immediately by `{ type: "mcp_needs_auth_notice", servers:
 * ["github"] }`. The client's `applyEvent()` handler processes the latter
 * and calls `setSystemEntries()`, producing the visible info pill.
 *
 * This approach tests the client–server contract surface (the SSE event
 * shape and the handler registration) without spinning up real MCP infra.
 */
import { test, expect } from "../helpers/test";

const SESSION_ID = "cc193-aaaa-bbbb-cccc-mcp-notice-test";

test.describe("CC 2.1.193 — MCP needs-auth startup notice", () => {
  test.beforeEach(async ({ page }) => {
    // Stub EventSource so the SSE stream emits what we want deterministically.
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
            // 1. Signal session ready (enables the composer).
            this.onmessage?.call(
              this as unknown as EventSource,
              new MessageEvent("message", {
                data: JSON.stringify({ type: "ready" }),
              }),
            );
            // 2. Emit the MCP needs-auth notice — the CC 2.1.193 feature.
            this.onmessage?.call(
              this as unknown as EventSource,
              new MessageEvent("message", {
                data: JSON.stringify({
                  type: "mcp_needs_auth_notice",
                  servers: ["github"],
                }),
              }),
            );
          });
        }
        close() { this.readyState = 2; }
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

  test("mcp_needs_auth_notice SSE event produces an info pill in the transcript", async ({
    page,
  }) => {
    // The info pill text should contain the server name and the /mcp hint.
    const pill = page.getByText(/MCP server needs auth.*github/i);
    await expect(pill).toBeVisible({ timeout: 15_000 });
    await expect(pill).toContainText("open /mcp to connect");
  });

  test("screenshot — MCP needs-auth notice pill in chat transcript (CC 2.1.193)", async ({
    page,
  }) => {
    await expect(page.getByText(/MCP server needs auth.*github/i)).toBeVisible({
      timeout: 15_000,
    });
    await page.screenshot({
      path: "docs/cc-parity/2.1.193/mcp-needs-auth-notice.png",
      fullPage: false,
    });
  });
});
