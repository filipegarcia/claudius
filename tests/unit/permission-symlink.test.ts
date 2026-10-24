import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { permissionFilePath, resolvePermissionSymlink } from "@/lib/server/permission-symlink";

/**
 * CC 2.1.310 — "Fixed file read permission prompts not showing where a
 * symbolic link leads." Claudius resolves the link server-side (the SDK
 * doesn't forward the engine's `symlinkTarget`). Uses real links in a tmp dir;
 * the tmp root is realpath'd first because on macOS `/var/folders` is itself
 * a link into `/private`.
 */

let root: string;
let cwd: string;
let outside: string;
let extra: string;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "perm-symlink-")));
  cwd = join(root, "project");
  outside = join(root, "elsewhere");
  extra = join(root, "extra");
  for (const d of [cwd, outside, extra]) mkdirSync(d);
  writeFileSync(join(cwd, "real.txt"), "inside");
  writeFileSync(join(outside, "secret.txt"), "outside");
  writeFileSync(join(extra, "shared.txt"), "extra");
  symlinkSync(join(cwd, "real.txt"), join(cwd, "inside-link.txt"));
  symlinkSync(join(outside, "secret.txt"), join(cwd, "outside-link.txt"));
  symlinkSync(join(extra, "shared.txt"), join(cwd, "extra-link.txt"));
  // Chain: link → link → file. realpath follows the whole chain.
  symlinkSync(join(cwd, "outside-link.txt"), join(cwd, "chain-link.txt"));
  symlinkSync(join(root, "does-not-exist.txt"), join(cwd, "dangling.txt"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("permissionFilePath", () => {
  test("covers Read (read) and Edit/Write/NotebookEdit (modify)", () => {
    expect(permissionFilePath("Read", { file_path: "/a" })).toEqual({ path: "/a", operation: "read" });
    expect(permissionFilePath("Edit", { file_path: "/a" })).toEqual({ path: "/a", operation: "modify" });
    expect(permissionFilePath("Write", { file_path: "/a" })).toEqual({ path: "/a", operation: "modify" });
    expect(permissionFilePath("NotebookEdit", { notebook_path: "/n.ipynb" })).toEqual({
      path: "/n.ipynb",
      operation: "modify",
    });
  });

  test("ignores other tools and missing/non-string paths", () => {
    expect(permissionFilePath("Bash", { command: "cat x" })).toBeNull();
    expect(permissionFilePath("Read", {})).toBeNull();
    expect(permissionFilePath("Read", { file_path: 42 })).toBeNull();
    expect(permissionFilePath("Read", { file_path: "" })).toBeNull();
  });
});

describe("resolvePermissionSymlink", () => {
  test("regular file → null", async () => {
    expect(await resolvePermissionSymlink("Read", { file_path: join(cwd, "real.txt") }, cwd)).toBeNull();
  });

  test("link inside cwd → target, not flagged outside", async () => {
    expect(await resolvePermissionSymlink("Read", { file_path: join(cwd, "inside-link.txt") }, cwd)).toEqual({
      target: join(cwd, "real.txt"),
      outsideWorkingDirs: false,
      operation: "read",
    });
  });

  test("link leading outside cwd → flagged", async () => {
    expect(await resolvePermissionSymlink("Read", { file_path: join(cwd, "outside-link.txt") }, cwd)).toEqual({
      target: join(outside, "secret.txt"),
      outsideWorkingDirs: true,
      operation: "read",
    });
  });

  test("relative path resolves against the session cwd", async () => {
    const r = await resolvePermissionSymlink("Read", { file_path: "outside-link.txt" }, cwd);
    expect(r?.target).toBe(join(outside, "secret.txt"));
  });

  test("a chain of links resolves to the final file", async () => {
    const r = await resolvePermissionSymlink("Read", { file_path: join(cwd, "chain-link.txt") }, cwd);
    expect(r?.target).toBe(join(outside, "secret.txt"));
    expect(r?.outsideWorkingDirs).toBe(true);
  });

  test("an additional directory counts as a working directory", async () => {
    const input = { file_path: join(cwd, "extra-link.txt") };
    expect((await resolvePermissionSymlink("Read", input, cwd))?.outsideWorkingDirs).toBe(true);
    expect((await resolvePermissionSymlink("Read", input, cwd, [extra]))?.outsideWorkingDirs).toBe(false);
  });

  test("write tools report the modify operation", async () => {
    const r = await resolvePermissionSymlink("Edit", { file_path: join(cwd, "outside-link.txt") }, cwd);
    expect(r?.operation).toBe("modify");
  });

  test("dangling link, missing file, and non-file tools → null", async () => {
    expect(await resolvePermissionSymlink("Read", { file_path: join(cwd, "dangling.txt") }, cwd)).toBeNull();
    expect(await resolvePermissionSymlink("Write", { file_path: join(cwd, "new.txt") }, cwd)).toBeNull();
    expect(await resolvePermissionSymlink("Bash", { command: "cat outside-link.txt" }, cwd)).toBeNull();
  });
});
