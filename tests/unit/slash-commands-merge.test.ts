import { describe, expect, test } from "vitest";
import {
  SLASH_COMMANDS,
  mergeSuggestions,
  type SdkSlashCommandInfo,
} from "@/lib/shared/slash-commands";

/**
 * Coverage for mergeSuggestions, the merge of the curated static registry with
 * the live SDK command list. B1.5 added the optional rich-commands source
 * (from supportedCommands()) so SDK/plugin commands show real descriptions
 * and argument hints, and so a command present only in the rich payload is
 * still surfaced. The curated registry stays authoritative for commands it
 * defines (notably the `handler` routing field).
 */
describe("mergeSuggestions", () => {
  test("backward compatible: without rich commands, SDK-only names get generic text", () => {
    const out = mergeSuggestions(["totally-custom-cmd"], []);
    const custom = out.find((c) => c.name === "totally-custom-cmd");
    expect(custom).toBeDefined();
    expect(custom!.source).toBe("sdk");
    expect(custom!.description).toBe("Provided by the SDK.");
    expect(custom!.handler).toBe("sdk");
  });

  test("SDK names that are skills get the skill placeholder + skill category", () => {
    const out = mergeSuggestions(["my-skill"], ["my-skill"]);
    const skill = out.find((c) => c.name === "my-skill");
    expect(skill!.source).toBe("skill");
    expect(skill!.category).toBe("skill");
    expect(skill!.description).toBe("Skill provided by the SDK.");
  });

  test("rich commands upgrade SDK-only entries with real description + argsHint + aliases", () => {
    const rich: SdkSlashCommandInfo[] = [
      {
        name: "deploy",
        description: "Deploy the current branch",
        argumentHint: "<env>",
        aliases: ["ship"],
      },
    ];
    const out = mergeSuggestions(["deploy"], [], rich);
    const deploy = out.find((c) => c.name === "deploy");
    expect(deploy!.description).toBe("Deploy the current branch");
    expect(deploy!.argsHint).toBe("<env>");
    expect(deploy!.aliases).toEqual(["ship"]);
  });

  test("a rich command absent from the init names list is still surfaced", () => {
    const rich: SdkSlashCommandInfo[] = [{ name: "only-in-rich", description: "Rich only" }];
    const out = mergeSuggestions([], [], rich);
    const cmd = out.find((c) => c.name === "only-in-rich");
    expect(cmd).toBeDefined();
    expect(cmd!.description).toBe("Rich only");
  });

  test("the curated registry wins for commands it defines (handler preserved)", () => {
    // `clear` is a native registry command. Even if the SDK reports it (with a
    // different description), the registry entry — and its native handler —
    // must be the one surfaced, so the web app keeps intercepting it.
    const rich: SdkSlashCommandInfo[] = [
      { name: "clear", description: "SDK's own description for clear" },
    ];
    const out = mergeSuggestions(["clear"], [], rich);
    const clears = out.filter((c) => c.name === "clear");
    expect(clears).toHaveLength(1);
    expect(clears[0].source).toBe("registry");
    expect(clears[0].handler).toBe("native");
    expect(clears[0].description).not.toBe("SDK's own description for clear");
  });

  test("does not duplicate a command present in both the init list and rich payload", () => {
    const rich: SdkSlashCommandInfo[] = [{ name: "custom", description: "Custom cmd" }];
    const out = mergeSuggestions(["custom"], [], rich);
    expect(out.filter((c) => c.name === "custom")).toHaveLength(1);
  });

  test("always includes the full static registry", () => {
    const out = mergeSuggestions(undefined, undefined);
    for (const cmd of SLASH_COMMANDS) {
      expect(out.some((c) => c.id === cmd.id)).toBe(true);
    }
  });

  test("blank rich description/argumentHint fall back to placeholder (no empty strings)", () => {
    const rich: SdkSlashCommandInfo[] = [
      { name: "blanky", description: "   ", argumentHint: "  " },
    ];
    const out = mergeSuggestions(["blanky"], [], rich);
    const cmd = out.find((c) => c.name === "blanky")!;
    expect(cmd.description).toBe("Provided by the SDK.");
    expect(cmd.argsHint).toBeUndefined();
  });
});
