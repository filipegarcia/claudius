import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { test, expect, type Page, type Request } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

/**
 * `/customize/<id>/chat` (rust/TODO.md N03a, rust/parity/server-components.md
 * § 3 row 1). The page is a client component: it reads the id from the
 * pathname, loads `GET /api/customizations/<id>` (which carries `srcDir`, the
 * customization's editable mirror) and mounts the chat only once that is
 * known, so the boot's fresh session is created in the mirror. An unknown id
 * goes to `/customize` — the Rust front door's R6 307 on a document load, the
 * page's own `router.replace` otherwise.
 *
 * Bootstrapping a real customization copies the whole live source tree, so
 * the records are written straight into the isolated e2e HOME's
 * `customizations/index.json` (the store re-reads it on every request) and
 * removed from it afterwards. `/api/sessions/open-tabs` is stubbed: an empty GET so
 * the boot creates a fresh session instead of resuming whatever the active
 * cookie's scope last had open, and a no-op PUT so this spec leaves no tabs
 * behind for later specs to resume. The session itself is real, which is
 * what shows the server accepted the mirror as its cwd.
 *
 * The last block covers another N03a reader (§ 3 row 7): the rate-limit
 * pill's "cost settings" link takes the workspace id from the pathname, so
 * it is `/<ws>/cost` in a workspace chat and `/cost` in a customization chat.
 */

const HOME = process.env.CLAUDIUS_E2E_HOME;
const CUSTOMIZATIONS = HOME ? join(HOME, ".claude", ".claudius", "customizations") : "";
const INDEX = join(CUSTOMIZATIONS, "index.json");

type IndexShape = { version: 1; customizations: Array<{ id: string }>; publishes: unknown[] };

function newId(): string {
  return `cust_${randomBytes(6).toString("hex")}`;
}

/** What `customizationSrcDir(id)` resolves to on the e2e servers. */
function srcDirOf(id: string): string {
  return join(CUSTOMIZATIONS, id, "src");
}

function readIndex(): IndexShape {
  if (!existsSync(INDEX)) return { version: 1, customizations: [], publishes: [] };
  return JSON.parse(readFileSync(INDEX, "utf8")) as IndexShape;
}

function writeIndex(shape: IndexShape): void {
  mkdirSync(CUSTOMIZATIONS, { recursive: true });
  const tmp = `${INDEX}.e2e-${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(shape, null, 2) + "\n", "utf8");
  renameSync(tmp, INDEX);
}

/** Add a customization record and its (empty) mirror dir. */
function seedCustomization(id: string, name: string): void {
  const shape = readIndex();
  const now = Date.now();
  shape.customizations.push({ id, name, createdAt: now, updatedAt: now } as { id: string });
  writeIndex(shape);
  mkdirSync(srcDirOf(id), { recursive: true });
}

/**
 * Drop the record. The mirror dir stays: the session the test started still
 * runs there until the idle reaper ends it (a deleted cwd makes its CLI fail
 * every later call), and the whole e2e HOME goes at global teardown.
 */
function removeCustomization(id: string): void {
  const shape = readIndex();
  shape.customizations = shape.customizations.filter((c) => c.id !== id);
  writeIndex(shape);
}

async function stubOpenTabs(page: Page): Promise<void> {
  await page.route("**/api/sessions/open-tabs", async (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ tabs: [], activeId: null, labelMaxWidth: 200 }),
      });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
}

/** The detail page's heavy panels hash the whole live tree; none of that is under test here. */
async function stubDetailPanels(page: Page): Promise<void> {
  await page.route(/\/api\/customizations\/cust_[0-9a-f]+\/diff$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ changedFiles: 0, addedFiles: 0, identicalFiles: 0, files: [] }),
    }),
  );
  await page.route(/\/api\/customizations\/cust_[0-9a-f]+\/publishes$/, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ publishes: [] }) }),
  );
  await page.route(/\/api\/customizations\/cust_[0-9a-f]+\/sync$/, (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ manifestCreatedAt: Date.now(), totals: {}, entries: [] }),
    });
  });
}

function isSessionCreate(req: Request): boolean {
  return req.method() === "POST" && new URL(req.url()).pathname === "/api/sessions";
}

/** Wait for the boot's `POST /api/sessions` and check it ran in `srcDir`. */
async function expectSessionIn(page: Page, created: Promise<Request>, srcDir: string): Promise<void> {
  const req = await created;
  const body = JSON.parse(req.postData() ?? "{}") as { cwd?: string; resume?: string };
  expect(body.resume).toBeUndefined();
  expect(body.cwd).toBe(srcDir);
  const res = await req.response();
  expect(res?.status()).toBe(200);
  const answer = (await res!.json()) as { id?: string; cwd?: string };
  expect(answer.id).toBeTruthy();
  expect(answer.cwd).toBe(srcDir);
  await expect(page.getByTestId("prompt-input")).toBeVisible();
}

test.describe("customization chat route", () => {
  test.skip(!HOME, "needs the isolated e2e HOME from playwright.config.ts");

  test("a known id mounts the chat in the customization's src dir", async ({ page }) => {
    test.setTimeout(120_000);
    const id = newId();
    seedCustomization(id, "E2E chat route");
    try {
      await stubOpenTabs(page);
      const record = page.waitForResponse(
        (r) => new URL(r.url()).pathname === `/api/customizations/${id}` && r.request().method() === "GET",
      );
      const created = page.waitForRequest(isSessionCreate, { timeout: 90_000 });
      await page.goto(`/customize/${id}/chat`);

      // The page's own read: the record plus its srcDir, on either backend.
      const got = (await (await record).json()) as { id: string; srcDir: string };
      expect(got.id).toBe(id);
      expect(got.srcDir).toBe(srcDirOf(id));

      await expectSessionIn(page, created, srcDirOf(id));
      await expect(page).toHaveURL(new RegExp(`/customize/${id}/chat(\\?|$)`));
    } finally {
      removeCustomization(id);
    }
  });

  test("an unknown id lands on /customize without starting a session", async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem("claudius.customize.help-seen", "1");
    });
    await stubOpenTabs(page);
    const sessions: string[] = [];
    page.on("request", (req) => {
      if (isSessionCreate(req)) sessions.push(req.url());
    });
    await page.goto(`/customize/${newId()}/chat`);
    await expect(page).toHaveURL(/\/customize$/);
    await expect(page.getByRole("button", { name: /New customization/i })).toBeVisible();
    expect(sessions).toEqual([]);
  });

  test("soft navigation from the detail page mounts the chat", async ({ page, baseURL }) => {
    test.setTimeout(120_000);
    const id = newId();
    seedCustomization(id, "E2E soft nav");
    try {
      await stubOpenTabs(page);
      await stubDetailPanels(page);
      // Make it the active customization, as "Go to chat" does: the side
      // nav's Chat tile then links to this customization's chat.
      const sel = await page.request.post(`${baseURL}/api/customizations/${id}/select`);
      expect(sel.ok()).toBeTruthy();

      await page.goto(`/customize/${id}`);
      await expect(page.getByRole("heading", { name: "E2E soft nav" })).toBeVisible();
      const chatLink = page.getByTestId("sidenav-tile-nav.chat").locator("a");
      await expect(chatLink).toHaveAttribute("href", `/customize/${id}/chat`);

      // A document load would drop this marker.
      await page.evaluate(() => {
        (window as unknown as { __n03aSoftNav?: boolean }).__n03aSoftNav = true;
      });
      const created = page.waitForRequest(isSessionCreate, { timeout: 90_000 });
      await chatLink.click();
      await expect(page).toHaveURL(new RegExp(`/customize/${id}/chat(\\?|$)`));
      await expectSessionIn(page, created, srcDirOf(id));
      const soft = await page.evaluate(
        () => (window as unknown as { __n03aSoftNav?: boolean }).__n03aSoftNav === true,
      );
      expect(soft).toBe(true);
    } finally {
      removeCustomization(id);
    }
  });

  test("soft navigation to an unknown id lands on /customize", async ({ page, baseURL, context }) => {
    test.setTimeout(120_000);
    const id = newId();
    const ghost = newId();
    seedCustomization(id, "E2E ghost link");
    try {
      await page.addInitScript(() => {
        window.localStorage.setItem("claudius.customize.help-seen", "1");
      });
      await stubOpenTabs(page);
      await stubDetailPanels(page);
      // The active-customization cookie names a customization that doesn't
      // exist, so the side nav's Chat tile links to its chat.
      await context.addCookies([
        { name: "claudius.customization", value: ghost, url: baseURL ?? "http://localhost:3179" },
      ]);
      const sessions: string[] = [];
      page.on("request", (req) => {
        if (isSessionCreate(req)) sessions.push(req.url());
      });

      await page.goto(`/customize/${id}`);
      await expect(page.getByRole("heading", { name: "E2E ghost link" })).toBeVisible();
      const chatLink = page.getByTestId("sidenav-tile-nav.chat").locator("a");
      await expect(chatLink).toHaveAttribute("href", `/customize/${ghost}/chat`);
      await chatLink.click();
      await expect(page).toHaveURL(/\/customize$/);
      await expect(page.getByRole("button", { name: /New customization/i })).toBeVisible();
      expect(sessions).toEqual([]);
    } finally {
      removeCustomization(id);
    }
  });
});

// ---- The rate-limit pill's cost link (components/chat/SystemPill.tsx) ----

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-000000000a03";

/** A mocked chat backend whose stream carries one rejected rate-limit event with extra usage available. */
async function mockRejectedRateLimit(page: Page): Promise<void> {
  const events = [
    { type: "ready", sessionId: FAKE_SESSION_ID },
    {
      type: "sdk",
      message: { type: "system", subtype: "init", uuid: "sys-init-0", model: "claude-sonnet-4-6" },
    },
    { type: "replay_done", hasMoreAbove: false },
    {
      type: "sdk",
      message: {
        type: "rate_limit_event",
        uuid: "rl-n03a-01",
        session_id: FAKE_SESSION_ID,
        rate_limit_info: {
          status: "rejected",
          rateLimitType: "five_hour",
          resetsAt: Math.floor(Date.now() / 1000) + 3600,
          overageStatus: "allowed",
          isUsingOverage: false,
        },
      },
    },
  ];
  await page.route("**/api/sessions", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ id: FAKE_SESSION_ID }),
    });
  });
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/stream*`, (route) =>
    route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
      body: events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""),
    }),
  );
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/pending-prompts`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ asks: [], permissions: [] }),
    }),
  );
  await page.route("**/api/limits*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ limits: { sessionUsd: 0, projectDailyUsd: 0 } }),
    }),
  );
  await stubOpenTabs(page);
}

test.describe("rate-limit pill cost link", () => {
  test("a workspace chat links to that workspace's cost page", async ({ page }) => {
    await activateClaudiusWorkspace(page);
    await mockRejectedRateLimit(page);
    await page.goto("/");
    await page.waitForURL(/\/wks_[a-f0-9]{12}(\?|$)/);
    const ws = new URL(page.url()).pathname.slice(1);
    const link = page.getByRole("link", { name: "cost settings" });
    await expect(link).toBeVisible({ timeout: 15_000 });
    await expect(link).toHaveAttribute("href", `/${ws}/cost`);
  });

  test("a customization chat links to the bare cost page", async ({ page }) => {
    test.skip(!HOME, "needs the isolated e2e HOME from playwright.config.ts");
    const id = newId();
    seedCustomization(id, "E2E cost link");
    try {
      await mockRejectedRateLimit(page);
      await page.goto(`/customize/${id}/chat`);
      const link = page.getByRole("link", { name: "cost settings" });
      await expect(link).toBeVisible({ timeout: 15_000 });
      await expect(link).toHaveAttribute("href", "/cost");
    } finally {
      removeCustomization(id);
    }
  });
});
