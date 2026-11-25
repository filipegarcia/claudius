/**
 * CC 2.1.332 — "[VSCode] Fixed Web Fetch showing "Fetched from" with a
 * success dot when the site returned an error or a redirect that wasn't
 * followed".
 *
 * The engine returns those as ordinary (non-error) WebFetch results: the
 * structured output (`WebFetchOutput`) carries the HTTP `code`/`codeText` and
 * the text is a note to the model. Live results carry the structured output
 * (`tool_use_result`); a transcript replay only has the text, so the engine's
 * fixed openings are read as a fallback:
 *  - "REDIRECT DETECTED: …\n    Status: 301 Moved Permanently…"
 *  - "The server returned HTTP 404 Not Found.…"
 *  - "Not fetched: <url> failed …" (`code: 0`, `codeText: "Not Fetched"`)
 */

export type WebFetchStatus = { code: number; codeText: string };

export type WebFetchOutcome = {
  kind: "redirect" | "http-error" | "not-fetched";
  /** Short label for the row, e.g. "HTTP 404 Not Found". */
  label: string;
};

function fromText(content: string): WebFetchStatus | null {
  if (content.startsWith("REDIRECT DETECTED:")) {
    const m = /\n\s*Status: (\d{3})(?: ([^\n]*))?/.exec(content);
    return m ? { code: Number(m[1]), codeText: (m[2] ?? "").trim() } : null;
  }
  const http = /^The server returned HTTP (\d{3})(?: ([^\n]*?))?\.(?:\n|$)/.exec(content);
  if (http) return { code: Number(http[1]), codeText: (http[2] ?? "").trim() };
  if (content.startsWith("Not fetched: ")) return { code: 0, codeText: "Not Fetched" };
  return null;
}

/** What went wrong with a non-error WebFetch result, or null when it fetched the page. */
export function webFetchOutcome(status: WebFetchStatus | undefined, content: string): WebFetchOutcome | null {
  const s = status ?? fromText(content);
  if (!s || !Number.isFinite(s.code)) return null;
  const text = s.codeText.trim();
  if (s.code === 0 && text === "Not Fetched") return { kind: "not-fetched", label: "Not fetched" };
  if (s.code >= 300 && s.code < 400) {
    return { kind: "redirect", label: `Redirect not followed · ${s.code}${text ? ` ${text}` : ""}` };
  }
  if (s.code >= 400) return { kind: "http-error", label: `HTTP ${s.code}${text ? ` ${text}` : ""}` };
  return null;
}
