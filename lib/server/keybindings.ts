import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { assertWithin } from "./safe-path";

export type Keybinding = {
  key: string;
  command: string;
  args?: unknown;
  when?: string;
  /** Chord prefix, e.g. "ctrl+k". When set, `key` is the second key in the chord. */
  chord?: string;
};

export type KeybindingsFile = {
  bindings?: Keybinding[];
  // Pass-through for unknown top-level keys.
  [key: string]: unknown;
};

export function keybindingsPath(): string {
  return join(homedir(), ".claude", "keybindings.json");
}

export async function readKeybindings(): Promise<{ path: string; exists: boolean; data: KeybindingsFile }> {
  const path = keybindingsPath();
  try {
    const buf = await fs.readFile(path, "utf8");
    return { path, exists: true, data: JSON.parse(buf) as KeybindingsFile };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return { path, exists: false, data: {} };
    throw err;
  }
}

/** Per-process counter so concurrent saves never share a temp name. */
let writeSeq = 0;

export async function writeKeybindings(data: KeybindingsFile): Promise<void> {
  const path = keybindingsPath();
  const dir = dirname(path);
  await fs.mkdir(dir, { recursive: true });
  const body = JSON.stringify(data, null, 2) + "\n";
  // CC 2.1.319 parity — "Fixed … settings and edited files ending up empty or
  // cut off when the disk fills during a save". `fs.writeFile` truncates
  // first, so a failed write left `keybindings.json` empty or cut off. Write a
  // sibling temp file and rename it into place (as `writeSettings` does);
  // write through a symlink so a dotfiles link isn't replaced by a file.
  const st = await fs.lstat(path).catch(() => null);
  if (st?.isSymbolicLink()) {
    await fs.writeFile(path, body, "utf8");
    return;
  }
  const tmpPath = assertWithin(dir, `.${basename(path)}.tmp-${process.pid}-${writeSeq++}`);
  const mode = st ? st.mode & 0o777 : undefined;
  try {
    await fs.writeFile(tmpPath, body, "utf8");
    if (mode !== undefined) await fs.chmod(tmpPath, mode);
    await fs.rename(tmpPath, path);
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
}
