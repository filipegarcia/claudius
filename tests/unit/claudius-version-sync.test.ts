import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  readMainInstalledRange,
  syncClaudiusVersionToSdk,
  syncedClaudiusVersion,
} from "../../scripts/sdk-update/check";

// Claudius's version follows the SDK it ships (SDK 0.3.N ↔ Claude Code
// 2.1.N). The two pipelines used to disagree: cc-parity added one to the
// patch (0.3.323 → 0.3.324, a version Claude Code never had), and the SDK
// pipeline then set it back down (PR #364, 0.3.324 → 0.3.323), which would
// have cut every v0.3.324.0 install off from auto-updates.

describe("syncedClaudiusVersion", () => {
  test("moves up to a newer SDK version", () => {
    expect(syncedClaudiusVersion("0.3.322", "0.3.323")).toBe("0.3.323");
  });

  test("never lowers a version that's already ahead (PR #364)", () => {
    expect(syncedClaudiusVersion("0.3.324", "0.3.323")).toBe("0.3.324");
  });

  test("leaves an equal version alone", () => {
    expect(syncedClaudiusVersion("0.3.323", "0.3.323")).toBe("0.3.323");
  });

  test("takes a dependency range and returns a bare version", () => {
    expect(syncedClaudiusVersion("0.3.322", "^0.3.323")).toBe("0.3.323");
  });

  test("never invents a version past the SDK", () => {
    // cc-parity's old patch+1 would have produced 0.3.324 here.
    expect(syncedClaudiusVersion("0.3.323", "^0.3.323")).toBe("0.3.323");
  });

  test("leaves an unparseable current version untouched rather than guessing", () => {
    expect(syncedClaudiusVersion("not-a-version", "0.3.323")).toBe("not-a-version");
  });
});

describe("syncClaudiusVersionToSdk", () => {
  let dir: string;
  const pkg = (version: string, sdk: string) =>
    `{\n  "name": "claudius",\n  "version": "${version}",\n  "private": true,\n` +
    `  "dependencies": {\n    "@anthropic-ai/claude-agent-sdk": "${sdk}"\n  }\n}\n`;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudius-version-sync-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("rewrites only the top-level version and keeps formatting", () => {
    writeFileSync(join(dir, "package.json"), pkg("0.3.322", "^0.3.323"));
    expect(syncClaudiusVersionToSdk("0.3.323", dir)).toEqual({
      from: "0.3.322",
      to: "0.3.323",
      changed: true,
    });
    expect(readFileSync(join(dir, "package.json"), "utf8")).toBe(pkg("0.3.323", "^0.3.323"));
  });

  test("doesn't touch the file when the version is already ahead", () => {
    const before = pkg("0.3.324", "^0.3.323");
    writeFileSync(join(dir, "package.json"), before);
    expect(syncClaudiusVersionToSdk("^0.3.323", dir)).toEqual({
      from: "0.3.324",
      to: "0.3.324",
      changed: false,
    });
    expect(readFileSync(join(dir, "package.json"), "utf8")).toBe(before);
  });

  test("throws on a package.json with no version", () => {
    writeFileSync(join(dir, "package.json"), `{ "name": "claudius" }\n`);
    expect(() => syncClaudiusVersionToSdk("0.3.323", dir)).toThrow(/pattern miss/);
  });
});

describe("readMainInstalledRange", () => {
  let base: string;
  let savedEnv: NodeJS.ProcessEnv;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const sdkPkg = (sdk: string) =>
    JSON.stringify({ name: "claudius", version: "0.3.0", dependencies: { "@anthropic-ai/claude-agent-sdk": sdk } }, null, 2) + "\n";

  beforeEach(() => {
    // readMainInstalledRange spawns git itself, so strip GIT_* from THIS
    // process: unit tests run from the pre-commit hook, where git exports
    // GIT_DIR / GIT_INDEX_FILE and every git call would hit the outer repo.
    savedEnv = { ...process.env };
    for (const k of Object.keys(process.env)) {
      if (k.startsWith("GIT_")) delete process.env[k];
    }
    Object.assign(process.env, {
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    });
    expect(["GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE", "GIT_COMMON_DIR"].filter((k) => k in process.env)).toEqual([]);
    base = realpathSync(mkdtempSync(join(tmpdir(), "claudius-main-range-")));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
    for (const k of Object.keys(process.env)) {
      if (!(k in savedEnv)) delete process.env[k];
    }
    Object.assign(process.env, savedEnv);
  });

  test("reads origin/main, not a stale local checkout (PR #364)", () => {
    // "upstream" plays GitHub: main moves to ^0.3.323 after the clone
    // was taken, like #362 merging while the cron's checkout sat still.
    const upstream = join(base, "upstream");
    const clone = join(base, "clone");
    execFileSync("git", ["init", "-q", "-b", "main", upstream]);
    writeFileSync(join(upstream, "package.json"), sdkPkg("^0.3.322"));
    git(upstream, "add", "-A");
    git(upstream, "commit", "-q", "-m", "sdk 0.3.322");
    execFileSync("git", ["clone", "-q", upstream, clone]);
    expect(realpathSync(git(clone, "rev-parse", "--show-toplevel"))).toBe(clone);
    writeFileSync(join(upstream, "package.json"), sdkPkg("^0.3.323"));
    git(upstream, "commit", "-q", "-am", "sdk 0.3.323");

    const warnings: string[] = [];
    expect(readMainInstalledRange(clone, (m) => warnings.push(m))).toBe("^0.3.323");
    expect(warnings).toEqual([]);
    // The working tree itself is untouched (still the stale range).
    expect(JSON.parse(readFileSync(join(clone, "package.json"), "utf8")).dependencies["@anthropic-ai/claude-agent-sdk"]).toBe("^0.3.322");
  });

  test("falls back to the working tree, with a warning, when git can't answer", () => {
    const notARepo = join(base, "plain");
    execFileSync("mkdir", [notARepo]);
    writeFileSync(join(notARepo, "package.json"), sdkPkg("^0.3.321"));
    // GIT_CEILING_DIRECTORIES stops git from walking up into any repo
    // that happens to enclose the temp dir.
    process.env.GIT_CEILING_DIRECTORIES = base;

    const warnings: string[] = [];
    expect(readMainInstalledRange(notARepo, (m) => warnings.push(m))).toBe("^0.3.321");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/falling back to the working tree/);
  });
});
