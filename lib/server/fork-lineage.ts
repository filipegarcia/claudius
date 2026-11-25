import { createReadStream } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { jsonlLines } from "./jsonl-lines";

/**
 * CC 2.1.330 — "[VSCode] Fixed a forked conversation running the original
 * conversation's `/loop` schedules a second time".
 *
 * The SDK's `forkSession` copies the source transcript into a new file, giving
 * every copied line a fresh `uuid` and a `forkedFrom: { sessionId,
 * messageUuid }`. `getSessionMessages` drops that field, so Claudius's replay
 * couldn't tell copied history from the fork's own turns: the source's
 * `CronCreate` / `ScheduleWakeup` calls were tracked as the fork's loops —
 * shown as running in the Activity rail and holding the fork's process alive
 * in the idle reaper — though they live in the source session, not the fork.
 */
export type ForkedFrom = { sessionId: string; messageUuid: string };

/**
 * Map each copied line's own `uuid` to its `forkedFrom`, read straight from
 * the JSONL. Empty for a session that isn't a fork, and on any read error.
 * `projectsBase` is injectable for tests.
 */
export async function readForkedFromByUuid(
  file: string,
  projectsBase: string = join(homedir(), ".claude", "projects"),
): Promise<Map<string, ForkedFrom>> {
  const out = new Map<string, ForkedFrom>();
  const base = resolve(projectsBase);
  const target = resolve(base, file);
  if (!target.startsWith(base + sep)) return out;
  try {
    for await (const line of jsonlLines(createReadStream(target, "utf8"))) {
      if (!line.includes('"forkedFrom"')) continue;
      let entry: { uuid?: unknown; forkedFrom?: { sessionId?: unknown; messageUuid?: unknown } | null };
      try {
        entry = JSON.parse(line) as typeof entry;
      } catch {
        continue; // torn line
      }
      const ff = entry?.forkedFrom;
      if (typeof entry?.uuid !== "string" || !ff || typeof ff !== "object") continue;
      out.set(entry.uuid, {
        sessionId: typeof ff.sessionId === "string" ? ff.sessionId : "",
        messageUuid: typeof ff.messageUuid === "string" ? ff.messageUuid : "",
      });
    }
  } catch {
    return new Map();
  }
  return out;
}

/**
 * Put `forkedFrom` back on a replayed message whose uuid was copied from the
 * source session, so the loop trackers (server and client) can tell it apart.
 * Returns the message itself when it wasn't copied.
 */
export function withForkedFrom<T>(msg: T, forked: ReadonlyMap<string, ForkedFrom>): T {
  if (forked.size === 0) return msg;
  const uuid = (msg as { uuid?: unknown } | null)?.uuid;
  if (typeof uuid !== "string") return msg;
  const ff = forked.get(uuid);
  return ff ? { ...msg, forkedFrom: ff } : msg;
}
