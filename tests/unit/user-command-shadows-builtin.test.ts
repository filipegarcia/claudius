import { describe, expect, test } from "vitest";
import { userCommandShadowsBuiltin, type SdkSlashCommandInfo } from "@/lib/shared/slash-commands";

/**
 * CC 2.1.287 (FIX) — a user/project/plugin command that shares a name with a
 * built-in must run the user's command, not the built-in dialog. The SDK's
 * `supportedCommands()` carries a `builtin` flag; a non-builtin entry of the
 * same name signals the user has overridden it.
 */
describe("userCommandShadowsBuiltin (CC 2.1.287 — D3)", () => {
  const sdk: SdkSlashCommandInfo[] = [
    { name: "usage", builtin: true }, // Claude Code's own
    { name: "deploy", builtin: false }, // a user/project command
    { name: "review" }, // no flag → treated as user-defined
  ];

  test("forwards when a non-builtin command of this name exists", () => {
    expect(userCommandShadowsBuiltin("deploy", sdk)).toBe(true);
    expect(userCommandShadowsBuiltin("review", sdk)).toBe(true);
  });

  test("does NOT forward for a built-in-only command", () => {
    expect(userCommandShadowsBuiltin("usage", sdk)).toBe(false);
  });

  test("no SDK list / no match → no shadow", () => {
    expect(userCommandShadowsBuiltin("deploy", undefined)).toBe(false);
    expect(userCommandShadowsBuiltin("context", sdk)).toBe(false);
  });
});
