import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * The Settings page's `SDK_SETTINGS_CATALOG` must list each key once: a
 * duplicate renders two rows bound to the same setting (idleCompaction was
 * in both "Model & behavior" and "Context & compaction"). The catalog lives
 * in a Next page module, which may not export it, so read its source.
 */
function catalogKeys(): string[] {
  const src = readFileSync(resolve(__dirname, "../../app/settings/page.tsx"), "utf8");
  const start = src.indexOf("const SDK_SETTINGS_CATALOG");
  const end = src.indexOf("const CATALOG_KEYS", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const block = src.slice(start, end);
  return [...block.matchAll(/^\s+key: "([^"]+)",$/gm)].map((m) => m[1]);
}

describe("SDK_SETTINGS_CATALOG", () => {
  test("lists each settings key once", () => {
    const keys = catalogKeys();
    expect(keys.length).toBeGreaterThan(50);
    const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
    expect(dupes).toEqual([]);
  });

  test("idleCompaction lives under Context & compaction", () => {
    const src = readFileSync(resolve(__dirname, "../../app/settings/page.tsx"), "utf8");
    expect(src).toMatch(/key: "idleCompaction",\s+type: "boolean",\s+section: "Context & compaction",/);
  });
});
