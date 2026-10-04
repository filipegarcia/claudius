import { describe, expect, test } from "vitest";
import {
  parseUserConfig,
  readPluginOptions,
  setPluginOption,
} from "@/lib/shared/plugin-config";

/**
 * CC 2.1.285 (G3) — parse a plugin's userConfig schema and edit
 * pluginConfigs.<id>.options losslessly.
 */
describe("parseUserConfig (G3)", () => {
  test("normalizes types, including enum (options array) and sensitive", () => {
    const manifest = {
      userConfig: {
        system: { type: "string", title: "System", default: "" },
        track: { type: "string", title: "Track", default: "auto", options: ["auto", "transform"] },
        xray: { type: "boolean", title: "X-ray", default: true },
        count: { type: "integer", default: 5 },
        token: { type: "string", title: "API token", sensitive: true },
      },
    };
    const parsed = parseUserConfig(manifest);
    const byName = Object.fromEntries(parsed.map((o) => [o.name, o]));
    expect(byName.system.type).toBe("string");
    expect(byName.track.type).toBe("enum");
    expect(byName.track.options).toEqual(["auto", "transform"]);
    expect(byName.xray.type).toBe("boolean");
    expect(byName.xray.default).toBe(true);
    expect(byName.count.type).toBe("number");
    expect(byName.token.sensitive).toBe(true);
  });

  test("no userConfig → empty", () => {
    expect(parseUserConfig({ name: "x" })).toEqual([]);
    expect(parseUserConfig(undefined)).toEqual([]);
  });
});

describe("readPluginOptions (G3)", () => {
  test("reads the options values for a plugin id", () => {
    const pc = { "foo@mp": { options: { a: 1, b: "x" }, mcpServers: { s: { k: "v" } } } };
    expect(readPluginOptions(pc, "foo@mp")).toEqual({ a: 1, b: "x" });
  });
  test("missing plugin / options → empty", () => {
    expect(readPluginOptions({}, "foo@mp")).toEqual({});
    expect(readPluginOptions(undefined, "foo@mp")).toEqual({});
  });
});

describe("setPluginOption (G3)", () => {
  test("sets an option, preserving mcpServers and other plugins", () => {
    const pc = {
      "foo@mp": { options: { a: 1 }, mcpServers: { s: { k: "v" } } },
      "bar@mp": { options: { z: true } },
    };
    const next = setPluginOption(pc, "foo@mp", "b", "new");
    expect(next).toEqual({
      "foo@mp": { options: { a: 1, b: "new" }, mcpServers: { s: { k: "v" } } },
      "bar@mp": { options: { z: true } },
    });
  });

  test("clearing an option (undefined) prunes emptied containers", () => {
    const pc = { "foo@mp": { options: { a: 1 } } };
    // Removing the only option drops options, which empties the entry, which
    // empties the map → undefined (caller drops the key).
    expect(setPluginOption(pc, "foo@mp", "a", undefined)).toBeUndefined();
  });

  test("clearing one option keeps the entry when mcpServers remain", () => {
    const pc = { "foo@mp": { options: { a: 1 }, mcpServers: { s: {} } } };
    expect(setPluginOption(pc, "foo@mp", "a", undefined)).toEqual({
      "foo@mp": { mcpServers: { s: {} } },
    });
  });

  test("does not mutate the input", () => {
    const pc = { "foo@mp": { options: { a: 1 } } };
    setPluginOption(pc, "foo@mp", "b", 2);
    expect(pc).toEqual({ "foo@mp": { options: { a: 1 } } });
  });
});
