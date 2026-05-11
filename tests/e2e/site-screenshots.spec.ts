import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Captures screenshots used by the marketing site (site/index.html). The
 * static routes don't need an API key and run in seconds. The three chat
 * captures (empty, todos banner, AskUserQuestion modal) drive the live agent
 * and need ANTHROPIC_API_KEY (or ~/.claude/.credentials.json) — they are
 * gated by SCREENSHOTS_INCLUDE_CHAT=1 so a quick local run can skip them.
 *
 * Run all of them: `make screenshots-full`
 * Run only the cheap ones: `make screenshots`
 *
 * All shots are taken inside the "claudius" workspace so the chrome (tab
 * strip, side nav, file tree) reflects this project rather than whichever
 * workspace happened to be active in the dev server.
 */

const SHOTS_DIR = resolve(process.cwd(), "site/screenshots");
mkdirSync(SHOTS_DIR, { recursive: true });

const SESSION_RE = /[?&]session=([0-9a-f-]{36})/i;
const INCLUDE_CHAT = process.env.SCREENSHOTS_INCLUDE_CHAT === "1";

type WorkspaceSummary = {
  id: string;
  name: string;
  rootPath: string;
};

/**
 * Switch the active workspace to "claudius" — matched by name, then by
 * rootPath so the spec works on any machine that has the project cloned.
 * The /select endpoint sets a cookie that page.request shares with the
 * browser context, so subsequent navigations land in the right workspace.
 */
async function activateClaudiusWorkspace(page: Page) {
  const list = await page.request
    .get("/api/workspaces")
    .then((r) => r.json() as Promise<{ workspaces: WorkspaceSummary[] }>);
  const cwd = process.cwd();
  const ws =
    list.workspaces.find((w) => w.name === "claudius") ??
    list.workspaces.find((w) => w.rootPath === cwd);
  if (!ws) {
    throw new Error(
      `No "claudius" workspace found. Create one via /workspace or POST /api/workspaces with rootPath=${cwd}.`,
    );
  }
  const res = await page.request.post(`/api/workspaces/${ws.id}/select`);
  expect(res.ok(), "selecting the claudius workspace should succeed").toBeTruthy();
}

async function snap(page: Page, name: string) {
  await page.screenshot({
    path: resolve(SHOTS_DIR, `${name}.png`),
    fullPage: false,
  });
}

async function gotoStable(page: Page, path: string, opts?: { networkIdle?: boolean }) {
  // Pages that mount `useSession` open a long-lived SSE stream that keeps
  // the network "active" forever, so `networkidle` never fires. For those,
  // fall back to `load`. Static read-only pages still benefit from
  // networkidle waiting for the initial data fetches to settle.
  const waitUntil = opts?.networkIdle === false ? "load" : "networkidle";
  await page.goto(path, { waitUntil });
  // Tiny settle for transitions/skeletons.
  await page.waitForTimeout(400);
}

/**
 * Open the chat on a brand-new session inside the active workspace.
 * Each chat shot needs this — landing on `/` resumes the last-active tab,
 * which may still be mid-processing earlier prompts and would queue ours
 * behind that backlog instead of running fresh.
 */
async function freshChatSession(page: Page): Promise<string> {
  await page.goto("/");
  await page.waitForURL(SESSION_RE, { timeout: 30_000 });
  const resumedId = page.url().match(SESSION_RE)![1];
  await page.locator('button[title="New session tab"]').click();
  await page.waitForURL(
    (url) => {
      const m = String(url).match(SESSION_RE);
      return !!m && m[1] !== resumedId;
    },
    { timeout: 30_000 },
  );
  return page.url().match(SESSION_RE)![1];
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test.describe("site screenshots — static routes", () => {

  for (const [name, path] of [
    ["sessions", "/sessions"],
    ["agents", "/agents"],
    ["skills", "/skills"],
    ["mcp", "/mcp"],
    ["plugins", "/plugins"],
    ["cost", "/cost"],
    ["git", "/git"],
    ["files", "/files"],
    ["workspace", "/workspace"],
  ] as const) {
    test(`${name}`, async ({ page }) => {
      // The cost page reads /api/cost. On a fresh project there's no
      // history to aggregate, so the chart looks empty and uninteresting
      // for marketing purposes. Inject a hand-crafted CostReport for the
      // screenshot run only — production code is untouched.
      if (name === "cost") {
        await page.route("**/api/cost*", async (route) => {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(buildCostFixture()),
          });
        });
      }
      await gotoStable(page, path);

      // Open the first agent so the right pane shows its frontmatter and
      // body — the empty "Pick an agent" state is dull for marketing.
      // Falls back to the first agent button if "code-reviewer" isn't
      // present on this machine.
      if (name === "agents") {
        const named = page.getByRole("button", { name: /^code-reviewer/ });
        const target = (await named.count()) > 0 ? named.first() : page.locator("li button").first();
        await target.click();
        await page.waitForTimeout(400);
      }

      // Git: open a changed file so the right pane shows a real diff.
      // Prefer site/index.html (lots of marketing-site churn) and fall
      // back to the first changed-file row.
      if (name === "git") {
        const preferred = page.locator("button", { hasText: "site/index.html" });
        const target =
          (await preferred.count()) > 0 ? preferred.first() : page.locator("ul li button").first();
        await target.click();
        await page.waitForTimeout(700); // diff fetch
      }

      // Files: open a readable file so the right pane shows content.
      // README.md is the most universally meaningful project file.
      if (name === "files") {
        await page.getByRole("button", { name: /README\.md/ }).first().click();
        await page.waitForTimeout(600);
      }


      await snap(page, name);
    });
  }
});

/**
 * Hand-crafted, deterministic 60-day cost report for the marketing
 * screenshot. Designed to look like a project that's been ramping up:
 *  - sparse for the first few weeks
 *  - mid-period plateau with a few larger work sessions
 *  - steady upward trend in the most recent 14 days, peaking today
 *  - realistic weekend dips (lower spend on Sat/Sun)
 *  - one busy outlier near the end (multi-hour debugging marathon)
 *  - zero on a handful of days (vacation / weekend)
 */
function buildCostFixture(): unknown {
  // Deterministic PRNG so the fixture is byte-identical across runs.
  let seed = 0xc0ffee;
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

  const byDay: Array<{ date: string; usd: number; inputTokens: number; outputTokens: number }> = [];
  for (let i = 59; i >= 0; i--) {
    const date = new Date(today.getTime() - i * oneDayMs);
    const dow = date.getDay(); // 0 = Sun
    const ageBoost = (60 - i) / 60; // 0..1, today = 1
    // Base trend grows with recency; weekends muted.
    let usd = 0.4 + ageBoost * 4.2 + rand() * 1.6;
    if (dow === 0 || dow === 6) usd *= 0.35;
    // A few zero days for realism.
    if ([47, 38, 33, 22, 14, 6].includes(i)) usd = 0;
    // One big outlier ~5 days back.
    if (i === 5) usd = 9.85;
    // Today is a strong day — the user just opened the page.
    if (i === 0) usd = Math.max(usd, 5.4);
    const inputTokens = Math.round(usd * 22_000 + rand() * 4000);
    const outputTokens = Math.round(usd * 5_500 + rand() * 1500);
    byDay.push({ date: isoDate(date), usd: Number(usd.toFixed(4)), inputTokens, outputTokens });
  }

  const totalUsd = byDay.reduce((s, d) => s + d.usd, 0);
  const todayUsd = byDay[byDay.length - 1].usd;
  const weekUsd = byDay.slice(-7).reduce((s, d) => s + d.usd, 0);
  const monthUsd = byDay.slice(-30).reduce((s, d) => s + d.usd, 0);

  // 14 fake sessions spread across the last few weeks.
  const sessionTitles = [
    "Refactor permissions UI",
    "Wire up MCP server",
    "Hook event browser",
    "Fix tab overflow chevron",
    "Cost page polish",
    "AskUserQuestion form",
    "Workspace defaults",
    "Schedule cron editor",
    "Activity rail widgets",
    "Git diff viewer",
    "Plan-mode banner",
    "Session resume bug",
    "Sessions DB index",
    "Marketing landing page",
  ];
  const models = ["claude-sonnet-4-6", "claude-opus-4-7", "claude-haiku-4-5"];
  const bySession = sessionTitles.map((_title, i) => {
    const lastSeenAge = Math.floor(rand() * 35); // days back
    const lastSeenMs = today.getTime() - lastSeenAge * oneDayMs;
    const firstSeenMs = lastSeenMs - Math.floor(rand() * 4 * 60 * 60 * 1000); // up to 4h earlier
    return {
      sessionId: `${(0xa00 + i).toString(16).padStart(8, "0")}-feed-4f00-9a00-${(0xc000 + i).toString(16).padStart(12, "0")}`,
      firstSeenMs,
      lastSeenMs,
      numTurns: 4 + Math.floor(rand() * 26),
      totalUsd: Number((0.6 + rand() * 11.4).toFixed(3)),
      model: models[Math.floor(rand() * models.length)],
    };
  });

  // Per-model breakdown summing to roughly totalUsd.
  const byModel = [
    {
      model: "claude-sonnet-4-6",
      usd: Number((totalUsd * 0.62).toFixed(3)),
      inputTokens: 1_840_000,
      outputTokens: 412_000,
      cacheReadTokens: 1_120_000,
      cacheWriteTokens: 88_000,
    },
    {
      model: "claude-opus-4-7",
      usd: Number((totalUsd * 0.31).toFixed(3)),
      inputTokens: 720_000,
      outputTokens: 184_000,
      cacheReadTokens: 410_000,
      cacheWriteTokens: 36_000,
    },
    {
      model: "claude-haiku-4-5",
      usd: Number((totalUsd * 0.07).toFixed(3)),
      inputTokens: 360_000,
      outputTokens: 92_000,
      cacheReadTokens: 180_000,
      cacheWriteTokens: 14_000,
    },
  ];

  return {
    totalUsd: Number(totalUsd.toFixed(2)),
    todayUsd: Number(todayUsd.toFixed(2)),
    weekUsd: Number(weekUsd.toFixed(2)),
    monthUsd: Number(monthUsd.toFixed(2)),
    byDay,
    bySession: bySession.sort((a, b) => b.lastSeenMs - a.lastSeenMs),
    byModel,
    note: "Project-local from on-disk session JSONLs.",
  };
}

test.describe("site screenshots — chat states", () => {
  test.skip(!INCLUDE_CHAT, "set SCREENSHOTS_INCLUDE_CHAT=1 to capture chat shots (uses real API)");

  test("chat — empty surface", async ({ page }) => {
    await freshChatSession(page);
    await expect(page.getByTestId("prompt-input")).toBeEnabled({ timeout: 30_000 });
    await expect(page.getByTestId("prompt-send")).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(500);
    await snap(page, "chat");
  });

  test("chat — todos banner", async ({ page, baseURL }) => {
    test.setTimeout(360_000);
    const sessionId = await freshChatSession(page);

    const textarea = page.getByTestId("prompt-input");
    await expect(textarea).toBeEnabled({ timeout: 30_000 });
    await expect(page.getByTestId("prompt-send")).toBeVisible({ timeout: 30_000 });

    // Bypass permissions so TodoWrite doesn't pop a prompt.
    const modeRes = await page.request.post(
      `${baseURL}/api/sessions/${sessionId}/mode`,
      { data: { mode: "bypassPermissions" } },
    );
    expect(modeRes.ok()).toBeTruthy();

    // Bootstrap: a natural-sounding planning request that organically
    // produces the todos banner. We then send a follow-up turn so the
    // bootstrap message scrolls off the top of the chat by the time we
    // snap — the marketing shot shows the banner pinned + a clean
    // mid-conversation state, not a mechanical test prompt.
    const bootstrapPrompt = [
      "Plan the rollout of the Claudius marketing site. Track these as todos:",
      "  - Ship the marketing site (start this one — in progress)",
      "  - Capture marketing screenshots",
      "  - Push to GitLab Pages",
      "Use TodoWrite once with all three, then stop. No other tools, no extra text.",
    ].join("\n");
    await textarea.fill(bootstrapPrompt);
    await page.getByTestId("prompt-send").click();

    // First, confirm the banner populated. The claudius workspace loads
    // many tools/agents so first-token can be slow.
    await expect(page.getByTestId("todos-banner-progress")).toBeVisible({ timeout: 180_000 });
    await expect(page.getByTestId("todos-banner-list")).toBeVisible();

    // Wait for the agent to settle (Send button reappears) before queuing
    // the follow-up — otherwise it gets queued and we'd have to wait for
    // both turns serially anyway.
    await expect(page.getByTestId("prompt-send")).toBeVisible({ timeout: 120_000 });

    // Follow-up: produces enough new output that the original bootstrap
    // message scrolls off the top, AND advances the banner state to "1/3
    // done" — a more interesting marketing shot than "0/3 just-created".
    const followUp = [
      "Great. Mark 'Ship the marketing site' as done — we just deployed it.",
      "Briefly summarize what's left in 1-2 sentences.",
    ].join("\n");
    await textarea.fill(followUp);
    await page.getByTestId("prompt-send").click();

    // Wait for the banner to advance to 1/3 (or any other completed state).
    await expect(page.getByTestId("todos-banner-item-completed")).toHaveCount(1, {
      timeout: 120_000,
    });

    // Scroll the message list to the bottom so the bootstrap message is
    // pushed as far up as possible. Banner stays sticky; what's visible
    // below it is the follow-up turn.
    await page.evaluate(() => {
      const list = document.querySelector(".overflow-y-auto.scroll-thin") as HTMLElement | null;
      if (list) list.scrollTop = list.scrollHeight;
    });
    await page.waitForTimeout(700);
    await snap(page, "todos");
  });

  test("chat — AskUserQuestion modal", async ({ page, baseURL }) => {
    test.setTimeout(360_000);
    const sessionId = await freshChatSession(page);

    const textarea = page.getByTestId("prompt-input");
    await expect(textarea).toBeEnabled({ timeout: 30_000 });
    await expect(page.getByTestId("prompt-send")).toBeVisible({ timeout: 30_000 });

    const modeRes = await page.request.post(
      `${baseURL}/api/sessions/${sessionId}/mode`,
      { data: { mode: "bypassPermissions" } },
    );
    expect(modeRes.ok()).toBeTruthy();

    // Natural-sounding ask that organically calls AskUserQuestion — the
    // modal takes over the screen so the underlying chat is dimmed, but
    // keeping the prompt human-readable still helps the marketing tone.
    const prompt = [
      "Help me decide a couple of things for the Claudius site. Ask me both at once via AskUserQuestion:",
      '  • "Pick a styling approach" — options: Vanilla CSS, Tailwind via CDN, Astro',
      '  • "Pick a theme" — options: Dark, Light, Midnight',
      "Then wait for my answer.",
    ].join("\n");
    await textarea.fill(prompt);
    await page.getByTestId("prompt-send").click();

    await expect(page.getByTestId("ask-user-question")).toBeVisible({ timeout: 240_000 });
    await page.waitForTimeout(700);
    await snap(page, "ask-user-question");
  });
});

/**
 * Customize-feature shots: the management page and the two drawer states
 * (closed-with-count-badge, open-with-popover). The rail and drawer read
 * from the shared workspaces.json, so this run picks up whatever
 * customizations exist on disk — names and count vary across machines. For
 * marketing the variability is fine: the layout is what matters.
 */
test.describe("site screenshots — customize feature", () => {
  test("customize-list", async ({ page }) => {
    // The customize page auto-opens a guided-tour overlay on first visit
    // (gated on `claudius.customize.help-seen` in localStorage). Pre-seed
    // it so the screenshot shows the actual list, not the tutorial.
    await page.addInitScript(() => {
      try {
        localStorage.setItem("claudius.customize.help-seen", "1");
      } catch {
        // sandboxed contexts may block storage — skip silently.
      }
    });
    await gotoStable(page, "/customize");
    await page.waitForTimeout(600);
    await snap(page, "customize-list");
  });

  test("customize-drawer-closed", async ({ page }) => {
    // `/` mounts an SSE stream — networkidle never fires. Wait for `load`.
    await gotoStable(page, "/", { networkIdle: false });
    const switcher = page.locator('[data-pane-name="workspace-switcher"]');
    const drawerBtn = switcher.locator('button[title*="ustomization"]').first();
    await drawerBtn.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await snap(page, "customize-drawer-closed");
  });

  test("customize-drawer-open", async ({ page }) => {
    await gotoStable(page, "/", { networkIdle: false });
    const switcher = page.locator('[data-pane-name="workspace-switcher"]');
    const drawerBtn = switcher.locator('button[title*="ustomization"]').first();
    await drawerBtn.click();
    // Popover header confirms the panel mounted.
    await expect(page.getByText("Customizations", { exact: true })).toBeVisible({
      timeout: 5000,
    });
    await page.waitForTimeout(400);
    await snap(page, "customize-drawer-open");
  });
});
