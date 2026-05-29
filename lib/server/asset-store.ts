import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { projectRoot } from "./db";

const EXT_BY_MEDIA: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/heic": "heic",
  "image/avif": "avif",
  "application/pdf": "pdf",
};

export function extFor(mediaType: string): string {
  return EXT_BY_MEDIA[mediaType.toLowerCase()] ?? "bin";
}

export function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

export function assetsDir(cwd: string): string {
  return join(projectRoot(cwd), "assets");
}

export function assetPath(cwd: string, hash: string, mediaType: string): string {
  const shard = hash.slice(0, 2);
  return join(assetsDir(cwd), shard, `${hash}.${extFor(mediaType)}`);
}

/** Write the buffer to `<cwd>/assets/<sha[:2]>/<sha>.<ext>` if missing. */
export async function writeIfAbsent(cwd: string, buf: Buffer, mediaType: string): Promise<{ hash: string; path: string; bytes: number; created: boolean }> {
  const hash = sha256(buf);
  const path = assetPath(cwd, hash, mediaType);
  try {
    await fs.access(path);
    return { hash, path, bytes: buf.byteLength, created: false };
  } catch {
    // not present
  }
  await fs.mkdir(join(assetsDir(cwd), hash.slice(0, 2)), { recursive: true });
  await fs.writeFile(path, buf, { flag: "wx" }).catch((err) => {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "EEXIST") return; // race — fine
    throw err;
  });
  return { hash, path, bytes: buf.byteLength, created: true };
}

export async function readAsset(cwd: string, hash: string, mediaType: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(assetPath(cwd, hash, mediaType));
  } catch {
    return null;
  }
}

export async function deleteAsset(cwd: string, hash: string, mediaType: string): Promise<boolean> {
  try {
    await fs.unlink(assetPath(cwd, hash, mediaType));
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return false;
    throw err;
  }
}
