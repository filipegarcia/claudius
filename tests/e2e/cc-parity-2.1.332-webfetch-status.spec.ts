/**
 * CC 2.1.332 parity — "[VSCode] Fixed Web Fetch showing "Fetched from" with a
 * success dot when the site returned an error or a redirect that wasn't
 * followed".
 *
 * The engine returns a cross-host redirect or an HTTP error as an ordinary,
 * non-error WebFetch result (`tool_use_result.code` / `codeText`), so
 * Claudius drew the green check. The row now says what happened: an amber
 * "Redirect not followed · 301 Moved Permanently", a red "HTTP 404 Not Found".
 * A fetched page keeps its check.
 *
 * Screenshot target: docs/cc-parity/2.1.332/webfetch-status.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";
import { initEvent, mockChatBackend, type SdkEvent } from "./helpers/mock-chat";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.332");
mkdirSync(SHOTS_DIR, { recursive: true });

const SESSION = "aaaaaaaa-bbbb-cccc-dddd-000002332w01";

const REDIRECT_TEXT =
  "REDIRECT DETECTED: The URL redirects to a location that was not fetched automatically.\n\n" +
  "    Original URL: https://cloud.google.com/storage/docs/soft-delete\n" +
  "    Redirect URL (from the server's Location header — server-supplied, not verified): https://docs.cloud.google.com/storage/docs/soft-delete\n" +
  "    Status: 301 Moved Permanently";
const HTTP_404_TEXT =
  "The server returned HTTP 404 Not Found.\n\nThe response body was not retrieved. If this URL requires authentication, use an authenticated tool (e.g. `gh` for GitHub, or an MCP-provided fetch tool) instead of WebFetch.";

function fetchCall(id: string, url: string): SdkEvent {
  return {
    type: "sdk",
    message: {
      type: "assistant",
      uuid: `a-${id}`,
      parent_tool_use_id: null,
      message: {
        id: `msg_${id}`,
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [{ type: "tool_use", id, name: "WebFetch", input: { url, prompt: "What does it say about soft delete?" } }],
      },
    },
  };
}

function fetchResult(id: string, text: string, code: number, codeText: string): SdkEvent {
  return {
    type: "sdk",
    message: {
      type: "user",
      uuid: `r-${id}`,
      parent_tool_use_id: null,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text, is_error: false }] },
      tool_use_result: { bytes: text.length, code, codeText, result: text, durationMs: 120, url: "" },
    },
  };
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test("a WebFetch redirect or HTTP error no longer shows a success check", async ({ page }) => {
  await mockChatBackend(page, SESSION, [
    { type: "ready", sessionId: SESSION },
    initEvent("sys-init-332w"),
    fetchCall("toolu_332w_redirect", "https://cloud.google.com/storage/docs/soft-delete"),
    fetchResult("toolu_332w_redirect", REDIRECT_TEXT, 301, "Moved Permanently"),
    fetchCall("toolu_332w_404", "https://example.com/missing"),
    fetchResult("toolu_332w_404", HTTP_404_TEXT, 404, "Not Found"),
    fetchCall("toolu_332w_ok", "https://example.com/"),
    fetchResult("toolu_332w_ok", "The page is the IANA example domain.", 200, "OK"),
    { type: "replay_done", hasMoreAbove: false },
  ]);
  await page.goto("/");

  const rows = page.getByTestId("tool-call").and(page.locator('[data-tool-name="WebFetch"]'));
  await expect(rows).toHaveCount(3, { timeout: 15_000 });

  const redirect = rows.nth(0).getByTestId("tool-call-fetch-outcome");
  await expect(redirect).toHaveText("Redirect not followed · 301 Moved Permanently");
  await expect(redirect).toHaveAttribute("data-fetch-outcome", "redirect");

  const missing = rows.nth(1).getByTestId("tool-call-fetch-outcome");
  await expect(missing).toHaveText("HTTP 404 Not Found");
  await expect(missing).toHaveAttribute("data-fetch-outcome", "http-error");

  await expect(rows.nth(2).getByTestId("tool-call-fetch-outcome")).toHaveCount(0);

  await page.screenshot({ path: resolve(SHOTS_DIR, "webfetch-status.png"), fullPage: false });
});
