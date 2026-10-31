// Live UI smoke: permission card → Allow once → the tool really runs.
// usage: node permission.mjs <baseUrl> <outDir> <projectCwd>
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { assertNoApiFailures, openApp, send } from "./ui-common.mjs";

const [base, out, cwd] = process.argv.slice(2);
const proof = join(cwd, "rs-perm-ui-proof.txt");
rmSync(proof, { force: true });
const { browser, page, composer, apiFailures } = await openApp(base);
try {
  await send(page, composer, "Use the Bash tool to run exactly: touch rs-perm-ui-proof.txt — then reply DONE.");
  const allow = page.getByRole("button", { name: "Allow once" });
  await allow.waitFor({ timeout: 120_000 });
  if (existsSync(proof)) throw new Error("proof file exists before Allow once");
  console.log("  ✓ permission card shown");
  await page.screenshot({ path: `${out}/ui-perm-card.png` });
  await allow.click();
  await page.getByText("DONE", { exact: true }).first().waitFor({ timeout: 120_000 });
  if (!existsSync(proof)) throw new Error("Allow once clicked but the command did not run");
  console.log("  ✓ Allow once → Bash ran → DONE rendered");
  await page.screenshot({ path: `${out}/ui-perm-done.png` });
  assertNoApiFailures(apiFailures);
  console.log("  ✓ no /api responses >= 500");
} finally {
  await browser.close();
}
