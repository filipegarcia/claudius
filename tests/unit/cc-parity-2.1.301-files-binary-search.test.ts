import { promises as fs } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { GET } from "@/app/api/workspaces/[id]/files/route";
import { createWorkspace } from "@/lib/server/workspaces-store";
import { listFs } from "@/lib/server/fs-list";
import { isKnownBinaryPath } from "@/lib/shared/file-types";
import { makeTempHome, type TmpHome } from "./helpers/tmp-home";

/**
 * CC 2.1.301 —
 *  - "Fixed the Read tool reading binary files such as .xlsm, .parquet, .epub
 *    and .heic as text" → the Files viewer gets `binary: true` and no content.
 *  - "Fixed Grep and Glob reporting no matches when the search program failed
 *    unexpectedly before returning any results" → a search whose starting
 *    folder can't be read answers "Search failed", not an empty list.
 */
describe("isKnownBinaryPath", () => {
  test("the formats the changelog names, case-insensitive", () => {
    for (const p of ["a/b.xlsm", "data.PARQUET", "book.epub", "IMG_1.HEIC", "x.zip"]) {
      expect(isKnownBinaryPath(p)).toBe(true);
    }
  });
  test("text formats and extensionless / dotfiles are not binary", () => {
    for (const p of ["a.ts", "icon.svg", "data.csv", "nb.ipynb", "Makefile", ".parquet", "dir.zip/readme.md"]) {
      expect(isKnownBinaryPath(p)).toBe(false);
    }
  });
});

describe("files route — binary files and failed searches", () => {
  let home: TmpHome;
  let projectRoot: string;
  let wsId: string;
  const locked: string[] = [];

  beforeEach(async () => {
    home = makeTempHome();
    projectRoot = join(home.home, "project");
    await fs.mkdir(projectRoot, { recursive: true });
    wsId = (await createWorkspace({ name: "Proj", rootPath: projectRoot })).id;
  });
  afterEach(async () => {
    for (const p of locked.splice(0)) await fs.chmod(p, 0o755).catch(() => {});
    home.restore();
  });

  const ctx = () => ({ params: Promise.resolve({ id: wsId }) });
  const get = async (qs: string) => {
    const res = await GET(new Request(`http://localhost/api/workspaces/${wsId}/files?${qs}`), ctx());
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  test("a NUL-bearing .xlsm comes back as binary with no content", async () => {
    // ZIP local-file header: PK\x03\x04 then version/flags with NUL bytes.
    await fs.writeFile(join(projectRoot, "book.xlsm"), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00, 0x08, 0x00]));
    const { status, body } = await get("path=book.xlsm");
    expect(status).toBe(200);
    expect(body).toMatchObject({ binary: true, content: "", editable: false, sizeBytes: 10 });
  });

  test("a tiny .parquet with no NUL byte is still binary by extension", async () => {
    await fs.writeFile(join(projectRoot, "t.parquet"), "PAR1PAR1");
    const { body } = await get("path=t.parquet");
    expect(body).toMatchObject({ binary: true, content: "" });
  });

  test("a >2 MB .parquet is binary by extension, not 'file too large'", async () => {
    const p = join(projectRoot, "big.parquet");
    await fs.writeFile(p, "PAR1");
    await fs.truncate(p, 3 * 1024 * 1024);
    const { status, body } = await get("path=big.parquet");
    expect(status).toBe(200);
    expect(body).toMatchObject({ binary: true, content: "", editable: false, sizeBytes: 3 * 1024 * 1024 });
  });

  test("a >2 MB text file still hits the size cap", async () => {
    const p = join(projectRoot, "big.txt");
    await fs.writeFile(p, "x");
    await fs.truncate(p, 3 * 1024 * 1024);
    const { status } = await get("path=big.txt");
    expect(status).toBe(413);
  });

  test("?serve=1 still serves a .png image", async () => {
    await fs.writeFile(join(projectRoot, "i.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const res = await GET(new Request(`http://localhost/api/workspaces/${wsId}/files?path=i.png&serve=1`), ctx());
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
  });

  test("an unknown extension with NUL bytes is still sniffed as binary", async () => {
    await fs.writeFile(join(projectRoot, "blob.dat"), Buffer.from([0x01, 0x00, 0x02, 0x00, 0x03]));
    const { body } = await get("path=blob.dat");
    expect(body).toMatchObject({ binary: true, content: "" });
  });

  test("ordinary text is unchanged", async () => {
    await fs.writeFile(join(projectRoot, "a.txt"), "hello");
    const { body } = await get("path=a.txt");
    expect(body).toMatchObject({ content: "hello", editable: true });
    expect(body).not.toHaveProperty("binary");
  });

  test.skipIf(process.getuid?.() === 0)("filename search in an unreadable folder fails instead of 'no matches'", async () => {
    const dir = join(projectRoot, "locked");
    await fs.mkdir(dir);
    await fs.writeFile(join(dir, "needle.txt"), "x");
    await fs.chmod(dir, 0o000);
    locked.push(dir);
    const { status, body } = await get("path=locked&search=needle");
    expect(status).toBe(403);
    expect(String(body.error)).toMatch(/^Search failed: permission denied/);
  });

  test.skipIf(process.getuid?.() === 0)("content search in an unreadable folder fails instead of 'no matches'", async () => {
    const dir = join(projectRoot, "locked2");
    await fs.mkdir(dir);
    await fs.chmod(dir, 0o000);
    locked.push(dir);
    const { status, body } = await get("path=locked2&contentSearch=needle");
    expect(status).toBe(403);
    expect(String(body.error)).toMatch(/^Search failed/);
  });

  test.skipIf(process.getuid?.() === 0)("an unreadable sub-folder is still skipped, not fatal", async () => {
    await fs.writeFile(join(projectRoot, "needle.md"), "x");
    const dir = join(projectRoot, "sub");
    await fs.mkdir(dir);
    await fs.chmod(dir, 0o000);
    locked.push(dir);
    const { status, body } = await get("path=&search=needle");
    expect(status).toBe(200);
    expect((body.entries as { relPath: string }[]).map((e) => e.relPath)).toContain("needle.md");
  });

  test.skipIf(process.getuid?.() === 0)("the @-mention walk throws when its root is unreadable", async () => {
    const dir = join(projectRoot, "nope");
    await fs.mkdir(dir);
    await fs.chmod(dir, 0o000);
    locked.push(dir);
    await expect(listFs({ cwd: dir, query: "", limit: 10 })).rejects.toMatchObject({ code: "EACCES" });
  });
});
