import { test, expect, type Page } from "../helpers/test";

/**
 * Drawer behaviour, in isolation from the real customization bootstrap.
 *
 * Creating a real customization triggers a large mirror copy and takes
 * seconds — fine for a feature smoke, far too slow for a UI spec that needs
 * predictable counts. We instead intercept `GET /api/customizations` and
 * inject synthetic customization rows. Customizations are no longer backed by
 * workspaces, so the drawer reads exclusively from `/api/customizations`; a
 * single project workspace is still injected via `/api/workspaces` so the rail
 * renders and `/` boots the chat.
 *
 * `/select` is left to a stub: the test doesn't verify what happens AFTER
 * selection (the page navigates to the customization chat). It only verifies
 * the drawer's open/close/click affordances and that selecting a row fires
 * `POST /api/customizations/<id>/select`.
 */

const FIXTURE_WORKSPACES = [
  {
    id: "wks_fixture_project",
    name: "fixture-project",
    rootPath: "/tmp/fixture-project",
    icon: { kind: "letter" as const, letter: "F", color: "#5588dd" },
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    defaults: {},
  },
];

const FIXTURE_CUSTOMIZATIONS = [
  {
    id: "cust_aaaa11110000",
    name: "Fixture Custom A",
    createdAt: 1_700_000_001_000,
    updatedAt: 1_700_000_010_000,
  },
  {
    id: "cust_bbbb22220000",
    name: "Fixture Custom B",
    createdAt: 1_700_000_002_000,
    updatedAt: 1_700_000_005_000,
  },
];

/**
 * Fixed session id returned by the stubbed POST /api/sessions. Stable
 * across the describe block so the use-session.ts URL-writer only fires
 * once per test (the timer guard checks `?session=<id>` and no-ops when
 * the param already matches). Also used by the addInitScript SSE stub.
 */
const FIXTURE_SESSION_ID = "11111111-2222-3333-4444-555555555555";

async function mountFixtureWorkspaces(page: Page): Promise<void> {
  // Inject a fake EventSource into the renderer *before* any scripts run.
  // use-session.ts opens an SSE connection for the session stream; the
  // real endpoint blocks for the lifetime of the session and cannot be
  // easily stubbed via page.route() without either leaving the connection
  // open (leaking a real SDK subprocess) or closing it immediately
  // (triggering exponential reconnects). Swapping the constructor on the
  // client side emits a single "ready" frame synchronously and then sits
  // permanently open, matching the shape use-session.ts expects.
  // Only session-stream URLs are intercepted; notification streams and
  // all other EventSources continue to hit the dev server.
  await page.addInitScript((sessionId: string) => {
    const Real = window.EventSource;
    class FakeSessionES extends EventTarget {
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
              data: JSON.stringify({ type: "ready", sessionId }),
            }),
          );
        });
      }
      close() {
        this.readyState = 2;
      }
      addEventListener = EventTarget.prototype.addEventListener.bind(this);
      removeEventListener = EventTarget.prototype.removeEventListener.bind(this);
    }
    window.EventSource = new Proxy(Real, {
      construct(target, args) {
        const u = String(args[0]);
        if (/\/api\/sessions\/[^/]+\/stream/.test(u)) {
          return new FakeSessionES(u) as unknown as EventSource;
        }
        return Reflect.construct(target, args);
      },
    }) as unknown as typeof EventSource;
  }, FIXTURE_SESSION_ID);

  // Match both `/api/workspaces` and `/api/workspaces?...` — the production
  // route is parameterless, but be defensive.
  await page.route("**/api/workspaces", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ workspaces: FIXTURE_WORKSPACES }),
    });
  });
  // The drawer (and SideNav) read the customization list from here. Stub it
  // with synthetic rows so the drawer renders predictable counts without a
  // real bootstrap. `publishes` is empty — no tile gating in this spec.
  await page.route("**/api/customizations", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ customizations: FIXTURE_CUSTOMIZATIONS, publishes: [] }),
    });
  });
  // Per-workspace GET. `useVerbose` fetches `/api/workspaces/<id>` to
  // reconcile the persisted level. The fixture workspace ids only exist in
  // this test, so hitting the real backend returns a slow 404 — slow enough
  // to widen the boot/click race the test depends on. Stub with a matching
  // synthetic record so the hook resolves immediately.
  await page.route("**/api/workspaces/wks_fixture_*", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const url = new URL(route.request().url());
    const id = url.pathname.split("/").pop()!;
    const ws = FIXTURE_WORKSPACES.find((w) => w.id === id);
    if (!ws) return route.fulfill({ status: 404, body: "{}" });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(ws),
    });
  });
  // Stub the open-tabs API (GET only) so the session boot effect doesn't
  // resume a stale session from a prior test's run. Without this, the
  // workspace page sees a server-persisted activeId from previous tests,
  // resumes that session, and its SSE/navigation state can interfere with
  // the drawer's Escape handler or race the fixture-data load.
  await page.route("**/api/sessions/open-tabs", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ tabs: [], activeId: null, labelMaxWidth: 200 }),
    });
  });
  // Stub POST /api/sessions to return a fixed id rather than creating a
  // real server-side session. This prevents real sessions from accumulating
  // in the SQLite DB across test runs (which would eventually surface via
  // open-tabs contamination as the DB grows). The fixed id is stable
  // across all tests so the SSE fake (addInitScript above) consistently
  // answers the right stream URL.
  await page.route("**/api/sessions", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ id: FIXTURE_SESSION_ID }),
    });
  });
}

test.describe("CustomizationsDrawer", () => {
  test.beforeEach(async ({ page }) => {
    await mountFixtureWorkspaces(page);
  });

  test("drawer trigger is visible when customizations exist", async ({ page }) => {
    await page.goto("/");
    const switcher = page.locator('[data-pane-name="workspace-switcher"]');
    // Drawer trigger: the only button inside the rail with the "Customizations"
    // suffix in its title attribute.
    const drawerBtn = switcher.locator('button[title*="ustomization"]').first();
    await expect(drawerBtn).toBeVisible();
    // No count badge is rendered on the tile any more (removed per design —
    // the orange dot was noise on the rail). The trigger remains discoverable
    // via its title attribute.
    await expect(drawerBtn).not.toContainText(/^\d+$/);
  });

  test("opens popover on click, closes on Escape", async ({ page }) => {
    await page.goto("/");
    const switcher = page.locator('[data-pane-name="workspace-switcher"]');
    const drawerBtn = switcher.locator('button[title*="ustomization"]').first();
    await expect(drawerBtn).toBeVisible({ timeout: 15_000 });
    await drawerBtn.click();

    const heading = page.getByText("Customizations", { exact: true });
    await expect(heading).toBeVisible();
    await expect(page.getByRole("button", { name: /Fixture Custom A/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Fixture Custom B/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /Manage all/ })).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(heading).toBeHidden();
  });

  test("closes when clicking outside the popover", async ({ page }) => {
    await page.goto("/");
    const switcher = page.locator('[data-pane-name="workspace-switcher"]');
    const drawerBtn = switcher.locator('button[title*="ustomization"]').first();
    await expect(drawerBtn).toBeVisible({ timeout: 15_000 });
    await drawerBtn.click();

    const heading = page.getByText("Customizations", { exact: true });
    await expect(heading).toBeVisible();

    // The popover spans roughly x:68-324 from the rail's right edge; clicking
    // at viewport-absolute (1000, 600) is well outside it.
    await page.mouse.click(1000, 600);
    await expect(heading).toBeHidden();
  });

  test("'Manage all' navigates to /customize and closes the popover", async ({ page }) => {
    await page.goto("/");
    // Wait for boot's createSession → bindToSession to settle (URL gains
    // `?session=...`) before clicking the Link. Without this, the boot
    // writer's deferred `replaceState("?session=X")` races with the Link's
    // pushState("/customize"): the click lands fast, the 500ms write
    // timer fires after, and either clobbers the new path's query or
    // re-asserts the chat URL — the test then sees `/wks_xxx?session=Y`
    // instead of `/customize`. Mirrors the pattern in goal.spec.ts.
    await page.waitForURL((url) => /[?&]session=[0-9a-f-]{36}/i.test(String(url)), {
      timeout: 30_000,
    });
    const switcher = page.locator('[data-pane-name="workspace-switcher"]');
    const drawerBtn = switcher.locator('button[title*="ustomization"]').first();
    await drawerBtn.click();

    await page.getByRole("link", { name: /Manage all/ }).click();
    await expect(page).toHaveURL(/\/customize$/, { timeout: 15_000 });
  });

  test("clicking a row fires /select for that customization", async ({ page }) => {
    await page.goto("/");

    // Watch for the select request. The handler then navigates to the
    // customization chat; we don't wait for that — just verify the request
    // was made for the right customization id.
    const selectReq = page.waitForRequest(
      (req) =>
        req.url().endsWith("/api/customizations/cust_aaaa11110000/select") &&
        req.method() === "POST",
      { timeout: 10_000 },
    );

    // Stub the /select endpoint so the fixture-only customization id doesn't
    // 404 out the assertion; the request itself is what we're measuring.
    await page.route("**/api/customizations/cust_aaaa11110000/select", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, id: "cust_aaaa11110000" }),
      });
    });

    const switcher = page.locator('[data-pane-name="workspace-switcher"]');
    const drawerBtn = switcher.locator('button[title*="ustomization"]').first();
    await expect(drawerBtn).toBeVisible({ timeout: 15_000 });
    await drawerBtn.click();
    await page.getByRole("button", { name: /Fixture Custom A/ }).click();

    await selectReq;
  });

  test("shows empty state when there are no customizations", async ({ page }) => {
    await page.unroute("**/api/customizations");
    await page.route("**/api/customizations", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ customizations: [], publishes: [] }),
      });
    });
    await page.goto("/");
    const switcher = page.locator('[data-pane-name="workspace-switcher"]');
    const drawerBtn = switcher.locator('button[title*="ustomization"]').first();
    // The trigger title flips to "Customizations — click to manage" when
    // the list is empty.
    await expect(drawerBtn).toHaveAttribute("title", /click to manage/);
    // No badge — count is 0.
    await expect(drawerBtn).not.toContainText(/^\d+$/);

    await drawerBtn.click();
    await expect(page.getByText(/don't have any customizations yet/i)).toBeVisible();
  });
});
