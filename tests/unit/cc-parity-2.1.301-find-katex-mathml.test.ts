import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { findInElement } from "@/lib/client/find-in-transcript";

/**
 * CC 2.1.301 — LaTeX math. KaTeX renders every formula twice: the visible
 * `.katex-html` and a clipped (not `display: none`) `.katex-mathml` copy for
 * screen readers. Transcript find must only match the visible one.
 *
 * The unit suite runs in node with no DOM, so this builds the handful of DOM
 * pieces `findInElement` touches: elements with `tagName` / `parentElement` /
 * a class-aware `closest`, text nodes, a TreeWalker that honours `acceptNode`,
 * and `createRange`.
 */

type FakeEl = {
  tagName: string;
  className: string;
  parentElement: FakeEl | null;
  children: (FakeEl | FakeText)[];
  closest(sel: string): FakeEl | null;
  checkVisibility(): boolean;
};
type FakeText = { nodeType: 3; data: string; parentElement: FakeEl };

function el(tagName: string, className: string, ...kids: (FakeEl | string)[]): FakeEl {
  const e: FakeEl = {
    tagName,
    className,
    parentElement: null,
    children: [],
    closest(sel) {
      const cls = sel.replace(/^\./, "");
      for (let cur: FakeEl | null = e; cur; cur = cur.parentElement) if (cur.className.split(" ").includes(cls)) return cur;
      return null;
    },
    checkVisibility: () => true,
  };
  for (const k of kids) {
    if (typeof k === "string") e.children.push({ nodeType: 3, data: k, parentElement: e });
    else {
      k.parentElement = e;
      e.children.push(k);
    }
  }
  return e;
}

const FILTER_ACCEPT = 1;
const FILTER_REJECT = 2;
const FILTER_SKIP = 3;

beforeEach(() => {
  vi.stubGlobal("NodeFilter", { SHOW_TEXT: 4, FILTER_ACCEPT, FILTER_REJECT, FILTER_SKIP });
  vi.stubGlobal("document", {
    createTreeWalker(root: FakeEl, _what: number, filter: { acceptNode(n: FakeText): number }) {
      const texts: FakeText[] = [];
      const walk = (e: FakeEl) => {
        for (const c of e.children) {
          if ("nodeType" in c) {
            if (filter.acceptNode(c) === FILTER_ACCEPT) texts.push(c);
          } else walk(c);
        }
      };
      walk(root);
      let i = -1;
      return {
        currentNode: null as FakeText | null,
        nextNode() {
          i++;
          this.currentNode = texts[i] ?? null;
          return this.currentNode;
        },
      };
    },
    createRange() {
      return {
        startContainer: null as FakeText | null,
        setStart(n: FakeText) {
          this.startContainer = n;
        },
        setEnd() {},
      };
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("findInElement and KaTeX", () => {
  const formula = () =>
    el(
      "DIV",
      "prose",
      el("P", "", "Euler: ", el("SPAN", "katex",
        el("SPAN", "katex-mathml", el("MATH", "", el("SEMANTICS", "", el("MI", "", "xyz"), el("ANNOTATION", "", "xyz")))),
        el("SPAN", "katex-html", el("SPAN", "mord", "xyz")),
      )),
    );

  test("the MathML twin and its TeX annotation are not matched", () => {
    const ranges = findInElement(formula() as unknown as Element, "xyz") as unknown as { startContainer: FakeText }[];
    // Only the visible .katex-html copy (would be 3 with the MathML twin).
    expect(ranges).toHaveLength(1);
    expect(ranges[0]!.startContainer.parentElement.className).toBe("mord");
  });

  test("ordinary prose around the formula is still searchable", () => {
    expect(findInElement(formula() as unknown as Element, "euler")).toHaveLength(1);
  });
});
