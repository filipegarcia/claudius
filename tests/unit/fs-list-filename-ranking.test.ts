import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { listFs } from "@/lib/server/fs-list";

/**
 * CC 2.1.280 parity: "Improved `@` file suggestions: a file whose name
 * contains the query now ranks above one that only matches across its
 * folder names." Pins the ranking bonus added to `listFs`'s scorer.
 */
describe("listFs filename-match ranking", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "fs-list-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  test("a file whose own name contains the query outranks one that only matches via a parent folder, even when the folder-only match would otherwise score higher", async () => {
    // Deliberately chosen so the *pre-fix* scorer gets the order wrong:
    // `config-utils/index.ts` is a folder-*prefix* match on the full
    // relative path (`hay.startsWith("config")`, the highest pre-fix tier,
    // score ~1000 - len), even though its own filename ("index.ts") never
    // contains "config". `deep/nested/dir/config.ts` only scores a
    // substring match on the full path (~500 - idx - len/100, a lower
    // pre-fix tier) despite its filename being an exact match. Without the
    // basename bonus, the shallow folder-prefix match (~979) beats the
    // deep filename match (~484) — the exact bug upstream's fix
    // ("a file whose name contains the query now ranks above one that only
    // matches across its folder names") describes. This is the
    // discriminating case: it fails on the pre-fix scorer and only passes
    // once the +10000 basename bonus is applied.
    mkdirSync(join(cwd, "config-utils"), { recursive: true });
    writeFileSync(join(cwd, "config-utils", "index.ts"), "");
    mkdirSync(join(cwd, "deep", "nested", "dir"), { recursive: true });
    writeFileSync(join(cwd, "deep", "nested", "dir", "config.ts"), "");

    const entries = await listFs({ cwd, query: "config" });
    const paths = entries.map((e) => e.relPath);

    const filenameMatchIdx = paths.indexOf("deep/nested/dir/config.ts");
    const folderOnlyMatchIdx = paths.indexOf("config-utils/index.ts");

    expect(filenameMatchIdx).toBeGreaterThanOrEqual(0);
    expect(folderOnlyMatchIdx).toBeGreaterThanOrEqual(0);
    expect(filenameMatchIdx).toBeLessThan(folderOnlyMatchIdx);
  });

  test("prefix match on the filename still beats a later substring match on the filename", async () => {
    writeFileSync(join(cwd, "config.ts"), "");
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", "myconfig.ts"), "");

    const entries = await listFs({ cwd, query: "config" });
    const paths = entries.map((e) => e.relPath);

    expect(paths.indexOf("config.ts")).toBeLessThan(paths.indexOf("src/myconfig.ts"));
  });

  test("a folder-only match still surfaces (not dropped), just ranked behind filename matches", async () => {
    mkdirSync(join(cwd, "packages", "config"), { recursive: true });
    writeFileSync(join(cwd, "packages", "config", "index.ts"), "");

    const entries = await listFs({ cwd, query: "config" });
    expect(entries.map((e) => e.relPath)).toContain("packages/config/index.ts");
  });
});
