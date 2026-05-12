import { test, expect, type ConsoleMessage } from "@playwright/test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Runtime smoke for `site/index.html` — the marketing surface published to
 * GitLab Pages on every push to main. The static integrity (anchor targets,
 * referenced screenshots exist, repo URLs match setup.sh) is covered by
 * `tests/unit/site-static.test.ts`; this spec adds the bits only a real
 * browser can verify: lightbox open/close, install-copy button, anchor
 * smooth-scroll, and "the page doesn't blow up at load."
 *
 * Loads the file directly via `file://` so the test doesn't need an HTTP
 * server. The static page has no fetches, only inline CDN scripts
 * (Tailwind Play), so `file://` is enough to exercise every interactive
 * surface. If you ever add a network-dependent feature, swap in a real
 * static server.
 *
 * If you're adding new content to the site, see `site/AGENTS.md`.
 */
const SITE_INDEX = pathToFileURL(
  resolve(process.cwd(), "site/index.html"),
).toString();

/** Filter for console messages we treat as actually broken. */
function isFatal(msg: ConsoleMessage): boolean {
  if (msg.type() !== "error") return false;
  const text = msg.text();
  // Tailwind's Play CDN logs a "should not be used in production" warning
  // at runtime — informational, not a defect.
  if (text.includes("cdn.tailwindcss.com should not be used in production")) {
    return false;
  }
  return true;
}

test.describe("site/index.html — marketing page runtime smoke", () => {
  test("loads cleanly with no fatal console errors", async ({ page }) => {
    const fatal: string[] = [];
    page.on("console", (m) => {
      if (isFatal(m)) fatal.push(`[${m.type()}] ${m.text()}`);
    });
    page.on("pageerror", (e) => fatal.push(`[pageerror] ${e.message}`));

    await page.goto(SITE_INDEX);

    // Every top-nav section is laid out before user interaction. Asserting
    // visibility (not just presence) ensures the page actually paints — a
    // CSS regression that hides #install would otherwise sail through a
    // pure static lint.
    for (const id of ["top", "install", "features", "gallery", "customize", "meta"]) {
      await expect(
        page.locator(`#${id}`),
        `section #${id} should be visible`,
      ).toBeVisible();
    }

    expect(fatal, `console errors at load: ${fatal.join(" | ")}`).toEqual([]);
  });

  test("install-copy button toggles its label after a click", async ({
    page,
    context,
    browserName,
  }) => {
    // Grant clipboard-write so navigator.clipboard.writeText resolves in
    // Chromium; on browsers where the permission doesn't exist (Firefox,
    // WebKit), the page's catch-block fallback kicks in and the button text
    // becomes "Press ⌘/Ctrl-C" — still a positive signal that the handler
    // ran. We accept either.
    if (browserName === "chromium") {
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    }

    await page.goto(SITE_INDEX);
    const btn = page.locator("#install-copy");
    await expect(btn).toHaveText("Copy");
    await btn.click();
    await expect(btn).toHaveText(/^(Copied|Press ⌘\/Ctrl-C)$/);
  });

  test("opens the lightbox when a gallery shot is activated, closes on Esc", async ({
    page,
  }) => {
    await page.goto(SITE_INDEX);
    const dialog = page.locator("#lightbox");
    await expect(dialog).toBeAttached();
    // <dialog> without `open` doesn't render — `toBeVisible` would be false.
    await expect(dialog).toBeHidden();

    // Click any figure.shot — the first one is in the hero gallery.
    const firstShot = page.locator("figure.shot").first();
    await expect(firstShot).toBeVisible();
    await firstShot.click();

    await expect(dialog).toBeVisible();
    // Lightbox image must inherit a src — the page reads it off the figure's
    // <img> at click time. An empty src would mean the bridging code broke.
    await expect(page.locator("#lightbox-img")).toHaveAttribute("src", /\.(png|svg)$/);

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });

  test("nav anchors follow to the matching section and update the URL hash", async ({
    page,
  }) => {
    await page.goto(SITE_INDEX);
    // Click each top-nav link and assert the URL fragment lands on the
    // advertised id. We don't measure scroll position — `scroll-behavior:
    // smooth` makes the animation race against any synchronous getBoundingRect
    // check, and the hash-update is what actually proves the anchor was
    // honoured (and that the matching id exists in the page — covered too
    // by the static suite, but a different angle here is cheap).
    const navTargets: Array<[string, string]> = [
      ["Install", "install"],
      ["Features", "features"],
      ["Screenshots", "gallery"],
      ["Customize", "customize"],
    ];
    for (const [label, id] of navTargets) {
      await page.getByRole("link", { name: label, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`#${id}$`));
    }
  });
});
