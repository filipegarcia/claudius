import { describe, expect, test } from "vitest";
import { lintMarketplaceName, lintMarketplaceRef, lintPluginRef } from "@/lib/shared/plugin-ref-lint";

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

  // CC 2.1.275 parity — `/plugin install <plugin> --marketplace <source>`
  describe("--marketplace flag", () => {
    test("accepts a bare name with --marketplace <source>", () => {
      expect(lintPluginRef("frontend-design --marketplace owner/repo")).toBeNull();
      expect(
        lintPluginRef("frontend-design --marketplace git+https://example.com/mkt"),
      ).toBeNull();
    });

    test("accepts name@marketplace with --marketplace <source>", () => {
      expect(
        lintPluginRef("frontend-design@claude-plugins-official --marketplace owner/repo"),
      ).toBeNull();
    });

    test("does not flag the two-token form as containing spaces", () => {
      // Would previously fire the generic "can't contain spaces" warning —
      // this is the one legitimate multi-token ref.
      const warning = lintPluginRef("frontend-design --marketplace owner/repo");
      expect(warning).toBeNull();
    });

    test("still flags an invalid plugin name before --marketplace", () => {
      expect(lintPluginRef("bad!name --marketplace owner/repo")).not.toBeNull();
    });

    test("flags a missing source after --marketplace", () => {
      expect(lintPluginRef("frontend-design --marketplace")).not.toBeNull();
    });

    test("flags unrelated multi-word input that isn't the --marketplace form", () => {
      expect(lintPluginRef("my plugin --something owner/repo")).not.toBeNull();
    });
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

/**
 * CC 2.1.295 parity — "Fixed claude plugin marketplace add reporting success
 * for a marketplace whose name no plugin can be installed under; such an add
 * is now refused".
 */
describe("lintMarketplaceName", () => {
  const someone = { source: "github", repo: "someone/repo" };
  const anthropics = { source: "github", repo: "anthropics/claude-plugins-official" };

  test("accepts normal names", () => {
    expect(lintMarketplaceName("my-market", someone)).toBeNull();
    expect(lintMarketplaceName("acme.tools_v2", someone)).toBeNull();
    expect(lintMarketplaceName("Team1", { source: "url", url: "https://x/m.json" })).toBeNull();
  });

  test("accepts a prototype-key name like “constructor”", () => {
    expect(lintMarketplaceName("constructor", someone)).toBeNull();
  });

  test("ignores empty / whitespace-only input", () => {
    expect(lintMarketplaceName("")).toBeNull();
    expect(lintMarketplaceName("   ")).toBeNull();
  });

  test("refuses names no plugin can be installed under", () => {
    for (const bad of ["my market", "mkt@v1", "-leading", ".hidden", "a/b", "a..b", "bad!name"]) {
      const w = lintMarketplaceName(bad, someone);
      expect(w, bad).not.toBeNull();
      expect(w?.message).toContain("<plugin>@<marketplace>");
    }
  });

  test("refuses a reserved name from a non-Anthropic source", () => {
    const w = lintMarketplaceName("claude-plugins-official", someone);
    expect(w?.message).toContain("reserved for Anthropic");
    expect(lintMarketplaceName("Healthcare", someone)).not.toBeNull();
    expect(
      lintMarketplaceName("agent-skills", { source: "url", url: "https://anthropics/x.json" }),
    ).not.toBeNull();
    // No source yet → can't be an anthropics/ repo, so still refused.
    expect(lintMarketplaceName("claude-plugins-official")).not.toBeNull();
    // Look-alike org prefix isn't the anthropics org.
    expect(
      lintMarketplaceName("claude-plugins-official", { source: "github", repo: "anthropics-fake/x" }),
    ).not.toBeNull();
  });

  test("refuses install-routing suffix names regardless of source", () => {
    for (const bad of ["npm", "GitHub", "gh", "pip", "uv", "cargo"]) {
      expect(lintMarketplaceName(bad, someone)?.message, bad).toContain("reserved for plugins installed");
    }
    expect(lintMarketplaceName("npm", { source: "github", repo: "anthropics/npm" })).not.toBeNull();
    // Only the exact suffix — names that merely contain one are fine.
    expect(lintMarketplaceName("npm-tools", someone)).toBeNull();
  });

  test("refuses built-in plugin source names regardless of source", () => {
    const cases: Array<[string, string]> = [
      ["inline", "reserved for --plugin-dir session plugins"],
      ["builtin", "reserved for built-in plugins"],
      ["Skills-Dir", "reserved for plugins auto-loaded from .claude/skills/"],
      ["synced", "reserved for plugins synced from your claude.ai account"],
      ["claude-plugin-test", "reserved for plugins loaded by claude plugin test"],
    ];
    for (const [bad, msg] of cases) {
      expect(lintMarketplaceName(bad, someone)?.message, bad).toContain(msg);
    }
    expect(
      lintMarketplaceName("builtin", { source: "github", repo: "anthropics/builtin" }),
    ).not.toBeNull();
    expect(lintMarketplaceName("builtin-extras", someone)).toBeNull();
  });

  test("allows a reserved name from an anthropics/ GitHub source", () => {
    expect(lintMarketplaceName("claude-plugins-official", anthropics)).toBeNull();
    expect(lintMarketplaceName("healthcare", { source: "github", repo: "Anthropics/hc" })).toBeNull();
  });
});
