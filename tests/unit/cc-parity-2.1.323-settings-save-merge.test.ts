import { promises as fs } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { makeTempHome, type TmpHome } from "./helpers/tmp-home";

/**
 * CC 2.1.323 — "Fixed a setting saved in a running session undoing a hand
 * edit made to settings.json moments earlier; a settings file you delete
 * during a session now stays deleted". Route-level: the Settings page's
 * `patch` save and the /permissions `ruleDelta` both merge into a fresh read.
 */
vi.mock("@/lib/server/trusted-cwd", () => ({ resolveTrustedCwd: vi.fn(async () => "/tmp/claudius-2323-cwd") }));

let home: TmpHome;
let file: string;
beforeEach(async () => {
  home = makeTempHome();
  const dir = join(home.home, ".claude");
  await fs.mkdir(dir, { recursive: true });
  file = join(dir, "settings.json");
});
afterEach(() => {
  home.restore();
});
const read = async () => JSON.parse(await fs.readFile(file, "utf8"));

describe("PUT /api/settings/full with a patch", () => {
  test("only the changed key is written; a hand edit made since the page loaded survives", async () => {
    // Page loaded {model: opus, theme: dark}; then the file was hand-edited.
    await fs.writeFile(file, JSON.stringify({ model: "sonnet", theme: "dark", verbose: true }));
    const { PUT } = await import("@/app/api/settings/full/route");
    const res = await PUT(
      new Request("http://x/api/settings/full", {
        method: "PUT",
        body: JSON.stringify({ scope: "user", patch: { set: { theme: "light" }, unset: [] } }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await read()).toEqual({ model: "sonnet", theme: "light", verbose: true });
  });

  test("a bad patch is refused; the whole-document form still works", async () => {
    await fs.writeFile(file, JSON.stringify({ model: "opus" }));
    const { PUT } = await import("@/app/api/settings/full/route");
    const bad = await PUT(
      new Request("http://x/api/settings/full", { method: "PUT", body: JSON.stringify({ scope: "user", patch: { unset: "x" } }) }),
    );
    expect(bad.status).toBe(400);
    const whole = await PUT(
      new Request("http://x/api/settings/full", { method: "PUT", body: JSON.stringify({ scope: "user", settings: { theme: "dark" } }) }),
    );
    expect(whole.status).toBe(200);
    expect(await read()).toEqual({ theme: "dark" });
  });
});

describe("POST /api/settings/permissions with a ruleDelta", () => {
  test("adding a rule keeps one hand-added to the file since the page loaded", async () => {
    await fs.writeFile(file, JSON.stringify({ permissions: { allow: ["Read", "Bash(make)"] }, model: "opus" }));
    const { POST } = await import("@/app/api/settings/permissions/route");
    const res = await POST(
      new Request("http://x/api/settings/permissions", {
        method: "POST",
        body: JSON.stringify({ scope: "user", ruleDelta: { kind: "allow", add: ["Bash(ls)"] } }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await read()).toEqual({ permissions: { allow: ["Read", "Bash(make)", "Bash(ls)"] }, model: "opus" });

    const rm = await POST(
      new Request("http://x/api/settings/permissions", {
        method: "POST",
        body: JSON.stringify({ scope: "user", ruleDelta: { kind: "allow", remove: ["Read"] } }),
      }),
    );
    expect(rm.status).toBe(200);
    expect((await read()).permissions.allow).toEqual(["Bash(make)", "Bash(ls)"]);
  });

  test("a malformed ruleDelta is refused", async () => {
    const { POST } = await import("@/app/api/settings/permissions/route");
    for (const ruleDelta of [{ kind: "nope" }, { kind: "allow", add: [1] }, null]) {
      const res = await POST(
        new Request("http://x/api/settings/permissions", { method: "POST", body: JSON.stringify({ scope: "user", ruleDelta }) }),
      );
      expect(res.status, JSON.stringify(ruleDelta)).toBe(400);
    }
  });
});
