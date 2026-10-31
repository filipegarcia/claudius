// Live UI smoke: prompt → rendered reply → reload replays the transcript.
// usage: node pong.mjs <baseUrl> <outDir>
import { assertNoApiFailures, openApp, send } from "./ui-common.mjs";

const [base, out] = process.argv.slice(2);
const { browser, page, composer, apiFailures } = await openApp(base);
try {
  await send(page, composer, "Reply with exactly the word PONG and nothing else.");
  await page.getByText("PONG", { exact: true }).first().waitFor({ timeout: 120_000 });
  console.log("  ✓ PONG rendered");
  await page.screenshot({ path: `${out}/ui-pong.png` });
  await page.reload();
  await page.getByText("PONG", { exact: true }).first().waitFor({ timeout: 60_000 });
  console.log("  ✓ PONG survives reload (replay from the Rust session)");
  await page.screenshot({ path: `${out}/ui-reload.png` });
  assertNoApiFailures(apiFailures);
  console.log("  ✓ no /api responses >= 500");
} finally {
  await browser.close();
}
