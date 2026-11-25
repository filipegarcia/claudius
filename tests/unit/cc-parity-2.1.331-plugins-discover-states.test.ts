import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { GET } from "@/app/api/plugins/available/route";
import { makeTempHome, type TmpHome } from "./helpers/tmp-home";

/**
 * CC 2.1.331 — "Fixed Manage Plugins losing its search box or showing no
 * message when a search has no match, and not saying that the list of
 * available plugins failed to load".
 *
 * `GET /api/plugins/available` threw on any `readdir` failure other than
 * ENOENT (an HTML 500), and `usePlugins` swallowed it, so /plugins Discover
 * said "No marketplaces cached yet". The route now answers with the reason.
 */
describe("GET /api/plugins/available", () => {
  let home: TmpHome;
  beforeEach(() => {
    home = makeTempHome();
  });
  afterEach(() => home.restore());

  test("no marketplaces folder is still an empty list", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ plugins: [] });
  });

  test("a marketplaces folder that can't be read answers 500 with the reason", async () => {
    mkdirSync(join(home.home, ".claude", "plugins"), { recursive: true });
    // A file where the folder should be: readdir fails with ENOTDIR.
    writeFileSync(join(home.home, ".claude", "plugins", "marketplaces"), "");
    const res = await GET();
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("ENOTDIR");
  });
});
