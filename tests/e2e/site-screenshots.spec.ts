import { test, expect, type Page } from "../helpers/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { activateClaudiusWorkspace } from "./helpers/workspace";

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


async function snap(page: Page, name: string) {
  await page.screenshot({
    path: resolve(SHOTS_DIR, `${name}.png`),
    fullPage: false,
  });
}

async function gotoStable(page: Page, path: string, opts?: { networkIdle?: boolean }) {
  // The root layout now mounts a notifications SSE stream + a community
  // notifications stream that keep the network "active" for the lifetime
  // of the tab — `networkidle` never fires on any route, not just the
  // chat. Default to `load` and rely on the per-test settle (plus the
  // 1200ms here) for data fetches to finish.
  //
  // Callers can opt back into `networkidle` with `{ networkIdle: true }`
  // for the rare static page that genuinely settles, but in practice that
  // path is unused — left in for future routes.
  const waitUntil = opts?.networkIdle === true ? "networkidle" : "load";
  await page.goto(path, { waitUntil });
  // Settle for data fetches + transitions/skeletons. The static routes
  // (sessions/agents/skills/...) all hit /api/* on mount; 1200ms covers
  // their typical fetch latency on a warm dev server.
  await page.waitForTimeout(1200);
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
      // Pin the /git layout to split mode for the marketing shot. The
      // page default is already split, but persisting the preference
      // explicitly insulates the screenshot from future default flips.
      if (name === "git") {
        await page.addInitScript(() => {
          try {
            localStorage.setItem("claudius.git.splitMode", "1");
          } catch {
            // Sandboxed / private-mode contexts will fall through to the
            // page's own default — which today is split, so still fine.
          }
        });
      }

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
      // back to the first changed-file row. The split-mode left pane
      // also has to load via `git show` after the click, so the wait is
      // a bit longer than the unified-only case used to need.
      if (name === "git") {
        const preferred = page.locator("button", { hasText: "site/index.html" });
        const target =
          (await preferred.count()) > 0 ? preferred.first() : page.locator("ul li button").first();
        await target.click();
        await page.waitForTimeout(1100); // worktree diff + HEAD fetch for the left pane
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
 * Community-chat screenshot. The chat-server lives on a separate origin
 * and isn't reachable from CI, so we stub the REST + SSE routes with a
 * deterministic fixture (rooms, replay messages) and seed localStorage
 * so the page renders the configured state with a nick already set.
 *
 * Kept in its own describe so the per-route loop above doesn't have to
 * special-case the much-bigger setup this shot needs.
 */
test.describe("site screenshots — community", () => {
  test("community", async ({ page }) => {
    // The page reads its chat-server URL from NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL
    // at build time, so we have to match whatever the dev server was
    // started with — Playwright route mocks intercept on URL prefix, so
    // FAKE_URL must equal the env var the page baked in. If unset, the
    // page renders the empty state and the screenshot test is skipped.
    const FAKE_URL =
      process.env.NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL ?? "";
    test.skip(
      FAKE_URL.length === 0,
      "NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL is not set in this build — community screenshot needs it",
    );
    // Pre-seed the nickname + notifications toggle so the modal doesn't
    // pop and the bell paints the active accent state. The server URL no
    // longer comes from localStorage — it's the env var above. Consent
    // (added in b7ffd93) must also be pre-seeded or the route renders
    // the ConsentPrompt instead of the chat surface.
    await page.addInitScript(() => {
      try {
        localStorage.setItem("claudius.community.nick", "ada-lovelace");
        localStorage.setItem("claudius.community.notifications.enabled", "1");
        localStorage.setItem("claudius.community.consent", "yes");
      } catch {
        // sandbox / private mode — screenshot will still run, just without seed
      }
    });

    // Rooms list: a couple of plausible rooms so the left rail isn't a
    // single-row degenerate case.
    await page.route(`${FAKE_URL}/rooms`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          rooms: [
            { slug: "general", name: "General", description: "Welcome — say hi", pinnedMessageId: null },
            { slug: "ideas", name: "Ideas", description: "Half-baked thoughts welcome", pinnedMessageId: null },
            { slug: "showcase", name: "Showcase", description: "Show what you built", pinnedMessageId: null },
          ],
        }),
      });
    });

    // SSE stream: serve a single replay frame with a handful of natural
    // messages, then keep the connection open so the page shows
    // "connected". Closing would flip the indicator to disconnected,
    // which looks broken in the screenshot.
    const messagesFor = (slug: string) => {
      if (slug !== "general") {
        return { type: "replay", roomSlug: slug, messages: [], pinnedMessageId: null };
      }
      const now = Date.now();
      const min = 60_000;
      return {
        type: "replay",
        roomSlug: "general",
        pinnedMessageId: null,
        messages: [
          {
            id: "m1",
            roomSlug: "general",
            nick: "claudius",
            body: "Welcome to the Claudius community! Say hi, share what you're building, ask anything.",
            isAdmin: true,
            createdAt: now - 42 * min,
          },
          {
            id: "m2",
            roomSlug: "general",
            nick: "tehlulz",
            body: "Just shipped a Linear MCP server hooked up via /mcp — Claude is creating tickets straight from the chat. Anyone else doing this?",
            isAdmin: false,
            createdAt: now - 28 * min,
          },
          {
            id: "m3",
            roomSlug: "general",
            nick: "marina-petrova",
            body: "Yes! I have a tiny `/triage-bug` skill that drops a ticket with reproduction steps + suspected root cause. Game changer for the on-call rotation.",
            isAdmin: false,
            createdAt: now - 24 * min,
          },
          {
            id: "m4",
            roomSlug: "general",
            nick: "ada-lovelace",
            body: "Same — paired it with a scheduled agent that runs every morning to summarize overnight Sentry alerts. Saves us the daily standup.",
            isAdmin: false,
            createdAt: now - 11 * min,
          },
          {
            id: "m5",
            roomSlug: "general",
            nick: "kenji",
            body: "Anyone got a good prompt for code review? Mine drifts into nitpicks too easily.",
            isAdmin: false,
            createdAt: now - 6 * min,
          },
          {
            id: "m6",
            roomSlug: "general",
            nick: "marina-petrova",
            body: "I have a /review-pr skill — focuses on correctness, perf, and API contracts; explicitly de-prioritises style. Happy to share.",
            isAdmin: false,
            createdAt: now - 2 * min,
          },
        ],
      };
    };
    // The chat-server is unreachable, so we simulate the SSE entirely
    // client-side: monkey-patch EventSource for matching URLs so it
    // immediately fires `onopen` (flips the page to "connected", which
    // the composer's "Disconnected…" placeholder gates on) and then
    // dispatches a `replay` message frame with our fixture. No network
    // round-trip, no reconnect loop, no flapping connected state.
    await page.addInitScript(({ url, replayPayloads }) => {
      type Replay = { type: "replay"; roomSlug: string; messages: unknown[]; pinnedMessageId: null };
      const payloads = replayPayloads as Record<string, Replay>;
      const Real = window.EventSource;
      // See community-nav.spec.ts for why we don't `implements EventSource`.
      class FakeES extends EventTarget {
        readonly CONNECTING = 0 as const;
        readonly OPEN = 1 as const;
        readonly CLOSED = 2 as const;
        readyState: number = 1;
        readonly url: string;
        readonly withCredentials = false;
        onopen: ((this: EventSource, ev: Event) => unknown) | null = null;
        onmessage: ((this: EventSource, ev: MessageEvent) => unknown) | null = null;
        onerror: ((this: EventSource, ev: Event) => unknown) | null = null;
        constructor(u: string | URL) {
          super();
          this.url = String(u);
          // Defer microtask so handlers attached after construction still fire.
          queueMicrotask(() => {
            const openEv = new Event("open");
            this.onopen?.call(this as unknown as EventSource, openEv);
            this.dispatchEvent(openEv);
            const slug = decodeURIComponent(this.url.match(/\/rooms\/([^/]+)\/stream/)?.[1] ?? "");
            const payload = payloads[slug] ?? { type: "replay", roomSlug: slug, messages: [], pinnedMessageId: null };
            const msgEv = new MessageEvent("message", { data: JSON.stringify(payload) });
            this.onmessage?.call(this as unknown as EventSource, msgEv);
            this.dispatchEvent(msgEv);
          });
        }
        close() { this.readyState = 2; }
      }
      // Only intercept chat-server URLs; leave Claudius's own SSE alone.
      window.EventSource = new Proxy(Real, {
        construct(target, args) {
          const u = String(args[0]);
          if (u.startsWith(url)) return new FakeES(u);
          return Reflect.construct(target, args);
        },
      }) as unknown as typeof EventSource;
    }, {
      url: FAKE_URL,
      replayPayloads: {
        general: messagesFor("general"),
        ideas: messagesFor("ideas"),
        showcase: messagesFor("showcase"),
      },
    });

    await gotoStable(page, "/community", { networkIdle: false });
    // Allow the SSE replay to flow through, room list to render, and the
    // composer to mount in its disabled "connecting" state if applicable.
    await expect(page.getByTestId("community-page")).toBeVisible({ timeout: 10_000 });
    // Wait for at least one message to render so the screenshot isn't
    // empty.  The MessageList renders the body text inline.
    await expect(page.getByText("Welcome to the Claudius community!")).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(700);
    await snap(page, "community");
  });
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
  // The chat.png / todos.png / ask-user-question.png shots are now produced
  // by `tests/e2e/chat-screenshots.spec.ts`, which snaps fixture-driven
  // dev preview pages (`/dev/chat-empty`, `/dev/chat-todos`, `/dev/chat-ask`).
  // The new spec runs without ANTHROPIC_API_KEY and is deterministic. These
  // legacy live-API tests are kept here for reference and gated off — flip
  // SCREENSHOTS_INCLUDE_CHAT=1 to run them against a real Claude instead.
  test.skip(!INCLUDE_CHAT, "fixture-driven chat-screenshots.spec.ts owns these shots now; set SCREENSHOTS_INCLUDE_CHAT=1 to drive the live API instead");

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
      "  - Push to GitHub Pages",
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
    // Replace the message-area contents with a synthetic mid-interaction
    // "user asks for a new feature" conversation. The card on the site is
    // captioned "drawer · closed" — its job is to show the wand tile + the
    // count badge in the rail. But the chat pane behind it shouldn't be
    // someone's stale debugging session; a feature-request mock reads
    // much better.
    //
    // Done as a `position: absolute` overlay inside `[data-pane-name=
    // "chat-area"]` rather than mutating React's subtree, so reconciliation
    // can't clobber it between injection and screenshot. The top/bottom
    // offsets leave the SessionTabs strip and the composer visible — the
    // overlay only covers the scrollable message list in between.
    await page.evaluate(() => {
      const pane = document.querySelector<HTMLElement>(
        '[data-pane-name="chat-area"]',
      );
      if (!pane) return;
      // Dismiss any live modal/tooltip overlays (e.g. a pending
      // AskUserQuestion from whichever session was last active) — they'd
      // float on top of our marketing overlay and look like a glitch.
      // Also hide the pinned-user-message sticky bubble: it sits in its
      // own stacking context (z-10) inside the scroll container and can
      // poke through an overlay with a lower z-index.
      document
        .querySelectorAll<HTMLElement>(
          '[data-testid="ask-user-question"], [role="dialog"], [data-radix-popper-content-wrapper], [data-testid="permission-prompt"], [data-message-uuid].sticky',
        )
        .forEach((el) => {
          el.style.display = "none";
        });
      const tabs = pane.querySelector<HTMLElement>('[data-testid="session-tab"]');
      const composer = pane.querySelector<HTMLElement>('[data-pane-name="composer"]');
      const top = (tabs?.closest("div")?.getBoundingClientRect().bottom ?? 36) -
        pane.getBoundingClientRect().top;
      const bottom = composer
        ? pane.getBoundingClientRect().bottom - composer.getBoundingClientRect().top + 8
        : 84;
      const overlay = document.createElement("div");
      overlay.id = "claudius-screenshot-overlay";
      overlay.style.cssText =
        `position:absolute;left:0;right:0;top:${Math.round(top)}px;bottom:${Math.round(bottom)}px;background:var(--background);z-index:30;overflow:hidden;`;
      overlay.innerHTML = `
        <div class="flex h-full flex-1 min-h-0 flex-col">
          <div class="flex-1 overflow-y-hidden scroll-thin">
            <div class="mx-auto w-full max-w-3xl space-y-4 px-4 py-6">
              <section class="space-y-4">
                <div class="space-y-2 rounded-md">
                  <div class="group flex justify-end">
                    <div class="max-w-[80%] rounded-2xl border border-[var(--border)] bg-[var(--panel-2)] px-4 py-2">
                      <div class="whitespace-pre-wrap text-sm leading-6">Hey — let's build a new customization called <strong>"Build a data pipeline"</strong>. Add a <code class="rounded bg-[var(--panel)] px-1 py-0.5 font-mono text-[12px]">/pipeline</code> route that renders our data pipeline as a DAG: sources (Kafka, Postgres CDC, S3) flowing into ingest, then Bronze → dbt → Silver → Gold marts, and a Feature store. Each node should show throughput, p95 latency, and a sparkline. Curved gradient edges with throughput labels on them. Add a "recent runs" strip at the bottom — last 24 runs per stage as green/amber/red chips. Make it look really nice.</div>
                    </div>
                  </div>
                </div>
                <div class="space-y-2 rounded-md">
                  <div class="text-sm leading-6 text-[var(--foreground)]/90 whitespace-pre-wrap">I'll mirror the Docker customization layout — top aggregate cards, the DAG, then a run-history strip. Self-contained fixture data so the screenshot stays deterministic. Starting with a survey of the existing customizations to match the visual language.</div>
                  <div class="my-2 rounded-lg border border-[var(--border)] bg-[var(--panel)]/40">
                    <div class="flex w-full items-center gap-2 pr-3 text-xs hover:bg-[var(--panel-2)]">
                      <div class="flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left">
                        <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
                        <svg class="h-3.5 w-3.5" style="color:var(--accent)" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path></svg>
                        <span class="font-mono">Glob</span>
                        <span class="truncate font-mono text-[10px] text-[var(--muted)]">app/docker/page.tsx</span>
                      </div>
                      <span class="inline-flex items-center gap-1 text-[var(--muted)]">
                        <svg class="h-3.5 w-3.5 text-emerald-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.801 10A10 10 0 1 1 17 3.335"></path><path d="m9 11 3 3L22 4"></path></svg>
                      </span>
                    </div>
                  </div>
                  <div class="my-2 rounded-lg border border-[var(--border)] bg-[var(--panel)]/40">
                    <div class="flex w-full items-center gap-2 pr-3 text-xs hover:bg-[var(--panel-2)]">
                      <div class="flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left">
                        <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
                        <svg class="h-3.5 w-3.5" style="color:var(--accent)" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path></svg>
                        <span class="font-mono">Read</span>
                        <span class="truncate font-mono text-[10px] text-[var(--muted)]">app/docker/page.tsx</span>
                      </div>
                      <span class="inline-flex items-center gap-1 text-[var(--muted)]">
                        <svg class="h-3.5 w-3.5 text-emerald-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.801 10A10 10 0 1 1 17 3.335"></path><path d="m9 11 3 3L22 4"></path></svg>
                      </span>
                    </div>
                  </div>
                  <div class="text-sm leading-6 text-[var(--foreground)]/90 whitespace-pre-wrap">Good — the Docker page has the radial-gauge + sparkline pattern I want to rhyme with. Now scaffolding the route…</div>
                  <div class="my-2 rounded-lg border border-[var(--border)] bg-[var(--panel)]/40">
                    <div class="flex w-full items-center gap-2 pr-3 text-xs hover:bg-[var(--panel-2)]">
                      <div class="flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left">
                        <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
                        <svg class="h-3.5 w-3.5" style="color:var(--accent)" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path></svg>
                        <span class="font-mono">Write</span>
                        <span class="truncate font-mono text-[10px] text-[var(--muted)]">app/pipeline/page.tsx</span>
                      </div>
                      <span class="inline-flex items-center gap-1 text-[var(--muted)]">
                        <span class="inline-block h-2 w-2 animate-pulse rounded-full" style="background:var(--accent)"></span>
                      </span>
                    </div>
                  </div>
                </div>
                <div class="flex items-center gap-2 text-xs text-[var(--muted)]">
                  <svg class="h-3.5 w-3.5 animate-spin" style="color:var(--accent)" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>
                  <span class="font-medium text-[var(--foreground)]/80">Claude is working…</span>
                </div>
              </section>
            </div>
          </div>
        </div>
      `;
      pane.style.position = "relative";
      pane.appendChild(overlay);
    });
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
