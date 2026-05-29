import { test, expect, type Page } from "../helpers/test";
import sharp from "sharp";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * On-demand showcase: capture the two goal states from the REAL app driven with
 * MOCKED data (no live agent) — the goal is set via the goal API, and the
 * "achieved" state via the dev-broadcast endpoint that mirrors what
 * `Session.markGoalAchieved` emits. Both `session-header` snapshots are then
 * composited (with sharp) into one stacked image with captions.
 *
 * Output: site/screenshots/goal-set.png, goal-achieved.png, goal-states.png
 * Run: bun run test:e2e tests/e2e/goal-showcase.spec.ts
 */

const SHOTS_DIR = resolve(process.cwd(), "site/screenshots");
const GOAL_TEXT = "Fix the Electron app icon and build target so make electron-app works";
const SUMMARY =
  "Forced NODE_ENV=production in the build scripts and added the missing author, " +
  "description, and main fields to package.json, so electron-builder now produces a " +
  "valid Claudius.app carrying the terracotta icon.";

const SESSION_RE = /[?&]session=([0-9a-f-]{36})/i;

async function waitForBoundSession(page: Page): Promise<string> {
  await page.waitForURL((url) => SESSION_RE.test(String(url)), { timeout: 30_000 });
  return page.url().match(SESSION_RE)![1]!;
}

/** A full-width caption band as an SVG buffer, sized to `width`. */
function caption(width: number, badge: string, label: string): Buffer {
  const h = 48;
  const svg = `<svg width="${width}" height="${h}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="#0a0a0a"/>
    <text x="20" y="31" font-family="ui-sans-serif, system-ui, sans-serif" font-size="15" font-weight="700" fill="#d97757">${badge}</text>
    <text x="${20 + badge.length * 10 + 12}" y="31" font-family="ui-sans-serif, system-ui, sans-serif" font-size="15" fill="#e5e5e5">${label}</text>
  </svg>`;
  return Buffer.from(svg);
}

test("goal showcase: set + achieved composite", async ({ page, request, baseURL }) => {
  mkdirSync(SHOTS_DIR, { recursive: true });

  await page.goto("/");
  const sessionId = await waitForBoundSession(page);
  await expect(page.getByTestId("prompt-input")).toBeVisible({ timeout: 30_000 });

  const header = page.getByTestId("session-header");

  // ── State 1: goal set (mocked via the goal API, no agent turn) ────────────
  const setStatus = await page.evaluate(
    async ({ id, goal }) => {
      const r = await fetch(`/api/sessions/${id}/goal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goal }),
      });
      return r.status;
    },
    { id: sessionId, goal: GOAL_TEXT },
  );
  expect(setStatus).toBe(200);

  const banner = page.getByTestId("goal-banner");
  await expect(banner).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("goal-banner-text")).toHaveText(GOAL_TEXT);
  await expect(banner).toHaveAttribute("data-achieved", "0");
  await page.waitForTimeout(250);
  const setShot = await header.screenshot({ path: resolve(SHOTS_DIR, "goal-set.png") });

  // ── State 2: goal achieved (mocked via dev-broadcast) ─────────────────────
  const res = await request.post(`${baseURL}/api/sessions/${sessionId}/dev-broadcast`, {
    data: {
      event: {
        type: "goal_changed",
        goal: GOAL_TEXT,
        achieved: true,
        summary: SUMMARY,
        setAt: Date.now(),
        achievedAt: Date.now(),
      },
    },
  });
  expect(res.ok()).toBeTruthy();

  await expect(banner).toHaveAttribute("data-achieved", "1", { timeout: 15_000 });
  await expect(page.getByTestId("goal-banner-summary")).toHaveText(SUMMARY);
  await page.waitForTimeout(250);
  const doneShot = await header.screenshot({ path: resolve(SHOTS_DIR, "goal-achieved.png") });

  // ── Composite the two states into one stacked image ───────────────────────
  const m1 = await sharp(setShot).metadata();
  const m2 = await sharp(doneShot).metadata();
  const width = Math.max(m1.width!, m2.width!);
  const capH = 48;
  const gap = 20;
  const pad = 16;
  const h1 = m1.height!;
  const h2 = m2.height!;
  const totalH = pad + capH + h1 + gap + capH + h2 + pad;

  let y = pad;
  const layers: sharp.OverlayOptions[] = [];
  layers.push({ input: caption(width, "1", "Setting a goal — Claude starts working on it"), top: y, left: 0 });
  y += capH;
  layers.push({ input: setShot, top: y, left: 0 });
  y += h1 + gap;
  layers.push({ input: caption(width, "2", "Goal achieved — reported by the agent"), top: y, left: 0 });
  y += capH;
  layers.push({ input: doneShot, top: y, left: 0 });

  const outPath = resolve(SHOTS_DIR, "goal-states.png");
  await sharp({
    create: { width, height: totalH, channels: 4, background: "#0a0a0a" },
  })
    .composite(layers)
    .png()
    .toFile(outPath);

  // Sanity: the composite exists and is the size we laid out.
  const out = await sharp(outPath).metadata();
  expect(out.width).toBe(width);
  expect(out.height).toBe(totalH);
});
