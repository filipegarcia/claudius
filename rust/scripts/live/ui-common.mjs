// Shared helpers for the live UI smokes (Playwright against the Rust front door).
import { chromium } from "playwright";

/** Open the app, wait for an enabled composer, and track /api failures. */
export async function openApp(base) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const apiFailures = [];
  page.on("response", (r) => {
    const path = new URL(r.url()).pathname;
    // >= 500 includes the Rust 501 "not ported" guard; 4xx can be legitimate.
    if (path.startsWith("/api/") && r.status() >= 500) apiFailures.push(`${r.status()} ${r.request().method()} ${path}`);
  });
  page.on("pageerror", (e) => console.log(`  ! pageerror: ${e.message}`));
  // For a page that never settles (TODO I37: once, the page reloaded itself
  // ~90 times): the console says whether Next's dev client or the app reloaded it.
  const consoleTail = [];
  page.on("console", (m) => {
    consoleTail.push(`${new Date().toISOString().slice(11, 23)} ${m.type()}: ${m.text().slice(0, 300)}`);
    if (consoleTail.length > 60) consoleTail.shift();
  });
  await page.goto(base + "/");
  const composer = page.getByTestId("prompt-input");
  try {
    await composer.waitFor({ state: "visible", timeout: 120_000 });
  } catch (e) {
    console.log(`  ! no composer at ${page.url()}; the page's last console lines:\n    ${consoleTail.join("\n    ")}`);
    throw e;
  }
  await page.waitForFunction(() => !document.querySelector('[data-testid="prompt-input"]')?.disabled, null, {
    timeout: 60_000,
  });
  return { browser, page, composer, apiFailures };
}

export async function send(page, composer, text) {
  await composer.fill(text);
  await page.getByTestId("prompt-send").click();
}

export function assertNoApiFailures(apiFailures) {
  if (apiFailures.length) throw new Error(`/api responses >= 500:\n  ${[...new Set(apiFailures)].join("\n  ")}`);
}
