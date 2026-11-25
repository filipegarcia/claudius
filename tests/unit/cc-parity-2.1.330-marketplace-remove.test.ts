import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { POST } from "@/app/api/plugins/route";
import { removePolicyMarketplaceEntry } from "@/lib/server/plugins";
import { policyEntryMatches, redactSource } from "@/lib/shared/marketplace-settings";
import { createWorkspace } from "@/lib/server/workspaces-store";
import { makeTempHome, type TmpHome } from "./helpers/tmp-home";

/**
 * CC 2.1.330 — "Fixed … a double click on Remove or Delete removing a memory,
 * MCP server or plugin marketplace, without confirmation".
 *
 * On /plugins, policy marketplace entries (strictKnownMarketplaces /
 * blockedMarketplaces) were removed by index alone, so a double click sent
 * `remove-policy index i` twice and the second request removed the entry
 * that had shifted into `i`. The removal now carries the entry the user
 * clicked on, and the server removes only when the entry at `index` still
 * matches it.
 */

const A = { source: "github", repo: "acme/a" };
const B = { source: "github", repo: "acme/b", headers: { Authorization: "Bearer secret" } };
const C = { source: "url", url: "https://example.com/marketplace.json" };

describe("policyEntryMatches", () => {
  test("matches the redacted view of the entry at that index", () => {
    expect(policyEntryMatches([A, B], 1, redactSource(B))).toBe(true);
    expect(policyEntryMatches([A, B], 0, redactSource(B))).toBe(false);
    expect(policyEntryMatches([A], 1, redactSource(B))).toBe(false);
  });

  test("a different header set is a different entry", () => {
    expect(policyEntryMatches([B], 0, { kind: "github", label: "acme/b", headerKeys: [] })).toBe(false);
    expect(policyEntryMatches([B], 0, { kind: "github", label: "acme/b" })).toBe(true);
  });

  test("the legacy boolean row matches its shown view", () => {
    expect(policyEntryMatches(true, 0, { kind: "legacy", label: "true" })).toBe(true);
  });
});

describe("removePolicyMarketplaceEntry", () => {
  let home: TmpHome;
  let root: string;
  let settingsFile: string;

  beforeEach(() => {
    home = makeTempHome();
    root = mkdtempSync(join(home.home, "proj-"));
    mkdirSync(join(root, ".claude"), { recursive: true });
    settingsFile = join(root, ".claude", "settings.json");
    writeFileSync(settingsFile, JSON.stringify({ blockedMarketplaces: [A, B, C] }));
  });
  afterEach(() => home.restore());

  const blocked = () => (JSON.parse(readFileSync(settingsFile, "utf8")) as { blockedMarketplaces?: unknown[] }).blockedMarketplaces;

  test("a repeated removal of the same entry is a no-op", async () => {
    expect(await removePolicyMarketplaceEntry("project", root, "blocked", 1, redactSource(B))).toBe(true);
    expect(blocked()).toEqual([A, C]);
    // The double click's second request: index 1 now holds C, not B.
    expect(await removePolicyMarketplaceEntry("project", root, "blocked", 1, redactSource(B))).toBe(false);
    expect(blocked()).toEqual([A, C]);
  });

  test("a stale index past the end is a no-op", async () => {
    expect(await removePolicyMarketplaceEntry("project", root, "blocked", 5, redactSource(C))).toBe(false);
    expect(blocked()).toEqual([A, B, C]);
  });
});

describe("POST /api/plugins remove-policy", () => {
  let home: TmpHome;
  let root: string;
  let settingsFile: string;

  beforeEach(async () => {
    home = makeTempHome();
    root = mkdtempSync(join(home.home, "proj-"));
    await createWorkspace({ name: "Proj", rootPath: root });
    mkdirSync(join(root, ".claude"), { recursive: true });
    settingsFile = join(root, ".claude", "settings.json");
    writeFileSync(settingsFile, JSON.stringify({ strictKnownMarketplaces: [A, C] }));
  });
  afterEach(() => home.restore());

  const post = (body: Record<string, unknown>) =>
    POST(
      new Request("http://localhost/api/plugins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "marketplaces", scope: "project", cwd: root, op: "remove-policy", ...body }),
      }),
    );
  const strict = () =>
    (JSON.parse(readFileSync(settingsFile, "utf8")) as { strictKnownMarketplaces?: unknown[] }).strictKnownMarketplaces;

  test("removes the matching entry, then answers 409 for the repeat without touching the file", async () => {
    const first = await post({ list: "strict", index: 0, expected: redactSource(A) });
    expect(first.status).toBe(200);
    expect(strict()).toEqual([C]);

    const repeat = await post({ list: "strict", index: 0, expected: redactSource(A) });
    expect(repeat.status).toBe(409);
    expect(((await repeat.json()) as { error: string }).error).toContain("nothing was removed");
    expect(strict()).toEqual([C]);
  });

  test("an index-only request is refused", async () => {
    const res = await post({ list: "strict", index: 0 });
    expect(res.status).toBe(400);
    expect(strict()).toEqual([A, C]);
  });
});
