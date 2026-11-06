import { test, expect, type Page } from "../helpers/test";

const SESSION_RE = /[?&]session=([0-9a-f-]{36})/i;

async function waitForBoundSession(page: Page): Promise<string> {
  await page.waitForURL((url) => SESSION_RE.test(String(url)), { timeout: 30_000 });
  const id = page.url().match(SESSION_RE)?.[1];
  expect(id).toMatch(/^[0-9a-f-]{36}$/i);
  return id!;
}

/** The label `formatBinding` renders for the default ⌘⌥T / Ctrl+Alt+T chord. */
async function defaultRenameLabel(page: Page): Promise<string> {
  const mac = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform));
  return mac ? "⌘⌥T" : "Ctrl+Alt+T";
}

/**
 * The session title row (RecapBanner) advertises the `session.focusTitle`
 * rename chord: hovering the name, its icon, or the pencil shows it in the
 * tooltip, and a <kbd> chip fades in beside the pencil. The hint tracks the
 * live (rebindable) binding and disappears when the binding is disabled.
 */
test.describe("Session title rename shortcut hint", () => {
  test("hovering the title row reveals the rename chord, and the chord opens the editor", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForBoundSession(page);
    await expect(page.getByTestId("prompt-input")).toBeVisible({ timeout: 30_000 });

    const label = await defaultRenameLabel(page);
    const banner = page.getByTestId("recap-banner");
    await expect(banner).toBeVisible({ timeout: 15_000 });

    // Native tooltips on the name, the icon, and the pencil carry the chord.
    await expect(page.getByTestId("recap-banner-button")).toHaveAttribute(
      "title",
      new RegExp(`\\(${escapeRe(label)}\\)$`),
    );
    await expect(page.getByTestId("recap-banner-icon")).toHaveAttribute(
      "title",
      `Rename session (${label})`,
    );
    await expect(page.getByTestId("recap-rename-button")).toHaveAttribute(
      "title",
      new RegExp(`\\(${escapeRe(label)}\\)$`),
    );

    // The visible chip is hidden until the row is hovered.
    const chip = page.getByTestId("recap-rename-shortcut");
    await expect(chip).toHaveText(label);
    await expect(chip).toHaveCSS("opacity", "0");
    await page.getByTestId("recap-banner-title").hover();
    await expect(chip).toHaveCSS("opacity", "1");

    // The advertised chord actually opens the inline rename editor.
    await page.keyboard.press("ControlOrMeta+Alt+KeyT");
    await expect(page.getByTestId("recap-title-input")).toBeVisible();
    await expect(page.getByTestId("recap-title-input")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("recap-title-input")).toBeHidden();
  });

  test("the hint follows a rebound chord and disappears when the binding is disabled", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForBoundSession(page);

    const mac = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform));

    // Rebind to ⌘⇧E / Ctrl+Shift+E — the hint must reflect the override.
    await page.evaluate(() => {
      localStorage.setItem(
        "claudius.shortcuts.v1",
        JSON.stringify({ "session.focusTitle": { mod: true, shift: true, code: "KeyE" } }),
      );
    });
    await page.reload();
    await waitForBoundSession(page);
    const reboundLabel = mac ? "⌘⇧E" : "Ctrl+Shift+E";
    await expect(page.getByTestId("recap-rename-shortcut")).toHaveText(reboundLabel, {
      timeout: 15_000,
    });
    await expect(page.getByTestId("recap-banner-icon")).toHaveAttribute(
      "title",
      `Rename session (${reboundLabel})`,
    );

    // Disable it — no chip, and the tooltips stop advertising a dead chord.
    await page.evaluate(() => {
      localStorage.setItem(
        "claudius.shortcuts.v1",
        JSON.stringify({ "session.focusTitle": null }),
      );
    });
    await page.reload();
    await waitForBoundSession(page);
    await expect(page.getByTestId("recap-banner")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("recap-rename-shortcut")).toHaveCount(0);
    await expect(page.getByTestId("recap-banner-icon")).toHaveAttribute("title", "Rename session");

    await page.evaluate(() => localStorage.removeItem("claudius.shortcuts.v1"));
  });
});

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
