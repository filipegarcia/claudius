// Display-oriented model derived from the SDK message stream.
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import type {
  AskAnswer,
  AskUserQuestionEvent,
  PermissionDecision,
  PermissionRequestEvent,
  PlanDecision,
  ServerEvent,
} from "@/lib/shared/events";

export type DisplayBlock =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string; redacted?: boolean }
  | {
      kind: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
      result?: { content: string; isError?: boolean };
    };

export type DisplayMessage = {
  /**
   * Stable bubble identity. For assistant messages this is the Anthropic
   * `message.id` so all SDK splits of one API response coalesce into one
   * bubble (the SDK emits a separate `SDKAssistantMessage` per content block,
   * each carrying its own wrapper uuid but sharing `message.id`). For user
   * messages — which have no Anthropic id — this is the SDK wrapper uuid.
   */
  uuid: string;
  role: "user" | "assistant";
  blocks: DisplayBlock[];
  /** When true, the message is still being streamed (deltas may keep arriving). */
  streaming?: boolean;
  /** Set when the message belongs to a subagent (Task tool_use_id). */
  parentToolUseId?: string | null;
  /**
   * SDK wrapper uuids whose content has been folded into this bubble. Used to
   * dedupe replays of the same split (same wrapper uuid arriving twice over
   * SSE) and to resolve search hits / jumps that carry a wrapper uuid back to
   * the merged bubble identity above.
   */
  foldedSdkUuids?: Set<string>;
  /**
   * Image attachments referenced by `[Image #N]` tokens in the text blocks.
   * Optimistically captured for user messages so the bubble inlines thumbnails.
   */
  images?: AttachedImage[];
  /**
   * Epoch ms when the message was first observed. Sourced from the server's
   * `sdk` event envelope (`evt.at`) — for live messages this is the receive
   * time at the broadcast funnel; for messages replayed from disk it's the
   * SDK's original `timestamp` parsed from the JSONL record. Absent when the
   * source provided no time (e.g. older assistant entries from `loadOlder`).
   */
  createdAt?: number;
};

export type TaskStatus = "pending" | "running" | "completed" | "failed" | "killed" | "stopped";

export type TaskInfo = {
  taskId: string;
  toolUseId?: string;
  description: string;
  taskType?: string;
  workflowName?: string;
  status: TaskStatus;
  isBackgrounded?: boolean;
  totalTokens?: number;
  toolUses?: number;
  durationMs?: number;
  lastToolName?: string;
  summary?: string;
  error?: string;
};

export type SystemEntry = {
  uuid: string;
  // Anchored after this assistant/user message (or "" for top-of-thread).
  afterMessageUuid: string;
  kind:
    | "init"
    | "hook_started"
    | "hook_response"
    | "status"
    | "compact_boundary"
    | "rate_limit"
    | "api_retry"
    | "permission_denied"
    | "info";
  label: string;
  detail?: string;
  ts?: string;
};

export type ToolProgressInfo = {
  toolUseId: string;
  toolName: string;
  elapsedSeconds: number;
  parentToolUseId?: string | null;
};

export type QueuedMessage = {
  id: string;
  text: string;
  /** Image attachments referenced by `[Image #ordinal]` markers in `text`. */
  images?: AttachedImage[];
  /**
   * When true, this queued entry is an SDK-handled slash command (e.g.
   * `/compact`). The flush path forwards it with `slash: true` so the server
   * skips the user-message echo and emits a `slash_invoked` system pill
   * instead.
   */
  slash?: boolean;
};

export type SessionInfo = {
  id: string;
  cwd?: string;
  model?: string;
  /** Custom title set by the user. Null when none. */
  title?: string | null;
  /**
   * Last-modified timestamp (ms since epoch) from the on-disk JSONL. Present
   * for entries sourced from `/api/sessions/all`; absent for live-only
   * sessions that haven't been flushed yet. Used to sort the SessionPicker
   * dropdown by recency.
   */
  lastModified?: number;
  /**
   * Coarse session state for the tabs strip. Only present for sessions
   * currently held in memory by the server (returned from `/api/sessions`);
   * absent for disk-only entries. Disk-only sessions render as `background`
   * in the tab strip regardless.
   */
  status?: "running" | "idle";
};

export type PendingPlan = {
  /** Server-minted id used to resolve the SDK's canUseTool promise. */
  requestId: string;
  toolUseId: string;
  plan: string;
  /** Pulled from tool_use input if present (some agents pass extra metadata). */
  raw?: Record<string, unknown>;
};

/** A todo line as the agent reports it via the TodoWrite tool. */
export type AgentTodo = {
  /** Stable id from the agent (string or number), or synthesized from content. */
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | string;
  activeForm?: string;
};

/** A recent file edit recorded from Edit / MultiEdit / Write tool_use events. */
export type RecentEdit = {
  toolUseId: string;
  /** "Edit" | "MultiEdit" | "Write" */
  toolName: string;
  filePath: string;
  /** ms since epoch when the tool_use was first observed. */
  startedAt: number;
  /** When set, the tool_result has landed. */
  done?: boolean;
  isError?: boolean;
};

/**
 * One tool_use observed in the session, plus completion status once the
 * matching tool_result lands. Powers the "Tools" section of the activity rail.
 */
export type ToolHistoryEntry = {
  toolUseId: string;
  toolName: string;
  /** Best-effort one-line summary of the tool's input (file path, command, etc.). */
  primaryArg?: string;
  /** ms since epoch when the tool_use was first observed. */
  startedAt: number;
  /** ms since epoch when the matching tool_result landed. */
  endedAt?: number;
  done?: boolean;
  isError?: boolean;
  /** Set when the tool was invoked by a subagent. */
  parentToolUseId?: string | null;
};

/** A backgrounded bash shell tracked from Bash(run_in_background=true). */
export type BackgroundBash = {
  toolUseId: string;
  /** SDK-side shell id, parsed from the launching Bash tool_result. */
  bashId?: string;
  command: string;
  startedAt: number;
  killed?: boolean;
};

export type SessionUsage = {
  totalCostUsd: number;
  numTurns: number;
  durationMs: number;
  durationApiMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  /** Per-model breakdown if available. */
  modelUsage?: Record<string, unknown>;
};

export type ChatState = {
  sessionId: string | null;
  ready: boolean;
  pending: boolean;
  messages: DisplayMessage[];
  systemEntries: SystemEntry[];
  toolProgress: Record<string, ToolProgressInfo>;
  queue: QueuedMessage[];
  pendingPermission: PermissionRequestEvent | null;
  errors: string[];
  slashCommands: string[];
  agents: string[];
  permissionMode: PermissionMode;
  model: string | null;
  sessions: SessionInfo[];
  skills: string[];
  cwd: string | null;
  usage: SessionUsage | null;
  /** All tasks ever started in this session, keyed by task_id. */
  tasks: Record<string, TaskInfo>;
  /** Subagent messages keyed by their parent_tool_use_id. */
  subagentMessages: Record<string, DisplayMessage[]>;
  pendingPlan: PendingPlan | null;
  fastModeState: "off" | "cooldown" | "on" | null;
  promptSuggestions: string[];
  /** True until the SSE replay window finishes (initial render only). */
  replaying: boolean;
  /** True if older history exists above what's currently loaded. */
  hasMoreAbove: boolean;
  /** True while a loadOlder() request is in flight. */
  loadingOlder: boolean;
  /** Latest payload from a TodoWrite tool_use — the agent's current task list. */
  latestTodos: AgentTodo[];
  /** Capped log of recent edits (Edit/MultiEdit/Write). Newest first; max 20. */
  recentEdits: RecentEdit[];
  /** Active background bash shells, keyed by tool_use_id. */
  backgroundBashes: Record<string, BackgroundBash>;
  /** Capped log of tool_use events (newest first; max 100). Includes running and finished tools. */
  toolHistory: ToolHistoryEntry[];
  /** Persisted human-readable session title. Null until set by the user. */
  sessionTitle: string | null;
  /**
   * In-flight AskUserQuestion form from the agent. The browser shows a modal;
   * resolving is `submitAskAnswer(requestId, answers)`.
   */
  pendingAsk: AskUserQuestionEvent | null;
};

export type AttachedImage = {
  /** Stable per-prompt id (UUID). */
  id: string;
  /** Monotonic ordinal printed in the `[Image #N]` token. Never decrements within a prompt. */
  ordinal: number;
  data: string;
  mediaType: string;
};

/**
 * Loose wire shape for image attachments — the hook fills in id/ordinal when
 * callers (e.g. legacy suggestion chips) don't supply them.
 */
export type SendableImage = Partial<Pick<AttachedImage, "id" | "ordinal">> &
  Pick<AttachedImage, "data" | "mediaType">;

export type ChatActions = {
  send(
    text: string,
    images?: SendableImage[],
    opts?: {
      /**
       * When true, `text` is a registered SDK-handled slash command
       * (e.g. `/compact`). The send path will:
       *   - skip the optimistic user-message render (so the chat doesn't
       *     show `/compact` as if the user typed it),
       *   - post `slash: true` to `/api/sessions/[id]/input` so the server
       *     skips the user-message broadcast and emits a `slash_invoked`
       *     system pill instead.
       * The SDK still receives the text on its input queue and interprets
       * the slash; its eventual response (compact_boundary, init reload,
       * etc.) lands as its own SSE event.
       */
      asSlashCommand?: boolean;
    },
  ): Promise<void>;
  enqueue(text: string, images?: AttachedImage[]): void;
  cancelQueued(id: string): void;
  /** Pull a queued item back into the input; returns its text and removes it. */
  editQueued(id: string): { text: string; images?: AttachedImage[] } | null;
  /** Move a queued item up (-1) or down (+1) in the queue. */
  reorderQueued(id: string, dir: -1 | 1): void;
  resolvePermission(requestId: string, decision: PermissionDecision): Promise<void>;
  interrupt(): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  setModel(model: string | null): Promise<void>;
  /**
   * Bind to a different session id. Awaits a wake POST so a reaped session
   * has its buffer rehydrated before the SSE subscribes; fire-and-forget
   * callers (every UI tab-click in this codebase) just drop the returned
   * promise.
   */
  switchSession(id: string): Promise<void>;
  createNewSession(): Promise<void>;
  /** Open a fresh session in a specific working directory (e.g. a git worktree). */
  createSessionAt(cwd: string): Promise<void>;
  refreshSessions(): Promise<void>;
  /**
   * Resolve the pending ExitPlanMode prompt. Accept flips the session out of
   * plan mode; reject sends feedback so the model can iterate. Closing the
   * overlay should call this with `{ kind: "reject" }` — without a decision
   * the SDK is left waiting on canUseTool and the agent hangs.
   */
  resolvePlan(decision: PlanDecision): Promise<void>;
  /** Fetch the page of messages older than the current head and prepend them. */
  loadOlder(): Promise<void>;
  /**
   * Paginate older pages until the given uuid is loaded. The argument may be
   * either a bubble's primary uuid (the Anthropic `message.id` for assistants,
   * or wrapper uuid for users) or any SDK wrapper uuid that was folded into a
   * bubble. Returns the bubble's primary uuid on success (use this for
   * highlight/scroll), or null if not found.
   */
  jumpToUuid(uuid: string): Promise<string | null>;
  /** Rename the current session (persists via SDK and broadcasts to the rail). */
  renameTitle(title: string): Promise<{ ok: true } | { ok: false; error: string }>;
  /** Resolve a pending AskUserQuestion form. */
  submitAskAnswer(requestId: string, answers: AskAnswer[]): Promise<void>;
};

export type ServerEventEnvelope = ServerEvent;
