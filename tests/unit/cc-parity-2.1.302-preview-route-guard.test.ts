import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { GET } from "@/app/api/workspaces/[id]/files/preview/[...path]/route";
import { createWorkspace } from "@/lib/server/workspaces-store";
import { makeTempHome, type TmpHome } from "./helpers/tmp-home";

/**
 * CC 2.1.302 — "Fixed the Read tool loading an image file of any size, or a
 * pipe or device named like an image, entirely into memory; image sources
 * over 128 MB are now refused". Claudius's preview file server had the same
 * shape (`readFile` on whatever the path named).
 */
describe("files preview route — regular files only, 128 MB cap", () => {
  let home: TmpHome;
  let root: string;
  let wsId: string;

  beforeEach(async () => {
    home = makeTempHome();
    root = join(home.home, "project");
    await fs.mkdir(root, { recursive: true });
    wsId = (await createWorkspace({ name: "Proj", rootPath: root })).id;
  });
  afterEach(() => home.restore());

  const get = (...path: string[]) =>
    GET(new Request(`http://localhost/api/workspaces/${wsId}/files/preview/${path.join("/")}`), {
      params: Promise.resolve({ id: wsId, path }),
    });

  test("a small image is served with its content type", async () => {
    await fs.writeFile(join(root, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const res = await get("logo.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(new Uint8Array(await res.arrayBuffer())).toHaveLength(4);
  });

  test("a pipe named like an image is refused without reading it", async () => {
    const fifo = join(root, "shot.png");
    try {
      execFileSync("mkfifo", [fifo]);
    } catch {
      return; // no mkfifo on this platform
    }
    // Before the fix this awaited readFile on the FIFO and never resolved.
    const res = await get("shot.png");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("not a file");
  });

  test("a directory named like an image is refused", async () => {
    await fs.mkdir(join(root, "dir.png"));
    const res = await get("dir.png");
    expect(res.status).toBe(404);
  });

  test("a file over 128 MB is refused with 413", async () => {
    const big = join(root, "huge.png");
    const fh = await fs.open(big, "w");
    await fh.truncate(128 * 1024 * 1024 + 1); // sparse — no real disk use
    await fh.close();
    const res = await get("huge.png");
    expect(res.status).toBe(413);
  });

  test("a missing file is still a 404", async () => {
    expect((await get("nope.png")).status).toBe(404);
  });
});
