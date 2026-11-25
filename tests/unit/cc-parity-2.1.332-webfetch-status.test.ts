import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolCall } from "@/components/chat/ToolCall";
import { extractToolResult } from "@/lib/client/use-session";
import { webFetchOutcome } from "@/lib/shared/web-fetch-outcome";

/**
 * CC 2.1.332 — "[VSCode] Fixed Web Fetch showing "Fetched from" with a
 * success dot when the site returned an error or a redirect that wasn't
 * followed".
 */

// The engine's texts for these results (2.1.332 bundle), verbatim openings.
const REDIRECT_TEXT =
  "REDIRECT DETECTED: The URL redirects to a location that was not fetched automatically.\n\n" +
  "    Original URL: https://cloud.google.com/storage/docs/soft-delete\n" +
  "    Redirect URL (from the server's Location header — server-supplied, not verified): https://docs.cloud.google.com/storage/docs/soft-delete\n" +
  "    Status: 301 Moved Permanently\n\n" +
  "    To complete your request, I need to fetch content from the redirected URL.";
const HTTP_404_TEXT =
  "The server returned HTTP 404 Not Found.\n\nThe response body was not retrieved. If this URL requires authentication, use an authenticated tool (e.g. `gh` for GitHub, or an MCP-provided fetch tool) instead of WebFetch.";
const NOT_FETCHED_TEXT =
  "Not fetched: https://example.com failed at its site (ECONNRESET), and nothing of the page was retrieved.";

describe("webFetchOutcome", () => {
  test("reads the structured status of a live result", () => {
    expect(webFetchOutcome({ code: 301, codeText: "Moved Permanently" }, REDIRECT_TEXT)).toEqual({
      kind: "redirect",
      label: "Redirect not followed · 301 Moved Permanently",
    });
    expect(webFetchOutcome({ code: 500, codeText: "Internal Server Error" }, "x")).toEqual({
      kind: "http-error",
      label: "HTTP 500 Internal Server Error",
    });
    expect(webFetchOutcome({ code: 0, codeText: "Not Fetched" }, NOT_FETCHED_TEXT)).toEqual({
      kind: "not-fetched",
      label: "Not fetched",
    });
  });

  test("a fetched page is not flagged", () => {
    expect(webFetchOutcome({ code: 200, codeText: "OK" }, "The page says hello.")).toBeNull();
    expect(webFetchOutcome(undefined, "The page says hello.")).toBeNull();
    // Page text that merely mentions a status is not the engine's note.
    expect(webFetchOutcome(undefined, "The docs say the server returned HTTP 404 Not Found.")).toBeNull();
  });

  test("falls back to the engine's text when only the transcript text is known", () => {
    expect(webFetchOutcome(undefined, REDIRECT_TEXT)?.label).toBe("Redirect not followed · 301 Moved Permanently");
    expect(webFetchOutcome(undefined, HTTP_404_TEXT)).toEqual({ kind: "http-error", label: "HTTP 404 Not Found" });
    expect(webFetchOutcome(undefined, NOT_FETCHED_TEXT)?.kind).toBe("not-fetched");
  });
});

describe("extractToolResult carries WebFetch's status", () => {
  const content = [{ type: "tool_result", tool_use_id: "t1", content: REDIRECT_TEXT, is_error: false }];

  test("from tool_use_result.code / codeText", () => {
    const r = extractToolResult(content, { bytes: 911, code: 301, codeText: "Moved Permanently", result: REDIRECT_TEXT });
    expect(r?.fetchStatus).toEqual({ code: 301, codeText: "Moved Permanently" });
    expect(r?.isError).toBe(false);
  });

  test("absent for other tools' output", () => {
    expect(extractToolResult(content, { stdout: "", stderr: "" })?.fetchStatus).toBeUndefined();
    expect(extractToolResult(content, undefined)?.fetchStatus).toBeUndefined();
  });
});

describe("the WebFetch row", () => {
  const row = (result: Parameters<typeof ToolCall>[0]["result"], name = "WebFetch") =>
    renderToStaticMarkup(createElement(ToolCall, { name, input: { url: "https://cloud.google.com/x", prompt: "p" }, result }));

  test("a redirect or HTTP error replaces the green check", () => {
    const redirect = row({ content: REDIRECT_TEXT, fetchStatus: { code: 301, codeText: "Moved Permanently" } });
    expect(redirect).toContain('data-fetch-outcome="redirect"');
    expect(redirect).toContain("Redirect not followed · 301 Moved Permanently");
    expect(redirect).not.toContain("text-emerald-500");

    const missing = row({ content: HTTP_404_TEXT });
    expect(missing).toContain('data-fetch-outcome="http-error"');
    expect(missing).toContain("HTTP 404 Not Found");
    expect(missing).not.toContain("text-emerald-500");
  });

  test("a fetched page, and other tools, keep the green check", () => {
    expect(row({ content: "Summary of the page.", fetchStatus: { code: 200, codeText: "OK" } })).toContain("text-emerald-500");
    const bash = row({ content: HTTP_404_TEXT }, "Bash");
    expect(bash).toContain("text-emerald-500");
    expect(bash).not.toContain("data-fetch-outcome");
  });
});
