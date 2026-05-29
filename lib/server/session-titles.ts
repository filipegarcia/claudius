import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Local session-title store.
 *
 * The SDK's `renameSession` writes the title into the session's JSONL header,
 * but that JSONL only exists *after* a turn has been completed. For the user
 * the rename workflow needs to work the moment a session is created — long
 * before any prompt has been sent — so we own the persistence ourselves.
 *
 * Storage: a single JSON file at `~/.claude/.claudius/session-titles.json`,
 * keyed by session id. Read/modify/write is atomic via temp-file + rename.
 *
 * The SDK store remains the source of truth for session listings (so titles
 * authored in another client surface here too); this file just makes our
 * own writes durable in the gap between bind and first turn.
 */

const FILE = join(homedir(), ".claude", ".claudius", "session-titles.json");

type Store = { version: 1; titles: Record<string, string> };

async function read(): Promise<Store> {
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<Store>;
    if (parsed && parsed.version === 1 && parsed.titles && typeof parsed.titles === "object") {
      return parsed as Store;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      // Corrupt or unreadable — fall through to a fresh store rather than crash.
    }
  }
  return { version: 1, titles: {} };
}

async function write(store: Store): Promise<void> {
  const dir = dirname(FILE);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${FILE}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(store, null, 2), "utf8");
  await fs.rename(tmp, FILE);
}

let cache: Store | null = null;

async function load(): Promise<Store> {
  if (cache) return cache;
  cache = await read();
  return cache;
}

export async function getSessionTitle(sessionId: string): Promise<string | null> {
  const s = await load();
  return s.titles[sessionId] ?? null;
}

export async function setSessionTitle(sessionId: string, title: string): Promise<void> {
  const s = await load();
  const trimmed = title.trim();
  if (!trimmed) {
    if (sessionId in s.titles) {
      delete s.titles[sessionId];
      await write(s);
    }
    return;
  }
  if (s.titles[sessionId] === trimmed) return;
  s.titles[sessionId] = trimmed;
  await write(s);
}

export async function deleteSessionTitle(sessionId: string): Promise<void> {
  const s = await load();
  if (!(sessionId in s.titles)) return;
  delete s.titles[sessionId];
  await write(s);
}
