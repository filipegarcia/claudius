import { promises as fs } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { GET } from "@/app/api/workspaces/[id]/files/route";
import { createWorkspace } from "@/lib/server/workspaces-store";
import { makeTempHome, type TmpHome } from "./helpers/tmp-home";

/**
 * Directory-listing mode of GET /api/workspaces/:id/files — what the Files
 * tree renders. An empty project folder used to come back as a bare `[]`,
 * and so did a folder the server couldn't read (readdir errors were
 * swallowed), so both showed up as the same blank tree. The listing now
 * reports how many entries the dotfile / node_modules filters dropped, and an
 * unreadable folder is an error instead of an empty list.
 */
describe("files route — directory listing", () => {
  let home: TmpHome;
  let projectRoot: string;
  let wsId: string;

  beforeEach(async () => {
    home = makeTempHome();
    projectRoot = join(home.home, "project");
    await fs.mkdir(projectRoot, { recursive: true });
    wsId = (await createWorkspace({ name: "Proj", rootPath: projectRoot })).id;
  });
  afterEach(async () => {
    // Restore perms first so the tmpdir cleanup can remove a chmod-000 dir.
    await fs.chmod(join(projectRoot, "locked"), 0o755).catch(() => {});
    home.restore();
  });

  const list = (path = "") =>
    GET(new Request(`http://localhost/api/workspaces/${wsId}/files?path=${encodeURIComponent(path)}&depth=1`), {
      params: Promise.resolve({ id: wsId }),
    });

  test("an empty folder lists nothing and hides nothing", async () => {
    const res = await list();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ entries: [], hiddenCount: 0 });
  });

  test("a folder with only hidden entries reports how many were filtered", async () => {
    await fs.mkdir(join(projectRoot, ".git"));
    await fs.mkdir(join(projectRoot, "node_modules"));
    await fs.writeFile(join(projectRoot, ".env"), "X=1");
    const res = await list();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ entries: [], hiddenCount: 3 });
  });

  test("visible entries are still listed, dirs first", async () => {
    await fs.writeFile(join(projectRoot, "README.md"), "# hi");
    await fs.mkdir(join(projectRoot, "src"));
    await fs.writeFile(join(projectRoot, ".gitignore"), "");
    const body = (await (await list()).json()) as { entries: { relPath: string }[]; hiddenCount: number };
    expect(body.entries.map((e) => e.relPath)).toEqual(["src/", "README.md"]);
    expect(body.hiddenCount).toBe(1);
  });

  // chmod 000 doesn't stop root, so the permission case is meaningless there.
  test.skipIf(process.getuid?.() === 0)("an unreadable folder is a 403, not an empty list", async () => {
    const locked = join(projectRoot, "locked");
    await fs.mkdir(locked);
    await fs.writeFile(join(locked, "secret.txt"), "x");
    await fs.chmod(locked, 0o000);
    const res = await list("locked");
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/permission denied/i);
  });
});
