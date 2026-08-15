import { describe, expect, test } from "vitest";
import { lintMarketplaceRef, lintPluginRef } from "@/lib/shared/plugin-ref-lint";

/**
 * CC 2.1.221 parity — "Plugin validation warns on marketplace/name
 * rejection". Claudius surfaces this inline on the `/plugins` page (see
 * `app/plugins/page.tsx`); this covers the pure lint logic behind it.
 */
describe("lintPluginRef", () => {
  test("accepts a bare valid plugin name", () => {
    expect(lintPluginRef("frontend-design")).toBeNull();
    expect(lintPluginRef("a.b_c-1")).toBeNull();
  });

  test("accepts a valid name@marketplace ref", () => {
    expect(lintPluginRef("frontend-design@claude-plugins-official")).toBeNull();
  });

  test("tolerates a trailing @version segment", () => {
    expect(lintPluginRef("formatter@anthropic-tools@^1.0.0")).toBeNull();
  });

  test("flags spaces", () => {
    expect(lintPluginRef("my plugin")).not.toBeNull();
  });

  test("flags an invalid plugin name", () => {
    expect(lintPluginRef("bad!name")).not.toBeNull();
    expect(lintPluginRef("-leading-dash")).not.toBeNull();
  });

  test("flags a missing marketplace after @", () => {
    expect(lintPluginRef("plugin@")).not.toBeNull();
  });

  test("flags a missing plugin name before @", () => {
    expect(lintPluginRef("@marketplace")).not.toBeNull();
  });

  test("flags an invalid marketplace name", () => {
    expect(lintPluginRef("plugin@bad marketplace")).not.toBeNull();
    expect(lintPluginRef("plugin@bad!mkt")).not.toBeNull();
  });

  test("ignores empty / whitespace-only input", () => {
    expect(lintPluginRef("")).toBeNull();
    expect(lintPluginRef("   ")).toBeNull();
  });

  test("tolerates surrounding whitespace", () => {
    expect(lintPluginRef("  frontend-design@official  ")).toBeNull();
  });
});

describe("lintMarketplaceRef", () => {
  test("accepts owner/repo, git URLs, and paths", () => {
    expect(lintMarketplaceRef("anthropics/claude-plugins")).toBeNull();
    expect(lintMarketplaceRef("git+https://example.com/my-marketplace")).toBeNull();
    expect(lintMarketplaceRef("/opt/approved/marketplace")).toBeNull();
  });

  test("flags an owner/* wildcard outside policy lists", () => {
    expect(lintMarketplaceRef("anthropics/*")).not.toBeNull();
  });

  test("allows the owner/* wildcard when allowWildcard is set (blocked list)", () => {
    expect(lintMarketplaceRef("anthropics/*", { allowWildcard: true })).toBeNull();
  });

  test("flags spaces", () => {
    expect(lintMarketplaceRef("owner /repo")).not.toBeNull();
  });

  test("ignores empty / whitespace-only input", () => {
    expect(lintMarketplaceRef("")).toBeNull();
    expect(lintMarketplaceRef("   ")).toBeNull();
  });
});
