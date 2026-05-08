import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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

export async function writeKeybindings(data: KeybindingsFile): Promise<void> {
  const path = keybindingsPath();
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, JSON.stringify(data, null, 2) + "\n", "utf8");
}
