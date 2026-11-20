import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";

/** The compaction details the session viewer's divider shows. */
export type CompactBoundaryInfo = {
  trigger?: string;
  preTokens?: number;
  postTokens?: number;
  durationMs?: number;
};

/**
 * A row of the session viewer's transcript (`/api/sessions/transcript/[id]`).
 * `SessionMessage` doesn't carry a system entry's `subtype` or compaction
 * metadata, so the server copies them back from the raw transcript entry.
 * The compaction summary keeps the SDK's own `isCompactSummary` flag.
 */
export type HistoryMessage = SessionMessage & {
  subtype?: string;
  compactBoundary?: CompactBoundaryInfo;
  isCompactSummary?: boolean;
};
