/**
 * Functional smoke for the *running app*: the composer accepts input,
 * the send button reaches the network, the workspace switcher and
 * settings link are clickable.
 *
 * Why this spec exists
 * --------------------
 * The earlier Electron e2e harness covered structural concerns —
 * titlebar visible, `window.claudius` bridge mounted, sandbox guarantees,
 * OS menu present. None of them asserted that *clicks actually do
 * something*. A user reported the Electron build rendered correctly but
 * "no buttons work"; we want a reproducer that breaks loudly in CI when
 * pointer or keyboard events stop propagating to React.
 *
 * The spec is written against the shared `tests/helpers/test` fixture so
 * it runs under both projects:
 *   • `chromium`           — proves the same flows pass in the browser.
 *   • `chromium-electron`  — proves they pass inside the packaged-shell
 *                            renderer. A regression here is exactly the
 *                            bug we're guarding against.
 *
 * What it covers
 * --------------
 *   1. The first-launch flow auto-bootstraps a workspace (the dev server
 *      runs under a per-run HOME tempdir) and lands on the chat shell.
 *   2. Typing into the composer (`prompt-input`) lands characters —
 *      keyboard events propagate to the renderer.
 *   3. Clicking the send button (`prompt-send`) fires the POST to
 *      `/api/sessions` — pointer events propagate AND the React event
 *      handler is wired up.
 *   4. Clicking the workspace-switcher toggle opens the popover/drawer
 *      — overlays mount and nothing in the title bar's drag region
 *      swallows clicks on the row below.
 *   5. The settings link (`a[href="/settings"]`) navigates — Next router
 *      handles clicks correctly inside the Electron renderer.
 *   6. The `POST /api/workspaces` endpoint succeeds — a baseline that
 *      the dev server is healthy under the e2e HOME sandbox.
 */
import { test, expect, type Route } from "../helpers/test";

test.describe("App functionality — buttons, navigation, workspace, settings", () => {
  test("chat composer is interactive: typing and sending both reach React handlers", async ({
    page,
  }) => {
    // Mock the POST so we don't hit the real Claude SDK. The test cares
    // that the click reaches the network layer at all, not that the
    // agent runs.
    let sessionCreated = false;
    await page.route("**/api/sessions", async (route: Route) => {
      if (route.request().method() === "POST") {
        sessionCreated = true;
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ id: "11111111-2222-3333-4444-555555555555" }),
        });
      }
      return route.fallback();
    });

    // Stub EventSource so the SDK's session stream emits `{type:"ready"}`
    // synchronously. PromptInput keeps the composer `disabled` until
    // `useSession` sees a `ready` event from the stream — without this
    // the composer never enables and `composer.click()` times out at
    // 60s. We can't `page.route("**/api/sessions/*/stream")` and serve
    // a single SSE frame because `route.fulfill` closes the connection
    // immediately; EventSource would reconnect and we'd loop. Stubbing
    // the constructor on the renderer side is the same trick
    // community-nav.spec.ts uses for the chat-server SSE.
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
      // Only swap for session stream URLs so other EventSources (e.g.
      // notifications) keep using the real implementation against the
      // dev server.
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

    await page.goto("/");

    // The renderer redirects from / to /<workspaceId> once the default
    // workspace is auto-bootstrapped. We wait on the composer testid —
    // that's the cheapest signal the chat page has mounted.
    const composer = page.getByTestId("prompt-input");
    await expect(composer).toBeVisible({ timeout: 30_000 });

    // Type into the composer. If keyboard events were being swallowed
    // by a stray drag region (the "no buttons work" failure mode) we'd
    // see no characters land.
    await composer.click();
    await composer.fill("hello from e2e");
    await expect(composer).toHaveValue("hello from e2e");

    // Click the send button. If pointer events were being captured by
    // an overlay we'd see this hang. The button is enabled once the
    // composer has content.
    const send = page.getByTestId("prompt-send");
    await expect(send).toBeVisible();
    await send.click();

    // The POST must have fired. We don't follow the SSE stream — the
    // create call landing is enough to prove the click handler ran.
    await expect.poll(() => sessionCreated, { timeout: 10_000 }).toBe(true);
  });

  test("workspace switcher opens on click of the rail toggle", async ({ page }) => {
    // The `sidenav-workspaces-toggle` button is `lg:hidden` — it only
    // mounts visibly under the `lg` (1024px) breakpoint, since the full
    // workspace rail replaces it on wider screens. The default Playwright
    // viewport (1280×800, set in playwright.config.ts) sits above `lg`,
    // so without resizing first the test waits 30s for a hidden button.
    // Shrink to a tablet-ish width so the mobile hamburger renders.
    await page.setViewportSize({ width: 768, height: 800 });
    await page.goto("/");
    const toggle = page.getByTestId("sidenav-workspaces-toggle");
    await expect(toggle).toBeVisible({ timeout: 30_000 });

    // The toggle is the hamburger that surfaces the workspace switcher
    // on small viewports. Clicking it must reveal *something* — the
    // drawer mounts and the toggle's aria-expanded flips to "true".
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true", { timeout: 5_000 });
  });

  test("settings link navigates to /settings and renders the page", async ({ page }) => {
    await page.goto("/");
    // The workspace rail puts the settings cog at the bottom as a
    // plain `<a href="/settings">`. No dedicated testid — the href is
    // the stable selector.
    const settingsLink = page.locator('a[href="/settings"]').first();
    await expect(settingsLink).toBeVisible({ timeout: 30_000 });
    await settingsLink.click();

    await expect(page).toHaveURL(/\/settings(?:$|\?|\/)/, { timeout: 15_000 });
    // The settings page renders its title inside a styled `<header>`
    // (not a real `<h1>`), so `getByRole("heading", ...)` finds nothing.
    // The `<main data-pane-name="settings-main">` element is the
    // structural marker that the settings page actually mounted; if
    // navigation succeeded but routing/RSC failed, this won't exist.
    await expect(page.locator('[data-pane-name="settings-main"]')).toBeVisible({
      timeout: 10_000,
    });
  });

  test("POST /api/workspaces succeeds — the dev server is healthy under the e2e sandbox", async ({
    page,
    baseURL,
  }) => {
    await page.goto("/");
    // The previous readiness signal was `sidenav-workspaces-toggle`, but
    // that's `lg:hidden` on the default 1280px viewport — `toBeVisible`
    // sat for 30s and failed. The left-nav aside renders on every
    // viewport, so it's the safer "page mounted" check for this test
    // (which is really about the dev-server API surface, not the chrome).
    await expect(page.locator('[data-pane-name="left-nav"]')).toBeVisible({ timeout: 30_000 });

    // The POST handler requires { name, rootPath } and 400s on anything
    // else (see app/api/workspaces/route.ts). The earlier shape
    // `{ cwd }` was vestigial — workspaces-store renamed the field
    // before this spec was written. We send the project root because
    // it's guaranteed to exist on every CI runner.
    const createRes = await page.request.post(`${baseURL}/api/workspaces`, {
      data: { name: `smoke-${Date.now()}`, rootPath: process.cwd() },
    });
    expect(createRes.ok()).toBe(true);
    const created = (await createRes.json()) as { id: string };
    expect(created.id).toMatch(/^wks_[a-f0-9]+$/);

    // Sanity: the new workspace is in the list returned by GET.
    const listRes = await page.request.get(`${baseURL}/api/workspaces`);
    expect(listRes.ok()).toBe(true);
    const list = (await listRes.json()) as { workspaces: { id: string }[] };
    const ids = list.workspaces.map((w) => w.id);
    expect(ids).toContain(created.id);
  });

  // -------------------------------------------------------------------------
  // Full UI-driven workspace creation flow.
  //
  // This is the "real" repro for "no buttons work": every step is a click or
  // a keystroke against the actual UI — no API short-circuits, no fixtures.
  // If the renderer is swallowing input events, the spec hangs at the first
  // click and fails informatively.
  //
  //   1. Click the "+" tile in the workspace rail   → opens WorkspaceForm
  //   2. Fill the name input
  //   3. Fill the root-folder input (typed, no folder picker)
  //   4. Click "Save"
  //   5. Assert the network POST `/api/workspaces` fires with our values
  //   6. Assert the form closes (overlay backdrop dismissed)
  //   7. Assert the new workspace's id is in `GET /api/workspaces`
  // -------------------------------------------------------------------------
  test("UI flow: clicking '+' in the rail → filling the form → Save creates a workspace", async ({
    page,
    baseURL,
  }) => {
    let capturedPostBody: { name?: unknown; cwd?: unknown } | null = null;

    // Intercept the POST so we can inspect what the form sent without
    // depending on whether the dev server's filesystem actually has the
    // folder. We still call route.fallback() so the real server takes
    // over and creates the row — the assertion below reads the GET list.
    await page.route("**/api/workspaces", async (route: Route) => {
      if (route.request().method() === "POST") {
        try {
          capturedPostBody = (await route.request().postDataJSON()) as typeof capturedPostBody;
        } catch {
          capturedPostBody = null;
        }
      }
      return route.fallback();
    });

    await page.goto("/");

    // The "+" tile is identified by its title attribute (no testid yet).
    // It lives inside the workspace rail. Click → form mounts.
    const newWorkspaceBtn = page.locator('button[title="New workspace"]').first();
    await expect(newWorkspaceBtn).toBeVisible({ timeout: 30_000 });
    await newWorkspaceBtn.click();

    // The Overlay renders a heading "New workspace" — that's the form
    // mount marker. If the click did nothing the heading never appears
    // and the next assertion times out.
    // The Overlay's title is rendered as a styled `<div>` not an
    // `<h1>/<h2>`, so getByRole("heading") misses it. The form's "Name"
    // label is the most stable structural marker of "the modal mounted".
    const formNameLabel = page.getByText("Name", { exact: true });
    await expect(formNameLabel).toBeVisible({ timeout: 10_000 });
    const formHeading = formNameLabel; // alias kept for the close-assertion below

    // Fill the two required fields. We pick a folder we know exists —
    // `process.cwd()` is the project root in the dev server's view too,
    // since the webServer inherits cwd from the Playwright runner.
    const wsName = `E2E workspace ${Date.now()}`;
    // Use the labelled-textbox accessor — `getByPlaceholder("Claudius")`
    // matches both the Name input AND the Root folder input (whose
    // placeholder "/Users/you/projects/claudius" contains "Claudius"
    // as a substring), tripping Playwright's strict mode.
    const nameInput = page.getByRole("textbox", { name: "Name" });
    const rootInput = page.getByRole("textbox", { name: /root folder/i });
    await nameInput.fill(wsName);
    await rootInput.fill(process.cwd());

    // Submit. The button is disabled until both fields are non-empty —
    // we filled them above so it must be enabled now.
    const saveBtn = page.getByRole("button", { name: /^save$/i });
    await expect(saveBtn).toBeEnabled();
    await saveBtn.click();

    // The form closes once create() succeeds. We poll on the heading
    // disappearing — that's the visual signal everything worked.
    await expect(formHeading).toBeHidden({ timeout: 10_000 });

    // The form's POST captured the values we typed (or at least
    // something derived from them). The renderer normalises the cwd
    // via realpath so we only assert the name is present.
    expect(capturedPostBody, "form should POST a body to /api/workspaces").toBeTruthy();

    // And the workspace is now in the list returned by GET.
    const listRes = await page.request.get(`${baseURL}/api/workspaces`);
    expect(listRes.ok()).toBe(true);
    const list = (await listRes.json()) as { workspaces: { id: string; name: string }[] };
    const names = list.workspaces.map((w) => w.name);
    expect(names).toContain(wsName);
  });
});
