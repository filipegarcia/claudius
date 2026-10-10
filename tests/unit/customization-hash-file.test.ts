import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashFile, hashFileOrNull } from "@/lib/server/customization-hash";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "cust-hash-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("hashFile", () => {
  it("returns the sha1 hex of the file bytes (streamed, multi-chunk)", async () => {
    const f = join(tmp(), "big.bin");
    const body = Buffer.alloc(300_000, "abc");
    writeFileSync(f, body);
    expect(await hashFile(f)).toBe(createHash("sha1").update(body).digest("hex"));
  });

  it("hashes an empty file", async () => {
    const f = join(tmp(), "empty");
    writeFileSync(f, "");
    expect(await hashFile(f)).toBe("da39a3ee5e6b4b0d3255bfef95601890afd80709");
  });

  it("hashFileOrNull maps a missing file to null", async () => {
    expect(await hashFileOrNull(join(tmp(), "nope"))).toBeNull();
  });
});
