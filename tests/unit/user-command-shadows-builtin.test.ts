import { describe, expect, test } from "vitest";
import { userCommandShadowsBuiltin, type SdkSlashCommandInfo } from "@/lib/shared/slash-commands";

/**
 * CC 2.1.287 (FIX) — a user/project/plugin command that shares a name with a
 * built-in must run the user's command, not the built-in dialog. The SDK's
 * `supportedCommands()` carries a `builtin` flag; a non-builtin entry of the
 * same name signals the user has overridden it.
 */
describe("userCommandShadowsBuiltin (CC 2.1.287 — D3)", () => {
  test("forwards only when the user's command has fully replaced the built-in", () => {
    // User's /usage is the sole row (unmarked, no built-in row) → forward.
    expect(userCommandShadowsBuiltin("usage", [{ name: "usage" }])).toBe(true);
  });

  test("does NOT forward when a marked built-in row of the name still exists", () => {
    // Per the SDK contract, `/usage` runs the MARKED row when both exist — so
    // Claudius keeps its native dialog rather than forwarding to CLI output.
    const sdk: SdkSlashCommandInfo[] = [
      { name: "usage", builtin: true },
      { name: "usage" }, // unmarked, but the marked one wins
    ];
    expect(userCommandShadowsBuiltin("usage", sdk)).toBe(false);
  });

  test("does NOT forward when only the built-in dialog exists", () => {
    const sdk: SdkSlashCommandInfo[] = [{ name: "usage", builtin: true }];
    expect(userCommandShadowsBuiltin("usage", sdk)).toBe(false);
  });

  test("does NOT hijack a Claudius-native command that a bundled skill shares (the regression)", () => {
    // Bundled skills/plugins/MCP are ALSO unmarked — a coincidental `schedule`
    // or `review` skill must not steal Claudius's native handler.
    const sdk: SdkSlashCommandInfo[] = [{ name: "schedule" }, { name: "review" }, { name: "goal" }];
    expect(userCommandShadowsBuiltin("schedule", sdk)).toBe(false);
    expect(userCommandShadowsBuiltin("review", sdk)).toBe(false);
    expect(userCommandShadowsBuiltin("goal", sdk)).toBe(false);
  });

  test("no SDK list / no match → no shadow", () => {
    expect(userCommandShadowsBuiltin("usage", undefined)).toBe(false);
    expect(userCommandShadowsBuiltin("context", [{ name: "context", builtin: true }])).toBe(false);
  });
});
