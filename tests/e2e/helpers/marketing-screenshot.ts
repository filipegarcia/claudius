/**
 * Gate marketing-screenshot writes behind `UPDATE_SCREENSHOTS=1`.
 *
 * Several e2e specs (chat-screenshots.spec.ts and the customization-*.spec.ts
 * family) double as marketing-image producers — they navigate to a fixture
 * page, assert it renders, and snap a PNG into `site/screenshots/`. The
 * navigation + assertion half is useful regression coverage and stays
 * enabled by default. The disk write, however, was clobbering committed
 * marketing images on every plain `bun run test:e2e` run — sometimes with
 * byte-identical bytes (no git diff), sometimes with a subtly different
 * crop or theme that landed in the working tree as an unintended change.
 *
 * Default behaviour now:
 *   - `bun run test:e2e`                            → tests run, no PNGs written
 *   - `UPDATE_SCREENSHOTS=1 bun run test:e2e`       → tests run, PNGs refreshed
 *   - `bun run test:e2e:screenshots`                → shortcut for the above
 *
 * This flag is read once at module load. Vitest / Playwright don't reload
 * the test file between specs in the same run, so the value stays stable
 * for the whole `playwright test` invocation.
 */
export const UPDATE_SCREENSHOTS = process.env.UPDATE_SCREENSHOTS === "1";
