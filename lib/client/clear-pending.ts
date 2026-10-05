import type { DisplayMessage } from "./types";

/**
 * CC 2.1.275 — clear the "sent, not yet received" dimming flag on every user
 * message. Called on any `turn_status` transition (the server has taken the
 * message off our hands). Returns the SAME array reference when nothing was
 * pending, so React can skip the re-render.
 */
export function clearPendingMessages(messages: DisplayMessage[]): DisplayMessage[] {
  if (!messages.some((m) => m.pending)) return messages;
  return messages.map((m) => (m.pending ? { ...m, pending: false } : m));
}
