import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { readSettings, settingsSaveFailure, SettingsParseError } from "@/lib/server/settings";
import { settingsSaveFailedMessage } from "@/lib/shared/settings-load-error";

/**
 * CC 2.1.326 parity — "Fixed rules added in /permissions or at a
 * main-conversation tool prompt, and /add-dir folders, looking saved when the
 * settings file couldn't be written; the terminal now warns and names it".
 */

describe("settingsSaveFailedMessage", () => {
  test("a file that doesn't load is named with its reason", () => {
    const msg = settingsSaveFailedMessage("/p/.claude/settings.json", { parseReason: "Unexpected end of JSON input" });
    expect(msg).toContain("Not saved");
    expect(msg).toContain("/p/.claude/settings.json");
    expect(msg).toContain("Unexpected end of JSON input");
    expect(msg).toContain("It was not changed");
  });
  test("a write failure is named with its errno", () => {
    const msg = settingsSaveFailedMessage("/p/.claude/settings.json", { code: "EACCES" });
    expect(msg).toBe("Not saved: couldn't write /p/.claude/settings.json — permission denied (EACCES).");
    expect(settingsSaveFailedMessage("/x.json", { code: "EBUSY" })).toBe("Not saved: couldn't write /x.json — EBUSY.");
  });
  test("no code still names the file without claiming a write failed", () => {
    expect(settingsSaveFailedMessage("/x.json", {})).toBe("Not saved: couldn't update /x.json.");
  });
});

describe("settingsSaveFailure", () => {
  test("a malformed project settings file is a 422 naming it", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "claudius-326-"));
    mkdirSync(join(cwd, ".claude"));
    writeFileSync(join(cwd, ".claude", "settings.json"), "{ not json");
    const err = await readSettings("project", cwd).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SettingsParseError);
    const out = settingsSaveFailure("project", cwd, err);
    expect(out.status).toBe(422);
    expect(out.error).toContain(join(cwd, ".claude", "settings.json"));
    expect(out.error).not.toContain("not json");
  });
  test("an fs error is a 500 naming the scope's file and errno", () => {
    const cwd = mkdtempSync(join(tmpdir(), "claudius-326-"));
    const err = Object.assign(new Error("permission denied"), { code: "EROFS" });
    const out = settingsSaveFailure("local", cwd, err);
    expect(out.status).toBe(500);
    expect(out.error).toContain(join(cwd, ".claude", "settings.local.json"));
    expect(out.error).toContain("read-only file system (EROFS)");
  });
});
