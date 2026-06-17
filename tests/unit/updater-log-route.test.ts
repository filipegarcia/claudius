/**
 * Coverage for GET /api/updater/log — the incremental tail that powers the
 * in-place "Resolve with Claude" modal's live progress.
 *
 * The contract the modal relies on:
 *   - no `offset`            → report current EOF only (the starting cursor, so
 *                              the modal shows only THIS run's lines).
 *   - `offset=<n>`           → bytes [n, size); `size` in the response is the
 *                              next cursor to poll from.
 *   - `offset === size`      → empty (nothing new yet).
 *   - `offset > size`        → empty (log truncated/rotated — resync, don't read
 *                              garbage).
 *   - missing log file       → empty stream, not a 500.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GET } from "@/app/api/updater/log/route";

function makeReq(offset?: number): Request {
  const qs = offset === undefined ? "" : `?offset=${offset}`;
  return new Request(`http://localhost/api/updater/log${qs}`);
}

describe("GET /api/updater/log", () => {
  let root: string;
  let prevEnv: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "claudius-logroute-"));
    prevEnv = process.env.CLAUDIUS_INSTALL_ROOT;
    process.env.CLAUDIUS_INSTALL_ROOT = root;
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.CLAUDIUS_INSTALL_ROOT;
    else process.env.CLAUDIUS_INSTALL_ROOT = prevEnv;
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  function writeLog(content: string): void {
    const dir = join(root, ".claudius", "logs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "updater.log"), content);
  }

  test("missing log file → empty stream, not an error", async () => {
    const res = await GET(makeReq(0));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ size: 0, content: "" });
  });

  test("no offset → reports current EOF as the starting cursor", async () => {
    writeLog("hello\nworld\n"); // 12 bytes
    const res = await GET(makeReq());
    const body = (await res.json()) as { size: number; content?: string };
    expect(body.size).toBe(12);
    expect(body.content).toBeUndefined();
  });

  test("offset=0 → returns the whole log and advances the cursor to EOF", async () => {
    writeLog("line one\nline two\n");
    const res = await GET(makeReq(0));
    const body = (await res.json()) as { size: number; content: string };
    expect(body.content).toBe("line one\nline two\n");
    expect(body.size).toBe(Buffer.byteLength("line one\nline two\n"));
  });

  test("incremental tail: poll from a cursor returns only the new bytes", async () => {
    writeLog("first\n");
    const firstSize = Buffer.byteLength("first\n");
    // Simulate more progress being appended after the modal captured its cursor.
    appendFileSync(join(root, ".claudius", "logs", "updater.log"), "[claude] resolving\n");

    const res = await GET(makeReq(firstSize));
    const body = (await res.json()) as { size: number; content: string };
    expect(body.content).toBe("[claude] resolving\n");
    expect(body.size).toBe(firstSize + Buffer.byteLength("[claude] resolving\n"));
  });

  test("offset === size → nothing new", async () => {
    writeLog("done\n");
    const size = Buffer.byteLength("done\n");
    const res = await GET(makeReq(size));
    expect(await res.json()).toEqual({ size, content: "" });
  });

  test("offset > size (rotation/truncation) → empty, resync without throwing", async () => {
    writeLog("short\n");
    const res = await GET(makeReq(9999));
    const body = (await res.json()) as { size: number; content: string };
    expect(body.content).toBe("");
    expect(body.size).toBe(Buffer.byteLength("short\n"));
  });
});
