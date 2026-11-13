import { describe, expect, test } from "vitest";
import { describeInvalidConfigFile, parseInvalidConfigFile } from "@/lib/shared/invalid-config-file";

// SDK 0.3.325 — `invalid_config_file` on a `config_file_invalid` startup failure.
describe("invalid_config_file (SDK 0.3.325)", () => {
  test("parses the snake_case wire shape", () => {
    expect(
      parseInvalidConfigFile({
        path: "/home/u/.claude.json",
        is_global: true,
        backup_searched: true,
        backup_path: "/home/u/.claude/backups/.claude.json.bak",
      }),
    ).toEqual({
      path: "/home/u/.claude.json",
      isGlobal: true,
      backupSearched: true,
      backupPath: "/home/u/.claude/backups/.claude.json.bak",
    });
  });

  test("returns undefined for absent / malformed input", () => {
    expect(parseInvalidConfigFile(undefined)).toBeUndefined();
    expect(parseInvalidConfigFile("x")).toBeUndefined();
    expect(parseInvalidConfigFile({ is_global: true })).toBeUndefined();
    expect(parseInvalidConfigFile({ path: "" })).toBeUndefined();
  });

  test("names the file and the backup", () => {
    const t = describeInvalidConfigFile({
      path: "/a/.claude.json",
      is_global: true,
      backup_searched: true,
      backup_path: "/a/backup.json",
    });
    expect(t).toContain("/a/.claude.json");
    expect(t).toContain("/a/backup.json");
    expect(t).toContain("parses");
  });

  test("global config with a completed search but no backup says so", () => {
    expect(
      describeInvalidConfigFile({ path: "/a/.claude.json", is_global: true, backup_searched: true }),
    ).toContain("No backup");
  });

  test("non-global file with no backup says nothing about backups", () => {
    const t = describeInvalidConfigFile({ path: "/p/.claude/settings.json", is_global: false, backup_searched: false });
    expect(t).toContain("/p/.claude/settings.json");
    expect(t).not.toContain("backup");
  });

  test("empty string when the field is absent; paths are cleaned and bounded", () => {
    expect(describeInvalidConfigFile(undefined)).toBe("");
    const t = describeInvalidConfigFile({ path: "/a‮/b\n" + "x".repeat(1000), is_global: false, backup_searched: false });
    expect(t).not.toMatch(/[‮\n]/);
    expect(t.length).toBeLessThan(400);
  });
});
