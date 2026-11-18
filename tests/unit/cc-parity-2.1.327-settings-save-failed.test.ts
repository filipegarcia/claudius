import { promises as fs } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { makeTempHome, type TmpHome } from "./helpers/tmp-home";

/**
 * CC 2.1.327 — the /settings save, the Skills on/off toggle and the Auto mode
 * editor used to throw a bare 500 when the settings file didn't load or
 * couldn't be written. Each route now returns the same message the
 * /permissions route does (CC 2.1.326), naming the file, and leaves it alone.
 */
const state = vi.hoisted(() => ({ cwd: "" }));
vi.mock("@/lib/server/trusted-cwd", () => ({ resolveTrustedCwd: vi.fn(async () => state.cwd) }));

let home: TmpHome;
let userFile: string;
let projectFile: string;
beforeEach(async () => {
  home = makeTempHome();
  await fs.mkdir(join(home.home, ".claude"), { recursive: true });
  userFile = join(home.home, ".claude", "settings.json");
  state.cwd = join(home.home, "project");
  await fs.mkdir(join(state.cwd, ".claude"), { recursive: true });
  projectFile = join(state.cwd, ".claude", "settings.json");
});
afterEach(() => {
  home.restore();
});

const BROKEN = '{ "model": "opus", ';
const json = (body: unknown) => JSON.stringify(body);

async function expectNamedFailure(res: Response, file: string) {
  expect(res.status).toBe(422);
  const body = (await res.json()) as { error?: string };
  expect(body.error).toContain(`Not saved: ${file} doesn't load`);
  expect(await fs.readFile(file, "utf8")).toBe(BROKEN);
}

describe("PUT /api/settings/full", () => {
  test("a patch against a file that doesn't load names the file and leaves it alone", async () => {
    await fs.writeFile(userFile, BROKEN);
    const { PUT } = await import("@/app/api/settings/full/route");
    const res = await PUT(
      new Request("http://x/api/settings/full", {
        method: "PUT",
        body: json({ scope: "user", patch: { set: { theme: "light" }, unset: [] } }),
      }),
    );
    await expectNamedFailure(res, userFile);
  });
});

describe("POST /api/settings/skill-overrides", () => {
  test("a toggle against a project file that doesn't load names it", async () => {
    await fs.writeFile(projectFile, BROKEN);
    const { POST } = await import("@/app/api/settings/skill-overrides/route");
    const res = await POST(
      new Request("http://x/api/settings/skill-overrides", { method: "POST", body: json({ name: "pdf", value: "off" }) }),
    );
    await expectNamedFailure(res, projectFile);
  });
});

describe("/api/settings/auto-mode", () => {
  test("POST and DELETE against a user file that doesn't load name it", async () => {
    await fs.writeFile(userFile, BROKEN);
    const { POST, DELETE } = await import("@/app/api/settings/auto-mode/route");
    await expectNamedFailure(
      await POST(new Request("http://x/api/settings/auto-mode", { method: "POST", body: json({ patch: { allow: ["x"] } }) })),
      userFile,
    );
    await expectNamedFailure(await DELETE(new Request("http://x/api/settings/auto-mode", { method: "DELETE" })), userFile);
  });
});
