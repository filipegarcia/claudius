import { describe, expect, test } from "vitest";
import {
  MARKETPLACE_TRUST_NOTE,
  PLUGIN_INSTALL_TRUST_WARNING,
  PLUGIN_RUNS_CODE_NOTE,
} from "@/lib/shared/plugin-trust";

// CC 2.1.325 — the engine's "plugins can run code" copy, verbatim. Pinned so a
// casual rewording doesn't drift Claudius away from what the terminal says.
describe("plugin trust copy (CC 2.1.325)", () => {
  test("short note is the engine's one-liner", () => {
    expect(PLUGIN_RUNS_CODE_NOTE).toBe("Plugins can run code on your computer, with access to your files and shell.");
  });

  test("install warning leads with the one-liner and keeps the engine's full text", () => {
    expect(PLUGIN_INSTALL_TRUST_WARNING.startsWith(`${PLUGIN_RUNS_CODE_NOTE} `)).toBe(true);
    expect(PLUGIN_INSTALL_TRUST_WARNING).toBe(
      "Plugins can run code on your computer, with access to your files and shell. Make sure you trust a plugin " +
        "before installing, updating, or using it. Anthropic does not control what MCP servers, files, or other " +
        "software are included in plugins and cannot verify that they will work as intended or that they won't " +
        "change. See each plugin's homepage for more information.",
    );
  });

  test("marketplace note is the engine's add-marketplace confirmation copy", () => {
    expect(MARKETPLACE_TRUST_NOTE).toBe(
      "Plugins from this marketplace can run code on your computer, with access to your files and shell. " +
        "Only add marketplaces you trust.",
    );
  });

  test("no double spaces from the string concatenation", () => {
    for (const s of [PLUGIN_INSTALL_TRUST_WARNING, MARKETPLACE_TRUST_NOTE]) {
      expect(s).not.toMatch(/\s{2,}/);
    }
  });
});
