import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect, type Page } from "../helpers/test";

/**
 * Markdown images that point OUTSIDE the workspace — `![shot](/tmp/x.png)`,
 * the shape the agent produces after taking a screenshot — must render.
 *
 * Before: `MarkdownFilePreview` only rewrote in-workspace paths to the files
 * API; anything else went straight into `<img src="/tmp/x.png">`, which the
 * browser resolved against the Next origin and 404'd (broken-image icon under
 * the preview card header).
 *
 * Now: absolute non-workspace image paths go through `/api/local-image`,
 * which serves images strictly under the OS temp roots and refuses anything
 * else. Driven over the dev-broadcast bus (no Anthropic key).
 */

const SESSION_RE = /[?&]session=([0-9a-f-]{36})/i;

// 1×1 transparent PNG.
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

async function waitForBoundSession(page: Page): Promise<string> {
  await page.waitForURL((url) => SESSION_RE.test(String(url)), { timeout: 30_000 });
  const id = page.url().match(SESSION_RE)?.[1];
  expect(id).toMatch(/^[0-9a-f-]{36}$/i);
  return id!;
}

async function pushAssistant(page: Page, sessionId: string, text: string, uuid: string) {
  const res = await page.request.post(`/api/sessions/${sessionId}/dev-broadcast`, {
    data: {
      event: {
        type: "sdk",
        message: {
          type: "assistant",
          uuid,
          parent_tool_use_id: null,
          message: {
            model: "claude-sonnet-4-6",
            content: [{ type: "text", text }],
            usage: { input_tokens: 10, output_tokens: 10 },
          },
        },
      },
    },
  });
  expect(res.ok(), `dev-broadcast assistant should succeed for ${sessionId}`).toBeTruthy();
}

test.describe("markdown images under /tmp", () => {
  test.beforeEach(async ({ request }) => {
    await request.put("/api/sessions/open-tabs", { data: { tabs: [], activeId: null } });
  });

  test("an assistant `![…](/tmp/…png)` renders through /api/local-image", async ({ page }) => {
    test.setTimeout(60_000);

    // The server and this test run on the same machine, so a file under /tmp
    // is visible to both.
    const dir = mkdtempSync(join("/tmp", "claudius-e2e-img-"));
    const shot = join(dir, "shot.png");
    writeFileSync(shot, PNG_1X1);

    await page.goto("/");
    const id = await waitForBoundSession(page);
    await pushAssistant(page, id, `Here is the capture:\n\n![shot](${shot})`, "tmp-img-1");

    const msg = page.locator('[data-message-uuid="tmp-img-1"]');
    const img = msg.locator("img");
    await expect(img).toBeVisible();
    expect(await img.getAttribute("src")).toContain("/api/local-image?path=");
    // A broken image has naturalWidth 0; our 1×1 PNG decodes to 1.
    await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(1);
  });

  test("the endpoint refuses anything outside the temp roots", async ({ request }) => {
    // Real image, wrong location (the repo's gitignored test-results dir).
    const outsideDir = join(process.cwd(), "test-results");
    mkdirSync(outsideDir, { recursive: true });
    const outside = join(outsideDir, "outside-tmp.png");
    writeFileSync(outside, PNG_1X1);
    expect((await request.get(`/api/local-image?path=${encodeURIComponent(outside)}`)).status()).toBe(403);

    // Traversal out of /tmp collapses to a non-temp path.
    expect(
      (await request.get(`/api/local-image?path=${encodeURIComponent("/tmp/../etc/hosts.png")}`)).status(),
    ).toBe(403);

    // Non-image extension is rejected before any filesystem access.
    expect((await request.get(`/api/local-image?path=${encodeURIComponent("/tmp/notes.txt")}`)).status()).toBe(415);

    // Relative paths are rejected outright.
    expect((await request.get(`/api/local-image?path=shot.png`)).status()).toBe(400);

    // Under /tmp but missing → 404, not an error page.
    expect(
      (await request.get(`/api/local-image?path=${encodeURIComponent("/tmp/claudius-e2e-does-not-exist.png")}`)).status(),
    ).toBe(404);
  });
});
