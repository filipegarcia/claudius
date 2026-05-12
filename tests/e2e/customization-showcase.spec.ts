import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Showcase screenshots for each of the demo customizations shipped with the
 * marketing site. Each is captured from its own preview server (started via
 * `POST /api/customizations/[id]/preview`) so the live install stays
 * untouched. The Synthwave customization is a theme-only change with no
 * runtime behaviour, so it gets its own simpler spec
 * (customization-synthwave.spec.ts) that drives the live dev server.
 *
 * Cost notice: spawning multiple `next dev` processes is heavy — they
 * compile on first hit and consume ~500 MB RAM each. The whole spec is
 * gated behind `SCREENSHOTS_INCLUDE_CUSTOMIZATIONS=1` (or
 * `SCREENSHOTS_INCLUDE_PREVIEWS=1`) so regular CI runs skip it.
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
      // Start a fresh session tab so the screenshot lands on the clean
      // "Claudius" welcome screen (prompt-suggestion chips visible) rather
      // than whichever stale conversation was last open in the preview
      // DB. The "+" button in <SessionTabs> creates a new untitled session
      // and selects it.
      const newTabBtn = page.getByTitle("New session tab");
      if (await newTabBtn.count()) {
        await newTabBtn.first().click({ trial: false }).catch(() => {});
        await page.waitForTimeout(1500);
      }
      // Older preview-DB state can carry a stale session ID whose SDK
      // conversation no longer exists; the Anthropic SDK then surfaces a
      // "No conversation found with session ID …" error inside the chat
      // pane. That's a noisy artefact for a marketing shot. Strip any
      // element whose visible text mentions the error before we snap.
      await page.evaluate(() => {
        const needles = [
          "No conversation found with session ID",
          "Claude Code returned an error result",
        ];
        const isBanner = (el: HTMLElement) => {
          const c = el.className || "";
          if (typeof c !== "string") return false;
          return /red-500|red-400|red-300/.test(c);
        };
        document.querySelectorAll<HTMLElement>("body *").forEach((el) => {
          if (el.children.length > 0) return;
          const t = (el.textContent ?? "").trim();
          if (!t) return;
          if (!needles.some((n) => t.includes(n))) return;
          // Walk up to the nearest red-styled banner container; if none,
          // just hide the text node itself.
          let cur: HTMLElement | null = el;
          for (let i = 0; i < 6 && cur; i++) {
            if (isBanner(cur)) {
              cur.style.display = "none";
              return;
            }
            cur = cur.parentElement;
          }
          el.style.display = "none";
        });
      });
      await page.waitForTimeout(150);
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
