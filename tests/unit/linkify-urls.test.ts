import { describe, expect, test } from "vitest";
import { linkifyUrls } from "@/lib/client/linkify-urls";

describe("linkifyUrls", () => {
  test("returns a single text segment for a plain string", () => {
    expect(linkifyUrls("hello world")).toEqual([
      { type: "text", value: "hello world" },
    ]);
  });

  test("returns an empty list for empty input", () => {
    expect(linkifyUrls("")).toEqual([]);
  });

  test("matches an https URL in the middle of prose", () => {
    expect(linkifyUrls("see https://example.com for more")).toEqual([
      { type: "text", value: "see " },
      { type: "url", href: "https://example.com" },
      { type: "text", value: " for more" },
    ]);
  });

  test("matches an http URL", () => {
    expect(linkifyUrls("http://example.com")).toEqual([
      { type: "url", href: "http://example.com" },
    ]);
  });

  test("strips trailing sentence punctuation", () => {
    expect(linkifyUrls("check https://example.com.")).toEqual([
      { type: "text", value: "check " },
      { type: "url", href: "https://example.com" },
      { type: "text", value: "." },
    ]);
  });

  test("strips trailing comma", () => {
    expect(linkifyUrls("https://a.com, https://b.com")).toEqual([
      { type: "url", href: "https://a.com" },
      { type: "text", value: ", " },
      { type: "url", href: "https://b.com" },
    ]);
  });

  test("keeps balanced trailing parens", () => {
    expect(
      linkifyUrls(
        "see https://en.wikipedia.org/wiki/Foo_(bar) and elsewhere",
      ),
    ).toEqual([
      { type: "text", value: "see " },
      { type: "url", href: "https://en.wikipedia.org/wiki/Foo_(bar)" },
      { type: "text", value: " and elsewhere" },
    ]);
  });

  test("strips a dangling closing paren", () => {
    expect(linkifyUrls("(see https://example.com)")).toEqual([
      { type: "text", value: "(see " },
      { type: "url", href: "https://example.com" },
      { type: "text", value: ")" },
    ]);
  });

  test("does NOT linkify javascript: or other schemes", () => {
    expect(linkifyUrls("javascript:alert(1) and mailto:x@y.z")).toEqual([
      { type: "text", value: "javascript:alert(1) and mailto:x@y.z" },
    ]);
  });

  test("preserves query strings, fragments, and paths", () => {
    const url = "https://example.com/a/b?x=1&y=2#section";
    expect(linkifyUrls(`go to ${url} now`)).toEqual([
      { type: "text", value: "go to " },
      { type: "url", href: url },
      { type: "text", value: " now" },
    ]);
  });

  test("matches multiple URLs across newlines", () => {
    expect(linkifyUrls("a https://a.com\nb https://b.com")).toEqual([
      { type: "text", value: "a " },
      { type: "url", href: "https://a.com" },
      { type: "text", value: "\nb " },
      { type: "url", href: "https://b.com" },
    ]);
  });

  test("ignores http inside a word boundary mismatch", () => {
    // The leading \b in the regex means "https" must come after a word
    // boundary. "foohttps://x" has no boundary between foo and https, so
    // we don't accidentally split a word.
    expect(linkifyUrls("foohttps://x.com")).toEqual([
      { type: "text", value: "foohttps://x.com" },
    ]);
  });
});
