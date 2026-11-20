import {
  getSessionMessages,
  importSessionToStore,
  type SessionMessage,
  type SessionStore,
  type SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import type { CompactBoundaryInfo, HistoryMessage } from "@/lib/shared/history-message";

export type { HistoryMessage } from "@/lib/shared/history-message";

/**
 * Full session history across compactions, for the read-only session viewer.
 *
 * Compaction doesn't delete anything: the engine keeps appending to the same
 * `<id>.jsonl`, writing a `compact_boundary` system entry with
 * `parentUuid: null` and then the "This session is being continued…" summary.
 * Everything before the boundary is still in the file. But the SDK's
 * `getSessionMessages` walks `parentUuid` back from the leaf, so it stops at
 * the null parent and returns only the post-compact context. A session that
 * auto-compacted five times showed 284 of its ~2,700 messages, starting at
 * the last summary.
 *
 * `logicalParentUuid` on the boundary is meant to record the link, but the
 * engine often points it at an in-memory message it never wrote, so it
 * dangles. Instead we re-link each boundary to the last main-chain entry
 * written before it (the leaf the conversation had when it compacted). Then
 * the SDK's own chain builder runs over the stitched entries through its
 * `sessionStore` option, so parallel tool results, trailing branches and meta
 * filtering behave as they do everywhere else.
 */

type Entry = SessionStoreEntry & {
  parentUuid?: string | null;
  logicalParentUuid?: string | null;
  isSidechain?: boolean;
  teamName?: string;
  subtype?: string;
  attachment?: { type?: string };
  compactMetadata?: Record<string, unknown>;
};

/** The SDK's own leaf-candidate rule: main-chain, non-progress, not a fork briefing. */
function isMainChainEntry(e: Entry): boolean {
  if (typeof e.uuid !== "string") return false;
  if (e.type !== "user" && e.type !== "assistant" && e.type !== "system" && e.type !== "attachment") {
    return false;
  }
  if (e.isSidechain === true || e.teamName) return false;
  if (e.type === "attachment" && e.attachment?.type === "fork_briefing") return false;
  return true;
}

/**
 * Re-link every root `compact_boundary` to the conversation it compacted, so a
 * parentUuid walk from the leaf reaches the start of the session. Pure; the
 * input entries are not mutated.
 *
 * Link target, in order:
 *   1. `logicalParentUuid`, when that entry exists earlier in the file;
 *   2. otherwise the last main-chain entry written before the boundary.
 *      That's the preserved tail when the compaction kept recent messages,
 *      or the last message of the compacted turn when it didn't.
 *
 * The boundary's `preservedSegment` / `preservedMessages` metadata is
 * dropped. The SDK uses it to move the kept messages after the summary
 * (that's what the model saw post-compact). In the full history they stay
 * where they were written, before the boundary. Moving them as well would
 * loop the chain: boundary → tail → … → head → summary → boundary.
 */
export function stitchCompactedHistory(entries: readonly SessionStoreEntry[]): SessionStoreEntry[] {
  const indexByUuid = new Map<string, number>();
  entries.forEach((e, i) => {
    if (typeof e.uuid === "string" && !indexByUuid.has(e.uuid)) indexByUuid.set(e.uuid, i);
  });
  let lastMainChain: string | undefined;
  return entries.map((raw, i) => {
    let e = raw as Entry;
    if (e.type === "system" && e.subtype === "compact_boundary" && !e.parentUuid) {
      const logical = e.logicalParentUuid;
      const logicalAt = typeof logical === "string" ? indexByUuid.get(logical) : undefined;
      const target = logicalAt !== undefined && logicalAt < i ? logical! : lastMainChain;
      const next: Entry = { ...e, parentUuid: target ?? null };
      if (e.compactMetadata) {
        const meta = { ...e.compactMetadata };
        delete meta.preservedSegment;
        delete meta.preservedMessages;
        next.compactMetadata = meta;
      }
      e = next;
    }
    if (isMainChainEntry(e)) lastMainChain = e.uuid;
    return e;
  });
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function annotateSystemMessages(
  list: readonly SessionMessage[],
  entries: readonly SessionStoreEntry[],
): HistoryMessage[] {
  const systemByUuid = new Map<string, Entry>();
  for (const e of entries as readonly Entry[]) {
    if (e.type === "system" && typeof e.uuid === "string") systemByUuid.set(e.uuid, e);
  }
  return list.map((m) => {
    if (m.type !== "system") return m;
    const raw = systemByUuid.get(m.uuid);
    if (!raw?.subtype) return m;
    if (raw.subtype !== "compact_boundary") return { ...m, subtype: raw.subtype };
    const meta = raw.compactMetadata ?? {};
    const info: CompactBoundaryInfo = {
      ...(typeof meta.trigger === "string" && { trigger: meta.trigger }),
      ...(num(meta.preTokens) !== undefined && { preTokens: num(meta.preTokens) }),
      ...(num(meta.postTokens) !== undefined && { postTokens: num(meta.postTokens) }),
      ...(num(meta.durationMs) !== undefined && { durationMs: num(meta.durationMs) }),
    };
    return { ...m, subtype: raw.subtype, compactBoundary: info };
  });
}

/**
 * Every message of the session, pre-compaction turns included, in order.
 * Reads the transcript through the SDK (`importSessionToStore`, so the file is
 * found by the same rules as `getSessionMessages`), stitches it, and lets
 * `getSessionMessages` build the chain from an in-memory store.
 */
export async function fullHistoryMessages(
  sessionId: string,
  dir?: string,
  includeSystem = true,
): Promise<HistoryMessage[]> {
  const raw: SessionStoreEntry[] = [];
  const collector: SessionStore = {
    async append(key, batch) {
      // Main transcript only; subagent transcripts carry a `subpath`.
      if (key.subpath !== undefined) return;
      for (const e of batch) raw.push(e);
    },
    async load() {
      return null;
    },
  };
  await importSessionToStore(sessionId, collector, { dir, includeSubagents: false });
  const stitched = stitchCompactedHistory(raw);
  const replay: SessionStore = {
    async append() {},
    async load() {
      return stitched;
    },
  };
  const list = await getSessionMessages(sessionId, {
    dir,
    includeSystemMessages: includeSystem,
    sessionStore: replay,
  });
  return annotateSystemMessages(list, raw);
}
