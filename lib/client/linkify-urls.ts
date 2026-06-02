/**
 * Split a message body into a sequence of plain-text segments and URL
 * segments so callers can render the URLs as anchors and leave the rest
 * as raw text.
 *
 * Scope: only `http://` and `https://` URLs are recognised. Other
 * schemes (`javascript:`, `data:`, `file:`, `mailto:`…) are deliberately
 * left as text — community messages are user input and we don't want a
 * crafted body to render a one-click `javascript:` anchor or an
 * arbitrary protocol handler.
 *
 * URL termination: we greedy-match non-whitespace, then strip a small
 * set of trailing punctuation that humans habitually attach to URLs in
 * prose (".", ",", ")", "]", "!", "?", ";", ":", "'", '"', ">"). The
 * stripped punctuation reappears in the next text segment so the
 * rendered output is character-identical to the input — we just gain
 * clickable anchors.
 *
 * Balanced trailing parens are kept inside the URL when they're paired
 * with an opening paren still in the URL (Wikipedia-style links). A
 * dangling `)` with no matching `(` inside the URL is stripped.
 *
 * Pure and framework-free so it can be unit-tested in isolation.
 */

export type LinkifySegment =
  | { type: "text"; value: string }
  | { type: "url"; href: string };

const URL_RE = /\bhttps?:\/\/[^\s<>]+/g;
const TRAILING_PUNCT = /[)\].,!?;:'"`>]/;

/**
 * Strip trailing punctuation that's likely sentence-level, not part of
 * the URL. Keeps a closing paren when there's a matching opening paren
 * inside the URL.
 */
function trimTrailingPunct(url: string): { url: string; trailing: string } {
  let trailing = "";
  while (url.length > 0) {
    const last = url[url.length - 1]!;
    if (!TRAILING_PUNCT.test(last)) break;
    if (last === ")") {
      // Keep paired parens (e.g. wikipedia disambiguation links).
      const opens = (url.match(/\(/g) ?? []).length;
      const closes = (url.match(/\)/g) ?? []).length;
      if (opens >= closes) break;
    }
    trailing = last + trailing;
    url = url.slice(0, -1);
  }
  return { url, trailing };
}

export function linkifyUrls(body: string): LinkifySegment[] {
  if (!body) return [];
  const segments: LinkifySegment[] = [];
  let lastIndex = 0;
  // RegExp with the `g` flag is stateful; create a fresh one per call so
  // the function is reentrant.
  const re = new RegExp(URL_RE.source, "g");
  let m: RegExpExecArray | null;

  const pushText = (value: string) => {
    if (!value) return;
    // Merge with the previous segment when it's also text — keeps the
    // output shape minimal and predictable for snapshot-style tests.
    const last = segments[segments.length - 1];
    if (last && last.type === "text") {
      last.value += value;
      return;
    }
    segments.push({ type: "text", value });
  };

  while ((m = re.exec(body)) !== null) {
    const rawUrl = m[0];
    const idx = m.index;
    const { url, trailing } = trimTrailingPunct(rawUrl);
    if (url.length === 0) {
      // Pathological match like "http://." — skip.
      continue;
    }
    if (idx > lastIndex) {
      pushText(body.slice(lastIndex, idx));
    }
    segments.push({ type: "url", href: url });
    const consumed = idx + url.length;
    lastIndex = consumed;
    if (trailing) {
      pushText(trailing);
      lastIndex = consumed + trailing.length;
    }
  }
  if (lastIndex < body.length) {
    pushText(body.slice(lastIndex));
  }
  return segments;
}
