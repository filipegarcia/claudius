import { describe, expect, test } from "vitest";
import { mergePluginMeta, pluginSubdirFromSource } from "@/lib/shared/plugin-metadata";

/**
 * CC 2.1.265 (G2) — plugin display metadata: marketplace entry wins, else the
 * plugin's own plugin.json.
 */
describe("pluginSubdirFromSource (G2)", () => {
  test("string source (strips leading ./)", () => {
    expect(pluginSubdirFromSource("./plugins/foo")).toBe("plugins/foo");
    expect(pluginSubdirFromSource("plugins/bar")).toBe("plugins/bar");
  });
  test("object source uses .path", () => {
    expect(pluginSubdirFromSource({ source: "git-subdir", path: "plugins/api", ref: "v1" })).toBe(
      "plugins/api",
    );
  });
  test("no derivable subdir → null", () => {
    expect(pluginSubdirFromSource({ source: "github", repo: "o/r" })).toBeNull();
    expect(pluginSubdirFromSource(undefined)).toBeNull();
    expect(pluginSubdirFromSource("")).toBeNull();
  });
});

describe("mergePluginMeta (G2)", () => {
  test("marketplace entry wins when present", () => {
    expect(
      mergePluginMeta(
        { description: "entry desc", displayName: "Entry Name" },
        { description: "manifest desc", displayName: "Manifest Name" },
      ),
    ).toEqual({ description: "entry desc", displayName: "Entry Name" });
  });

  test("falls back to the plugin manifest when the entry omits a field", () => {
    expect(mergePluginMeta({ displayName: "Entry Name" }, { description: "manifest desc" })).toEqual({
      description: "manifest desc",
      displayName: "Entry Name",
    });
  });

  test("blank entry values are treated as absent", () => {
    expect(mergePluginMeta({ description: "   " }, { description: "manifest desc" })).toEqual({
      description: "manifest desc",
      displayName: undefined,
    });
  });

  test("both missing → all undefined", () => {
    expect(mergePluginMeta(undefined, undefined)).toEqual({
      description: undefined,
      displayName: undefined,
    });
  });
});
