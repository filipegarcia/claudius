import { describe, expect, test } from "vitest";
import {
  compilePattern,
  renderCommitPrefix,
  type CommitPrefixConfig,
} from "@/lib/shared/commit-prefix";

/**
 * Pure-function fence around the per-workspace commit-prefix derivation.
 * The settings UI feeds these helpers a pattern + template + branch name and
 * expects:
 *   - the full pattern matches the documented "type/id-rest" shape
 *   - a bare-id branch (`feat/4729`) still matches, with the trailing
 *     placeholder rendering as empty (this is the bug fix the screenshot
 *     was reporting)
 *   - a single-placeholder pattern still requires a real match (we don't
 *     want `{id}` to silently accept anything)
 */

const config = (
  branchPattern: string,
  template: string,
): CommitPrefixConfig => ({
  enabled: true,
  branchPattern,
  template,
});

describe("compilePattern", () => {
  test("rejects empty / placeholder-less input", () => {
    expect(compilePattern("")).toBeNull();
    expect(compilePattern("no placeholders here")).toBeNull();
  });

  test("rejects duplicate placeholder names", () => {
    expect(compilePattern("{id}-{id}")).toBeNull();
  });

  test("captures non-final placeholders up to the next separator", () => {
    const compiled = compilePattern("{type}/{id}-{rest}");
    expect(compiled).not.toBeNull();
    const m = compiled!.re.exec("feat/4715-add-search-filter");
    expect(m?.groups).toEqual({
      type: "feat",
      id: "4715",
      rest: "add-search-filter",
    });
  });

  test("trailing literal+placeholder is optional when pattern has ≥2 placeholders", () => {
    const compiled = compilePattern("{type}/{id}-{rest}");
    const m = compiled!.re.exec("feat/4729");
    // Match succeeds with the trailing group absent — `rest` is undefined.
    expect(m?.groups?.type).toBe("feat");
    expect(m?.groups?.id).toBe("4729");
    expect(m?.groups?.rest).toBeUndefined();
  });

  test("partial trailing literal still fails (`feat/4729-` has no rest)", () => {
    const compiled = compilePattern("{type}/{id}-{rest}");
    // The last placeholder requires ≥1 char; either the whole trailing
    // group is present or absent — a dangling dash isn't valid.
    expect(compiled!.re.exec("feat/4729-")).toBeNull();
  });

  test("single-placeholder pattern still requires a match", () => {
    const compiled = compilePattern("{id}");
    expect(compiled).not.toBeNull();
    // A single placeholder must not become "match anything optional" — we
    // still want the pattern to be opt-in semantics.
    expect(compiled!.re.exec("")).toBeNull();
    expect(compiled!.re.exec("abc")?.groups?.id).toBe("abc");
  });
});

describe("renderCommitPrefix", () => {
  test("renders the documented screenshot case", () => {
    expect(
      renderCommitPrefix(
        "feat/4715-add-search-filter",
        config("{type}/{id}-{rest}", "{type} #{id} - "),
      ),
    ).toBe("feat #4715 - ");
  });

  test("renders bare-id branches (the reported bug)", () => {
    // Before the fix this returned null and the textarea stayed empty.
    expect(
      renderCommitPrefix(
        "feat/4729",
        config("{type}/{id}-{rest}", "{type} #{id} - "),
      ),
    ).toBe("feat #4729 - ");
  });

  test("trailing placeholder absorbs embedded dashes greedily", () => {
    // `{id}` stops at the first dash (`[^/-]+`), but `{rest}` is the last
    // placeholder so it's `.+` — it should swallow the whole tail including
    // additional dashes, leaving `id` as just the numeric chunk.
    expect(
      renderCommitPrefix(
        "feat/23423-discover-sopmething-something",
        config("{type}/{id}-{rest}", "{type} #{id} - "),
      ),
    ).toBe("feat #23423 - ");
  });

  test("substitutes missing trailing placeholder as empty string", () => {
    // If the user references `{rest}` in their template, an absent trailing
    // group must render as `""` rather than the literal `{rest}` token.
    expect(
      renderCommitPrefix(
        "feat/4729",
        config("{type}/{id}-{rest}", "{type} #{id} ({rest}) - "),
      ),
    ).toBe("feat #4729 () - ");
  });

  test("returns null when disabled", () => {
    expect(
      renderCommitPrefix("feat/4729", {
        enabled: false,
        branchPattern: "{type}/{id}-{rest}",
        template: "{type} #{id} - ",
      }),
    ).toBeNull();
  });

  test("returns null for empty branch / pattern / template", () => {
    expect(renderCommitPrefix("", config("{id}", "x"))).toBeNull();
    expect(renderCommitPrefix("abc", config("   ", "x"))).toBeNull();
    expect(renderCommitPrefix("abc", config("{id}", ""))).toBeNull();
  });

  test("returns null when the branch shape doesn't match", () => {
    // Non-matching shape (no slash separator at all).
    expect(
      renderCommitPrefix(
        "main",
        config("{type}/{id}-{rest}", "{type} #{id} - "),
      ),
    ).toBeNull();
  });
});
