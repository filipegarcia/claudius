import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HIDDEN = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  ".turbo",
  ".cache",
  "coverage",
  ".DS_Store",
]);

export async function GET(req: Request) {
  const url = new URL(req.url);
  const requested = url.searchParams.get("path") ?? homedir();
  const path = isAbsolute(requested) ? resolve(requested) : resolve(homedir(), requested);

  let stat: import("node:fs").Stats;
  try {
    stat = await fs.stat(path);
  } catch {
    return NextResponse.json({ error: "path does not exist" }, { status: 404 });
  }
  if (!stat.isDirectory()) {
    return NextResponse.json({ error: "path is not a directory" }, { status: 400 });
  }

  let dirents: import("node:fs").Dirent[];
  try {
    dirents = await fs.readdir(path, { withFileTypes: true });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "EACCES") return NextResponse.json({ error: "permission denied" }, { status: 403 });
    throw err;
  }

  const entries: { name: string; path: string }[] = [];
  for (const ent of dirents) {
    if (HIDDEN.has(ent.name) || ent.name.startsWith(".")) continue;
    if (!ent.isDirectory()) continue;
    entries.push({ name: ent.name, path: join(path, ent.name) });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));

  const parent = dirname(path);
  return NextResponse.json({
    path,
    parent: parent === path ? null : parent, // null at filesystem root
    entries,
    home: homedir(),
  });
}
