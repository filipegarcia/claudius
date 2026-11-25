/**
 * CC 2.1.327 parity — "Improved transcript search to find text in edits and
 * written files."
 *
 * Claudius's Cmd/Ctrl+F find bar only searches rendered DOM text, while Edit /
 * Write cards are collapsed with their input shown as escaped JSON — so text
 * the model wrote into a file was never found. Now a card whose file text
 * matches the query opens itself (and shows that text as plain text, so it
 * highlights), and closes again when the query stops matching or the bar
 * closes. A card the user opened by hand stays open.
 *
 * The token carries double quotes on purpose: the old JSON dump rendered them
 * as `\"`, so a hit can only come from the new plain-text block.
 *
 * Screenshot target: docs/cc-parity/2.1.327/search-edits.png
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.327");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-00000327edit";
const EDIT_ID = "toolu_327_edit";
const WRITE_ID = "toolu_327_write";
const TOKEN = 'say "zebra-327"';

type SdkEvent = Record<string, unknown>;
const sseBody = (events: SdkEvent[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");

async function mockChatBackend(page: Page, events: SdkEvent[]): Promise<void> {
  await page.route("**/api/sessions", async (route: Route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: FAKE_SESSION_ID }) });
  });
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/stream*`, async (route: Route) =>
    route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
      body: sseBody(events),
    }),
  );
  await page.route("**/api/sessions/open-tabs", async (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ activeId: null, tabs: [] }) }),
  );
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/pending-prompts`, async (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ asks: [], permissions: [] }) }),
  );
  await page.route("**/api/limits*", async (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ limits: { sessionUsd: 0, projectDailyUsd: 0 } }) }),
  );
}

const PRELUDE: SdkEvent[] = [
  { type: "ready", sessionId: FAKE_SESSION_ID },
  { type: "sdk", message: { type: "system", subtype: "init", uuid: "sys-init-327edit", model: "claude-sonnet-5-5" } },
  { type: "replay_done", hasMoreAbove: false },
];

const USER_MESSAGE: SdkEvent = {
  type: "sdk",
  message: {
    type: "user",
    uuid: "u-327edit",
    parent_tool_use_id: null,
    isSynthetic: false,
    message: { role: "user", content: [{ type: "text", text: "Make the greeter friendlier and add a notes file." }] },
  },
};

const TOOL_USES: SdkEvent = {
  type: "sdk",
  message: {
    type: "assistant",
    uuid: "a-327edit",
    parent_tool_use_id: null,
    message: {
      id: "msg_327edit",
      model: "claude-sonnet-5-5",
      content: [
        { type: "text", text: "I'll update the greeter, then write a short notes file." },
        {
          type: "tool_use",
          id: EDIT_ID,
          name: "Edit",
          input: {
            file_path: "src/greeter.ts",
            old_string: "export function greet() {\n  return \"hi\";\n}",
            new_string: `export function greet() {\n  // friendlier\n  return ${TOKEN};\n}`,
          },
        },
        {
          type: "tool_use",
          id: WRITE_ID,
          name: "Write",
          input: {
            file_path: "NOTES.md",
            content: `# Notes\n\nThe greeter should ${TOKEN} on start.\n`,
          },
        },
      ],
      usage: { input_tokens: 50, output_tokens: 25 },
    },
  },
};

function toolResult(id: string, text: string, uuid: string): SdkEvent {
  return {
    type: "sdk",
    message: {
      type: "user",
      uuid,
      parent_tool_use_id: null,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] },
    },
  };
}

/** Tool names of the cards that contain each painted "all matches" range. */
function paintedCardNames(page: Page): Promise<Array<string | null>> {
  return page.evaluate(() =>
    [...(CSS.highlights.get("transcript-find") ?? [])].map(
      (r) =>
        (r as Range).startContainer.parentElement
          ?.closest("[data-tool-name]")
          ?.getAttribute("data-tool-name") ?? null,
    ),
  );
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test("the find bar finds text in edits and written files, opening only the cards it needs", async ({ page }) => {
  await mockChatBackend(page, [
    ...PRELUDE,
    USER_MESSAGE,
    TOOL_USES,
    toolResult(EDIT_ID, "The file src/greeter.ts has been updated successfully.", "tr-327edit-1"),
    toolResult(WRITE_ID, "File created successfully at: NOTES.md", "tr-327edit-2"),
  ]);
  await page.goto("/");

  const edit = page.locator('[data-testid="tool-call"][data-tool-name="Edit"]');
  const write = page.locator('[data-testid="tool-call"][data-tool-name="Write"]');
  await expect(edit).toHaveCount(1, { timeout: 15_000 });
  await expect(edit).toHaveAttribute("data-open", "0");
  await expect(write).toHaveAttribute("data-open", "0");

  // The user opens the Write card by hand before searching.
  await write.getByRole("button").first().click();
  await expect(write).toHaveAttribute("data-open", "1");
  await expect(write.getByTestId("tool-call-input-text")).toHaveAttribute("data-field", "content");

  await page.keyboard.press("ControlOrMeta+f");
  const input = page.getByTestId("transcript-find-input");
  const count = page.getByTestId("transcript-find-count");
  await expect(input).toBeFocused();

  // The token is only in the Edit's new_string and the Write's content.
  await input.fill(TOKEN);
  await expect(edit).toHaveAttribute("data-open", "1");
  await expect(count).toHaveText(/^\d of 2 matches$/);
  const newString = edit.locator('[data-testid="tool-call-input-text"][data-field="new_string"]');
  await expect(newString).toContainText(TOKEN);
  expect((await paintedCardNames(page)).sort()).toEqual(["Edit", "Write"]);

  // Stepping wraps through both hits; land on the Edit's.
  await input.press("Enter");
  await expect(count).toHaveText(/^\d of 2 matches$/);
  const currentIn = () =>
    page.evaluate(() => {
      const r = [...(CSS.highlights.get("transcript-find-current") ?? [])][0] as Range | undefined;
      return r?.startContainer.parentElement?.closest("[data-tool-name]")?.getAttribute("data-tool-name") ?? null;
    });
  if ((await currentIn()) !== "Edit") await input.press("Enter");
  expect(await currentIn()).toBe("Edit");
  await expect(count).toHaveText("1 of 2 matches");

  await newString.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await page.screenshot({ path: resolve(SHOTS_DIR, "search-edits.png"), fullPage: false });

  // A query that no longer matches closes the card the search opened, but
  // not the one the user opened.
  await input.fill("zzz-not-in-any-file");
  await expect(count).toHaveText("No matches");
  await expect(edit).toHaveAttribute("data-open", "0");
  await expect(write).toHaveAttribute("data-open", "1");

  // Matching again re-opens it; closing the bar closes it again.
  await input.fill(TOKEN);
  await expect(edit).toHaveAttribute("data-open", "1");
  await expect(count).toHaveText(/of 2 matches$/);
  await input.press("Escape");
  await expect(page.getByTestId("transcript-find")).toBeHidden();
  await expect(edit).toHaveAttribute("data-open", "0");
  await expect(write).toHaveAttribute("data-open", "1");
});
