import { promises as fs } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { GET, PUT } from "@/app/api/workspaces/[id]/files/route";
import { createWorkspace } from "@/lib/server/workspaces-store";
import { makeTempHome, type TmpHome } from "./helpers/tmp-home";

/**
 * CC 2.1.299 — "Fixed Read garbling UTF-16LE files with a byte-order mark,
 * and Write dropping byte-order marks or silently converting Windows-1252,
 * Shift-JIS, GBK or UTF-16BE files to UTF-8 (now refused)".
 *
 * Claudius's Files / git editors read and write through
 * GET/PUT /api/workspaces/:id/files. Before: a UTF-8 BOM was dropped on save
 * (`req.text()` strips it), UTF-16LE opened garbled and saved as U+FFFD, and a
 * cp1252 `é` was saved as U+FFFD.
 */
describe("files route — text encodings", () => {
  let home: TmpHome;
  let projectRoot: string;
  let wsId: string;

  beforeEach(async () => {
    home = makeTempHome();
    projectRoot = join(home.home, "project");
    await fs.mkdir(projectRoot, { recursive: true });
    wsId = (await createWorkspace({ name: "Proj", rootPath: projectRoot })).id;
  });
  afterEach(() => home.restore());

  const url = (path: string) => `http://localhost/api/workspaces/${wsId}/files?path=${encodeURIComponent(path)}`;
  const ctx = () => ({ params: Promise.resolve({ id: wsId }) });
  const read = async (path: string) => {
    const res = await GET(new Request(url(path)), ctx());
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const write = (path: string, text: string) =>
    PUT(new Request(url(path), { method: "PUT", body: new TextEncoder().encode(text) }), ctx());
  const bytesOf = async (path: string) => Array.from(await fs.readFile(join(projectRoot, path)));

  test("plain UTF-8 reads editable and saves as plain UTF-8", async () => {
    await fs.writeFile(join(projectRoot, "a.txt"), "héllo");
    const { body } = await read("a.txt");
    expect(body).toMatchObject({ content: "héllo", encoding: "utf-8", editable: true });
    expect(body).not.toHaveProperty("readOnlyReason");
    expect((await write("a.txt", "bye")).status).toBe(200);
    expect(await fs.readFile(join(projectRoot, "a.txt"), "utf8")).toBe("bye");
  });

  test("a UTF-8 BOM is reported, stripped from content, and kept on save", async () => {
    await fs.writeFile(join(projectRoot, "bom.txt"), Buffer.from([0xef, 0xbb, 0xbf, 0x61]));
    const { body } = await read("bom.txt");
    expect(body).toMatchObject({ content: "a", encoding: "utf-8-bom", editable: true });
    expect((await write("bom.txt", "é")).status).toBe(200);
    expect(await bytesOf("bom.txt")).toEqual([0xef, 0xbb, 0xbf, 0xc3, 0xa9]);
  });

  test("a body that itself starts with U+FEFF isn't stripped (no req.text())", async () => {
    expect((await write("new-bom.txt", "﻿x")).status).toBe(200);
    expect(await bytesOf("new-bom.txt")).toEqual([0xef, 0xbb, 0xbf, 0x78]);
  });

  test("UTF-16LE + BOM decodes properly and saves back as UTF-16LE + BOM", async () => {
    const file = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("héllo wörld", "utf16le")]);
    await fs.writeFile(join(projectRoot, "w.txt"), file);
    const { body } = await read("w.txt");
    expect(body).toMatchObject({ content: "héllo wörld", encoding: "utf-16le", editable: true });
    expect((await write("w.txt", "ünï")).status).toBe(200);
    expect(await bytesOf("w.txt")).toEqual(
      Array.from(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("ünï", "utf16le")])),
    );
  });

  test("a Windows-1252 file opens read-only with a preview, and saving is refused (415, bytes untouched)", async () => {
    const original = [0x63, 0x61, 0x66, 0xe9];
    await fs.writeFile(join(projectRoot, "legacy.txt"), Buffer.from(original));
    const { status, body } = await read("legacy.txt");
    expect(status).toBe(200);
    expect(body).toMatchObject({ content: "café", encoding: "unsupported", editable: false });
    expect(body.readOnlyReason).toMatch(/^Read-only: .*Windows-1252/);
    const res = await write("legacy.txt", "cafe");
    expect(res.status).toBe(415);
    expect(((await res.json()) as { error: string }).error).toBe(
      "This file isn't UTF-8 or UTF-16LE text, so Claudius won't save it (that would convert it to UTF-8)",
    );
    expect(await bytesOf("legacy.txt")).toEqual(original);
  });

  test("a UTF-16BE file opens read-only and saving is refused", async () => {
    const original = [0xfe, 0xff, 0x00, 0x68, 0x00, 0x69];
    await fs.writeFile(join(projectRoot, "be.txt"), Buffer.from(original));
    const { body } = await read("be.txt");
    expect(body).toMatchObject({ content: "hi", encoding: "unsupported", editable: false, encodingLabel: "UTF-16BE" });
    expect((await write("be.txt", "hi")).status).toBe(415);
    expect(await bytesOf("be.txt")).toEqual(original);
  });

  test("a new file is written as plain UTF-8", async () => {
    expect((await write("sub/new.txt", "é")).status).toBe(200);
    expect(await bytesOf("sub/new.txt")).toEqual([0xc3, 0xa9]);
  });

  test("a body that isn't valid UTF-8 is a 400", async () => {
    const res = await PUT(
      new Request(url("x.txt"), { method: "PUT", body: new Uint8Array([0xe9]) }),
      ctx(),
    );
    expect(res.status).toBe(400);
  });

  test("path escapes are still rejected before any read", async () => {
    const res = await write("../outside.txt", "x");
    expect(res.status).toBe(400);
  });
});
