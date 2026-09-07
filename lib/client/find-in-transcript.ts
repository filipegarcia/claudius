/**
 * Browser-style "find in page" over a DOM subtree.
 *
 * Walks every visible text node under `root`, concatenates them into one
 * haystack (inserting a "\n" wherever two adjacent text nodes are separated by
 * a block-level boundary so "end of paragraph" + "start of next" can't form a
 * false match), runs a literal case-(in)sensitive search, and maps each hit
 * back to a DOM `Range`. Matches may span inline elements — `D10` inside
 * `<strong>D</strong>10` still counts — which is what the native find bar does.
 *
 * Rendering is left to the caller: the ranges feed the CSS Custom Highlight
 * API (`CSS.highlights`), which paints them without touching React's DOM.
 */

/** Elements whose text should never be searched. */
const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "TEXTAREA", "INPUT", "SELECT", "NOSCRIPT"]);

/**
 * Tags that flow inline with surrounding text. A text-node boundary that only
 * crosses these is treated as continuous; anything else is a block boundary.
 */
const INLINE_TAGS = new Set([
  "A", "ABBR", "B", "BDI", "BDO", "CITE", "CODE", "DATA", "DEL", "DFN", "EM", "I", "INS",
  "KBD", "MARK", "Q", "S", "SAMP", "SMALL", "SPAN", "STRONG", "SUB", "SUP", "TIME", "U",
  "VAR", "WBR",
]);

export type FindOptions = {
  matchCase?: boolean;
  /** Safety cap so a pathological query ("e" over a huge transcript) stays cheap. */
  maxMatches?: number;
};

/** Escape every regex metacharacter so the query is matched as a literal. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True when the path from `a` to `b` through their lowest common ancestor
 * crosses at least one non-inline element — i.e. the two text nodes render
 * in different blocks.
 */
function isBlockBoundary(a: Text, b: Text, root: Element): boolean {
  const pa = a.parentElement;
  const pb = b.parentElement;
  if (!pa || !pb) return true;
  if (pa === pb) return false;
  const aChain = new Set<Element>();
  for (let el: Element | null = pa; el && el !== root; el = el.parentElement) aChain.add(el);
  // Walk up from b until we hit something on a's chain (the common ancestor).
  let common: Element | null = null;
  for (let el: Element | null = pb; el && el !== root; el = el.parentElement) {
    if (aChain.has(el)) {
      common = el;
      break;
    }
    if (!INLINE_TAGS.has(el.tagName)) return true;
  }
  for (let el: Element | null = pa; el && el !== root && el !== common; el = el.parentElement) {
    if (!INLINE_TAGS.has(el.tagName)) return true;
  }
  return false;
}

export function findInElement(root: Element, query: string, opts: FindOptions = {}): Range[] {
  if (!query) return [];
  const maxMatches = opts.maxMatches ?? 5000;
  const visibleCache = new Map<Element, boolean>();
  const isVisible = (el: Element): boolean => {
    let v = visibleCache.get(el);
    if (v === undefined) {
      // `checkVisibility` covers display:none, visibility:hidden and
      // content-visibility — exactly what collapsed tool calls / thinking
      // blocks use. Older engines without it just search everything.
      v = typeof el.checkVisibility === "function" ? el.checkVisibility() : true;
      visibleCache.set(el, v);
    }
    return v;
  };

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const p = n.parentElement;
      if (!p || SKIP_TAGS.has(p.tagName)) return NodeFilter.FILTER_REJECT;
      if (!(n as Text).data) return NodeFilter.FILTER_SKIP;
      return isVisible(p) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });

  const nodes: Text[] = [];
  const starts: number[] = [];
  const chunks: string[] = [];
  let length = 0;
  let prev: Text | null = null;
  while (walker.nextNode()) {
    const n = walker.currentNode as Text;
    if (prev && isBlockBoundary(prev, n, root)) {
      chunks.push("\n");
      length += 1;
    }
    starts.push(length);
    nodes.push(n);
    chunks.push(n.data);
    length += n.data.length;
    prev = n;
  }
  if (nodes.length === 0) return [];
  const haystack = chunks.join("");

  // Literal search via an escaped pattern: the `i` flag folds case without
  // changing string offsets (unlike `toLowerCase()`, which can change length
  // for some Unicode). Query is fully escaped, so no backtracking risk.
  const re = new RegExp(escapeRegExp(query), opts.matchCase ? "g" : "gi");

  // Binary search: index of the text node containing haystack offset `pos`.
  const nodeAt = (pos: number): number => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  const out: Range[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(haystack)) && out.length < maxMatches) {
    const start = m.index;
    const end = start + m[0].length;
    const si = nodeAt(start);
    const ei = nodeAt(end - 1);
    const startOff = start - starts[si]!;
    const endOff = end - starts[ei]!;
    // A match that begins on a synthetic "\n" separator (query starting with
    // a newline) would map to an offset past its node — skip it.
    if (startOff > nodes[si]!.data.length || endOff > nodes[ei]!.data.length) continue;
    const r = document.createRange();
    r.setStart(nodes[si]!, startOff);
    r.setEnd(nodes[ei]!, endOff);
    out.push(r);
  }
  return out;
}

/** Whether this engine can paint ranges via the CSS Custom Highlight API. */
export function supportsHighlightApi(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof (window as unknown as { Highlight?: unknown }).Highlight === "function" &&
    typeof CSS !== "undefined" &&
    "highlights" in CSS
  );
}

/**
 * Scroll `root` so `range` sits in the comfortable middle band of the
 * viewport. Leaves the scroll position alone when it's already there, like
 * the native find bar, so stepping through nearby matches doesn't jitter.
 */
export function scrollRangeIntoView(root: HTMLElement, range: Range): void {
  const rect = range.getBoundingClientRect();
  const rr = root.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return;
  // The chronologically-latest user message is `position: sticky` at the top
  // (capped at 20vh), so the top band is wider than the bottom one.
  const topBand = rr.top + rr.height * 0.25;
  const bottomBand = rr.bottom - rr.height * 0.15;
  if (rect.top >= topBand && rect.bottom <= bottomBand) return;
  const delta = rect.top - rr.top - rr.height / 2 + rect.height / 2;
  root.scrollTo({ top: root.scrollTop + delta, behavior: "smooth" });
}
