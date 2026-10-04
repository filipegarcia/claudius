import { describe, expect, test } from "vitest";
import {
  addExtraMarketplace,
  isLegacyExtra,
  readExtraMarketplaces,
  readPolicyMarketplaces,
  redactSource,
  removeExtraMarketplace,
  removePolicyMarketplace,
  sourceLabel,
  validateAddSource,
} from "@/lib/shared/marketplace-settings";

/**
 * CC 2.1.223/2.1.232/2.1.238 (G1) — lossless, non-corrupting, redacted
 * marketplace settings operations.
 */
describe("redactSource (G1)", () => {
  test("withholds header VALUES, keeps only key names + helper flag", () => {
    const view = redactSource({
      source: "url",
      url: "https://ex.com/m.json",
      headers: { Authorization: "Bearer secret-token", "X-Key": "abc" },
      headersHelper: "get-token.sh",
    });
    expect(view.kind).toBe("url");
    expect(view.label).toBe("https://ex.com/m.json");
    expect(view.headerKeys.sort()).toEqual(["Authorization", "X-Key"]);
    expect(view.hasHeadersHelper).toBe(true);
    // The secret value must never appear anywhere in the view.
    expect(JSON.stringify(view)).not.toContain("secret-token");
  });

  test("labels each known source kind", () => {
    expect(sourceLabel({ source: "github", repo: "owner/repo", ref: "main" })).toBe("owner/repo@main");
    expect(sourceLabel({ source: "npm", package: "@acme/mp", version: "1.2.0" })).toBe("@acme/mp@1.2.0");
    expect(sourceLabel({ source: "directory", path: "/opt/mp" })).toBe("/opt/mp");
  });

  test("an unknown source kind is opaque, not dropped", () => {
    const view = redactSource({ source: "archive", archiveUrl: "x" });
    expect(view.kind).toBe("archive");
  });
});

describe("readExtraMarketplaces (G1)", () => {
  test("reads the real object map (was dropped as empty before G1)", () => {
    const raw = {
      official: { source: { source: "github", repo: "anthropics/official" } },
      internal: { source: { source: "url", url: "https://ex.com/m.json", headers: { A: "t" } } },
    };
    const views = readExtraMarketplaces(raw);
    expect(views.map((v) => v.name).sort()).toEqual(["internal", "official"]);
    expect(views.find((v) => v.name === "internal")?.headerKeys).toEqual(["A"]);
  });

  test("flags a legacy string[] shape", () => {
    const views = readExtraMarketplaces(["owner/repo", "https://x/m.json"]);
    expect(views).toHaveLength(2);
    expect(views.every((v) => v.legacy)).toBe(true);
    expect(isLegacyExtra(["x"])).toBe(true);
    expect(isLegacyExtra({})).toBe(false);
  });
});

describe("readPolicyMarketplaces (G1)", () => {
  test("reads an array of source objects", () => {
    const raw = [
      { source: "github", repo: "owner/*" },
      { source: "url", url: "https://ex.com/m.json" },
    ];
    expect(readPolicyMarketplaces(raw).map((v) => v.label)).toEqual(["owner/*", "https://ex.com/m.json"]);
  });
  test("flags a legacy boolean (true)", () => {
    expect(readPolicyMarketplaces(true)[0].legacy).toBe(true);
    expect(readPolicyMarketplaces(false)).toEqual([]);
  });
});

describe("addExtraMarketplace (G1)", () => {
  test("adds a named entry, preserving every other entry byte-for-byte", () => {
    const raw = {
      keep: { source: { source: "url", url: "https://a", headers: { A: "tok" }, headersHelper: "h.sh" } },
    };
    const res = addExtraMarketplace(raw, "new", { source: "github", repo: "o/r" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      // Untouched entry, including its secret header value, is identical.
      expect(res.value.keep).toEqual(raw.keep);
      expect(res.value.new).toEqual({ source: { source: "github", repo: "o/r" } });
    }
  });

  test("refuses when a legacy array is stored (names can't be reconstructed)", () => {
    const res = addExtraMarketplace(["owner/repo"], "x", { source: "github", repo: "o/r" });
    expect(res.ok).toBe(false);
  });

  test("rejects a wildcard repo and a non-http url", () => {
    expect(addExtraMarketplace({}, "x", { source: "github", repo: "owner/*" }).ok).toBe(false);
    expect(addExtraMarketplace({}, "x", { source: "url", url: "ftp://x" }).ok).toBe(false);
    expect(validateAddSource({ source: "github", repo: "owner/repo" }).ok).toBe(true);
  });
});

describe("removeExtraMarketplace (G1)", () => {
  test("removes one key, preserves the rest", () => {
    const raw = { a: { source: { source: "url", url: "x" } }, b: { source: { source: "url", url: "y" } } };
    expect(removeExtraMarketplace(raw, "a")).toEqual({ b: { source: { source: "url", url: "y" } } });
  });
  test("returns undefined when the map empties", () => {
    expect(removeExtraMarketplace({ a: { source: { source: "url", url: "x" } } }, "a")).toBeUndefined();
  });
  test("removes a legacy array string entry", () => {
    expect(removeExtraMarketplace(["a", "b"], "a")).toEqual(["b"]);
    expect(removeExtraMarketplace(["a"], "a")).toBeUndefined();
  });
});

describe("removePolicyMarketplace (G1)", () => {
  test("removes one array entry by index, preserving the others", () => {
    const raw = [{ source: "url", url: "a" }, { source: "url", url: "b" }, { source: "url", url: "c" }];
    expect(removePolicyMarketplace(raw, 1)).toEqual([
      { source: "url", url: "a" },
      { source: "url", url: "c" },
    ]);
  });
  test("returns undefined when the array empties or the shape is legacy", () => {
    expect(removePolicyMarketplace([{ source: "url", url: "a" }], 0)).toBeUndefined();
    expect(removePolicyMarketplace(true, 0)).toBeUndefined();
  });
});
