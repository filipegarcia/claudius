import { test, expect } from "@playwright/test";

/**
 * Regression test: navigating /community → another route → back to /community
 * should reconnect the chat-server SSE and re-fetch the rooms list. The bug
 * was that soft-nav back left the rooms list empty + the WiFi indicator off
 * until the user hit refresh.
 *
 * Mocks the chat-server REST + SSE so the test doesn't need a real
 * chat-server running. NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL must be set on
 * the dev server the test points at (see playwright.config.ts) so the page
 * mounts the configured surface.
 */
const FAKE_URL =
  process.env.NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL ?? "http://localhost:8787";

test.describe("/community soft-nav reconnect", () => {
  test("rooms repopulate and SSE reconnects after leaving and returning", async ({ page }) => {
    // Pre-seed nick + community consent so neither the NicknameModal nor
    // the consent gate (added in b7ffd93) block <CommunityChat> from
    // mounting. Without `consent=yes` the /community route renders the
    // ConsentPrompt instead and the `community-page` testid never
    // appears.
    await page.addInitScript(() => {
      try {
        localStorage.setItem("claudius.community.nick", "tester");
        localStorage.setItem("claudius.community.consent", "yes");
      } catch {}
    });

    // /rooms — return a stable list both times it's called.
    await page.route(`${FAKE_URL}/rooms`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          rooms: [
            { slug: "general", name: "#general", description: "", pinnedMessageId: null },
            { slug: "bugs", name: "#bugs", description: "", pinnedMessageId: null },
          ],
        }),
      });
    });

    // SSE: stub EventSource so onopen fires + a replay frame arrives without
    // a real server. Without this the page would sit at "connecting" forever
    // because the test environment has no chat-server reachable.
    await page.addInitScript(({ url }) => {
      const Real = window.EventSource;
      // Not `implements EventSource` — the lib's `addEventListener` overload
      // signature isn't structurally compatible with EventTarget's, and we
      // already cast at the call site. Keep the duck-type matching the
      // surface the page actually touches.
      class FakeES extends EventTarget {
        readonly CONNECTING = 0 as const;
        readonly OPEN = 1 as const;
        readonly CLOSED = 2 as const;
        readyState: number = 1;
        readonly url: string;
        readonly withCredentials = false;
        onopen: ((this: EventSource, ev: Event) => unknown) | null = null;
        onmessage: ((this: EventSource, ev: MessageEvent) => unknown) | null = null;
        onerror: ((this: EventSource, ev: Event) => unknown) | null = null;
        constructor(u: string | URL) {
          super();
          this.url = String(u);
          queueMicrotask(() => {
            const openEv = new Event("open");
            this.onopen?.call(this as unknown as EventSource, openEv);
            this.dispatchEvent(openEv);
            const slug = decodeURIComponent(
              this.url.match(/\/rooms\/([^/]+)\/stream/)?.[1] ?? "",
            );
            const payload = {
              type: "replay",
              roomSlug: slug,
              messages: [],
              pinnedMessageId: null,
            };
            const msgEv = new MessageEvent("message", {
              data: JSON.stringify(payload),
            });
            this.onmessage?.call(this as unknown as EventSource, msgEv);
            this.dispatchEvent(msgEv);
          });
        }
        close() {
          this.readyState = 2;
        }
      }
      window.EventSource = new Proxy(Real, {
        construct(target, args) {
          const u = String(args[0]);
          if (u.startsWith(url)) return new FakeES(u) as unknown as EventSource;
          return Reflect.construct(target, args);
        },
      }) as unknown as typeof EventSource;
    }, { url: FAKE_URL });

    // First visit
    await page.goto("/community");
    await expect(page.getByTestId("community-page")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("button", { name: "general" })).toBeVisible();
    await expect(page.getByRole("button", { name: "bugs" })).toBeVisible();

    // Leave via the side-nav "Chat" link — this is the path the user
    // actually takes ("chat messages" in their words). Next.js client
    // nav, NOT a page.goto / full reload.
    //
    // Workspace-scoped routes now live under `/<wks_xxx>/...` (see
    // middleware.ts + app/[workspaceId]/), so the Chat tile's href is
    // `/<active workspace id>` rather than the bare `/`. We match on
    // the title attribute instead — the SideNav sets `title="Chat …"`
    // on every tile and a prefix match survives the optional shortcut
    // hint (`"Chat  ⌥C\nDrag to reorder"`) without breaking when keys
    // are remapped.
    await page
      .locator('[data-pane-name="left-nav"] a[title^="Chat"]')
      .first()
      .click();
    await expect(page).toHaveURL(/\/wks_[a-f0-9]{12}(?:$|\?)/);

    // Come back via the workspace-rail Community tile. Use the title
    // attribute (set by SystemTile via the `label` prop) instead of href
    // because Playwright sometimes picks up a prefetch <link> first when
    // matching on href alone. Wait for the chat page to settle before
    // clicking — the navigation completes async and clicking too soon can
    // land on a transient element.
    const communityTile = page.locator(
      '[data-pane-name="workspace-switcher"] a[href="/community"]',
    );
    await communityTile.waitFor({ state: "visible" });
    await communityTile.click();
    await expect(page).toHaveURL(/\/community/);

    // The bug: rooms list stays empty and WiFi-off. Assert the fix.
    await expect(page.getByTestId("community-page")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("button", { name: "general" })).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole("button", { name: "bugs" })).toBeVisible();
  });
});
