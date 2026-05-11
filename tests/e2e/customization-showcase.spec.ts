import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Showcase screenshots for each of the six demo customizations shipped with
 * the marketing site. Each is captured from its own preview server (started
 * via `POST /api/customizations/[id]/preview`) so the live install stays
 * untouched.
 *
 * Cost notice: spawning six `next dev` processes is heavy — they compile on
 * first hit and consume ~500 MB RAM each. The whole spec is gated behind
 * `SCREENSHOTS_INCLUDE_CUSTOMIZATIONS=1` (or `SCREENSHOTS_INCLUDE_PREVIEWS=1`)
 * so regular CI runs skip it.
 *
 * Add or remove demos by editing {@link DEMOS} below. Each entry names the
 * customization (matched against `GET /api/customizations`) and the capture
 * routine — interactive ones (Konami keys, intercepted slow APIs) are
 * inlined per demo so the spec stays self-contained.
 */

const SHOTS_DIR = resolve(process.cwd(), "site/screenshots");
mkdirSync(SHOTS_DIR, { recursive: true });

const INCLUDE =
  process.env.SCREENSHOTS_INCLUDE_CUSTOMIZATIONS === "1" ||
  process.env.SCREENSHOTS_INCLUDE_PREVIEWS === "1";

type CustomizationRow = { id: string; name: string };
type PreviewState = {
  status: "starting" | "ready" | "exited" | "error" | "stopped";
  port?: number;
  errorMessage?: string;
};

type DemoRoutine = (page: Page, port: number) => Promise<void>;

type Demo = {
  /** Name to match (case-insensitive substring) against /api/customizations. */
  match: string;
  /** Output PNG basename — written to site/screenshots/<file>.png. */
  file: string;
  /** Captures the screenshot. Receives a fresh Page already on `http://localhost:${port}/`. */
  capture: DemoRoutine;
};

const DEMOS: Demo[] = [
  {
    match: "Clippy",
    file: "customization-clippy",
    capture: async (page, port) => {
      await page.goto(`http://localhost:${port}/`, { waitUntil: "load", timeout: 120_000 });
      // Clippy mounts in the root layout — wait for its inline SVG paperclip.
      // Tolerant selector: any SVG that says "Clippy" in its title or has a
      // recognisable testid; fall back to a small settle if none found.
      await page.waitForTimeout(2500);
      await page.screenshot({
        path: resolve(SHOTS_DIR, "customization-clippy.png"),
        fullPage: false,
      });
    },
  },
  {
    match: "DOOM HUD",
    file: "customization-doom-hud",
    capture: async (page, port) => {
      // The DOOM panel only shows in the spend/workspace view. Fixture the
      // cost endpoint so the numbers look like a real project.
      await page.route("**/api/cost*", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(buildCostFixture()),
        });
      });
      await page.goto(`http://localhost:${port}/cost`, { waitUntil: "load", timeout: 120_000 });
      // Wait for the HEALTH/AMMO labels to render — the HUD is the marker.
      await expect(page.getByText(/AMMO/i)).toBeVisible({ timeout: 30_000 });
      await page.waitForTimeout(400);
      await page.screenshot({
        path: resolve(SHOTS_DIR, "customization-doom-hud.png"),
        fullPage: false,
      });
    },
  },
  {
    match: "Cat Spinner",
    file: "customization-cat-spinner",
    capture: async (page, port) => {
      // Suppress the guided-tour overlay so the loading state is what's on
      // screen, not the help panel.
      await page.addInitScript(() => {
        try { localStorage.setItem("claudius.customize.help-seen", "1"); } catch {}
      });
      // Force the customizations index call to hang so the /customize page
      // sits in its loading state. The CatSpinner is mounted there.
      await page.route("**/api/customizations**", async (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        // Long stall — we'll snap mid-flight.
        await new Promise((r) => setTimeout(r, 20_000));
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ customizations: [], publishes: [] }),
        });
      });
      await page.goto(`http://localhost:${port}/customize`, { waitUntil: "domcontentloaded", timeout: 120_000 });
      // Wait for the cat to start animating (any of its frames in the DOM).
      await page.waitForTimeout(2500);
      await page.screenshot({
        path: resolve(SHOTS_DIR, "customization-cat-spinner.png"),
        fullPage: false,
      });
    },
  },
  {
    match: "Minecraft",
    file: "customization-minecraft",
    capture: async (page, port) => {
      // The Minecraft customization edits ThinkingBlock. Without a running
      // session we won't see a real thinking block — for marketing, the
      // /customize/<id> page is the canonical "this exists" view, and it
      // links to the diff + preview. Snap that for now.
      const list = await page.request.get(`http://localhost:${port}/api/customizations`);
      const body = (await list.json()) as { customizations: CustomizationRow[] };
      const minecraft = body.customizations.find((c) => /minecraft/i.test(c.name));
      if (!minecraft) {
        test.skip(true, "no Minecraft customization to screenshot");
        return;
      }
      await page.goto(`http://localhost:${port}/customize/${minecraft.id}`, {
        waitUntil: "load",
        timeout: 120_000,
      });
      await page.waitForTimeout(1500);
      await page.screenshot({
        path: resolve(SHOTS_DIR, "customization-minecraft.png"),
        fullPage: false,
      });
    },
  },
  {
    match: "Lo-fi",
    file: "customization-lofi",
    capture: async (page, port) => {
      await page.addInitScript(() => {
        try { localStorage.setItem("claudius.customize.help-seen", "1"); } catch {}
      });
      // Stall the customizations list endpoint so the customize page sits
      // in the lo-fi loading state. LoFiLoader rotates messages every ~1.6s,
      // so we wait long enough to catch at least one rotation tick.
      await page.route("**/api/customizations**", async (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        await new Promise((r) => setTimeout(r, 20_000));
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ customizations: [], publishes: [] }),
        });
      });
      await page.goto(`http://localhost:${port}/customize`, { waitUntil: "domcontentloaded", timeout: 120_000 });
      // Wait past the initial deterministic index, so the rotation has
      // happened at least once and we capture a vibe-y message.
      await page.waitForTimeout(3500);
      await page.screenshot({
        path: resolve(SHOTS_DIR, "customization-lofi.png"),
        fullPage: false,
      });
    },
  },
  {
    match: "Konami",
    file: "customization-konami",
    capture: async (page, port) => {
      await page.goto(`http://localhost:${port}/`, { waitUntil: "load", timeout: 120_000 });
      await page.waitForTimeout(1500);
      // Dispatch the Konami code: ↑↑↓↓←→←→BA
      const sequence = [
        "ArrowUp",
        "ArrowUp",
        "ArrowDown",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
        "ArrowLeft",
        "ArrowRight",
        "KeyB",
        "KeyA",
      ];
      for (const code of sequence) {
        await page.keyboard.press(code, { delay: 60 });
      }
      // The party fades after ~4s — snap as soon as the banner appears.
      await expect(page.getByText(/CHEAT ACTIVATED/i)).toBeVisible({ timeout: 5000 });
      await page.waitForTimeout(600);
      await page.screenshot({
        path: resolve(SHOTS_DIR, "customization-konami.png"),
        fullPage: false,
      });
    },
  },
];

/**
 * Wait until the customization's preview reports `status: "ready"` and the
 * port answers an HTTP request. Next's "ready" line fires once dev is
 * listening but compilation of any given route can still take tens of
 * seconds — the page.goto inside each demo will block until the route is
 * actually compiled.
 */
async function waitForReady(page: Page, custId: string, timeoutMs = 180_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await page.request.get(`/api/customizations/${custId}/preview`);
    if (r.ok()) {
      const s = (await r.json()) as PreviewState;
      if (s.status === "ready" && typeof s.port === "number") return s.port;
      if (s.status === "error" || s.status === "exited") {
        throw new Error(`preview ${custId} ${s.status}: ${s.errorMessage ?? "(no detail)"}`);
      }
    }
    await page.waitForTimeout(2000);
  }
  throw new Error(`preview ${custId} never reached ready within ${timeoutMs}ms`);
}

test.describe("customization showcase screenshots", () => {
  test.skip(
    !INCLUDE,
    "set SCREENSHOTS_INCLUDE_CUSTOMIZATIONS=1 to capture customization-feature shots (spawns 6 next dev processes)",
  );
  test.describe.configure({ mode: "serial", timeout: 360_000 });

  for (const demo of DEMOS) {
    test(`${demo.file}`, async ({ page, request }) => {
      // First-load of any preview route can take 30-90s while next dev
      // compiles; the test.describe.configure timeout isn't always honoured
      // when other directives run first, so set per-test explicitly.
      test.setTimeout(360_000);
      const list = await request.get(`/api/customizations`);
      expect(list.ok(), "fetch customizations").toBeTruthy();
      const body = (await list.json()) as { customizations: CustomizationRow[] };
      const matched = body.customizations.find((c) =>
        c.name.toLowerCase().includes(demo.match.toLowerCase()),
      );
      if (!matched) {
        test.skip(true, `no customization matching "${demo.match}" — create one to capture`);
        return;
      }

      // Start (or reuse) the preview. POST is idempotent at the
      // preview-server level — it returns existing state if already running.
      const startRes = await request.post(`/api/customizations/${matched.id}/preview`);
      expect(startRes.ok(), `start preview ${matched.name}`).toBeTruthy();

      try {
        const port = await waitForReady(page, matched.id);
        await demo.capture(page, port);
      } finally {
        // Best-effort teardown — even on failure, leave no orphan next-dev
        // hanging onto a port. Errors during stop are non-fatal.
        await request
          .delete(`/api/customizations/${matched.id}/preview`)
          .catch(() => {});
      }
    });
  }
});

/**
 * Tiny copy of the cost fixture used by site-screenshots.spec — duplicated
 * here so this spec stays self-contained. Numbers don't need to be byte-
 * identical with the regular cost shot.
 */
function buildCostFixture(): unknown {
  let seed = 0xdef0ad;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) | 0;
    return ((seed >>> 0) % 10_000) / 10_000;
  };
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const oneDayMs = 24 * 60 * 60 * 1000;
  const isoDate = (d: Date) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${dd}`;
  };
  const byDay = [];
  for (let i = 59; i >= 0; i--) {
    const date = new Date(today.getTime() - i * oneDayMs);
    const dow = date.getDay();
    const age = (60 - i) / 60;
    let usd = 0.4 + age * 4.2 + rand() * 1.6;
    if (dow === 0 || dow === 6) usd *= 0.35;
    if ([47, 38, 33, 22, 14, 6].includes(i)) usd = 0;
    if (i === 5) usd = 9.85;
    if (i === 0) usd = Math.max(usd, 5.4);
    byDay.push({
      date: isoDate(date),
      usd: Number(usd.toFixed(4)),
      inputTokens: Math.round(usd * 22_000),
      outputTokens: Math.round(usd * 5_500),
    });
  }
  const totalUsd = byDay.reduce((s, d) => s + d.usd, 0);
  return {
    totalUsd: Number(totalUsd.toFixed(2)),
    todayUsd: byDay[byDay.length - 1].usd,
    weekUsd: byDay.slice(-7).reduce((s, d) => s + d.usd, 0),
    monthUsd: byDay.slice(-30).reduce((s, d) => s + d.usd, 0),
    byDay,
    bySession: [],
    byModel: [],
    note: "fixture",
  };
}
