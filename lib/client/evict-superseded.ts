import type { DisplayMessage } from "@/lib/client/types";

/**
 * SDK 0.3.323 — `SDKAssistantMessage.supersedes`: uuids of earlier messages
 * this one replaces (a refusal fallback, or a response whose tool call could
 * not be parsed). Hosts should remove the named messages on arrival. Bubbles
 * are keyed by Anthropic `message.id` with the SDK wrapper uuids folded into
 * `foldedSdkUuids`, so match on either.
 */
export function supersededUuidsOf(msg: unknown): Set<string> | null {
  const raw = (msg as { supersedes?: unknown } | null)?.supersedes;
  if (!Array.isArray(raw)) return null;
  const out = new Set(raw.filter((u): u is string => typeof u === "string" && u.length > 0));
  return out.size > 0 ? out : null;
}

/** Remove bubbles named by `superseded`. Returns `messages` itself when nothing matched. */
export function evictSupersededMessages(
  messages: DisplayMessage[],
  superseded: ReadonlySet<string>,
): DisplayMessage[] {
  const hit = (m: DisplayMessage) =>
    superseded.has(m.uuid) || (m.foldedSdkUuids ? [...m.foldedSdkUuids].some((u) => superseded.has(u)) : false);
  return messages.some(hit) ? messages.filter((m) => !hit(m)) : messages;
}

/** Same, across every subagent's transcript. Preserves identity when unchanged. */
export function evictSupersededFromRecord(
  record: Record<string, DisplayMessage[]>,
  superseded: ReadonlySet<string>,
): Record<string, DisplayMessage[]> {
  let changed = false;
  const next: Record<string, DisplayMessage[]> = {};
  for (const [k, list] of Object.entries(record)) {
    const filtered = evictSupersededMessages(list, superseded);
    if (filtered !== list) changed = true;
    next[k] = filtered;
  }
  return changed ? next : record;
}
