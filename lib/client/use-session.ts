"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import type {
  CreateSessionRequest,
  PermissionDecision,
  PermissionRequestEvent,
  AskUserQuestionEvent,
  AskAnswer,
  PlanDecision,
  ServerEvent,
} from "@/lib/shared/events";
import { costFromTokens } from "@/lib/shared/cost-pricing";
import {
  isCompactSummaryContent,
  isLocalCommandCaveatContent,
  isSdkInternalEnvelope,
  isSdkSlashUserMessage,
  isSyntheticTaskNotification,
  parseSyntheticCliWrapper,
} from "./sdk-message-filters";
import type {
  AgentTodo,
  AttachedImage,
  BackgroundBash,
  ChatActions,
  ChatState,
  DisplayBlock,
  DisplayMessage,
  PendingPlan,
  QueuedMessage,
  RecentEdit,
  SessionInfo,
  SessionUsage,
  SystemEntry,
  TaskInfo,
  TaskStatus,
  ToolHistoryEntry,
  ToolProgressInfo,
} from "./types";

type SDKContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "redacted_thinking"; data?: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string | Array<{ type: string; text?: string }>;
      is_error?: boolean;
    }
  | { type: string; [k: string]: unknown };

// sessionStorage tops out around 5–10 MB per origin in most browsers.
// Cap our serialized queue payload at 5 MB to leave room for everything else.
// Hoisted to module scope so `useCallback` deps can omit it without tripping
// exhaustive-deps.
const QUEUE_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Coerce a raw `todos` payload (as emitted by the TodoWrite tool or replayed
 * via `session_snapshot`) into the shape the activity rail renders. Tolerant
 * of missing fields — the model occasionally omits `id` or `activeForm` and
 * we want to keep the row instead of dropping it.
 */
function coerceTodos(raw: unknown[]): AgentTodo[] {
  return raw.map((t, i) => {
    const o = (t as Record<string, unknown>) ?? {};
    const content =
      typeof o.content === "string"
        ? o.content
        : typeof o.subject === "string"
          ? (o.subject as string)
          : "";
    return {
      id: typeof o.id === "string" ? o.id : `t${i}`,
      content,
      status: typeof o.status === "string" ? (o.status as string) : "pending",
      activeForm: typeof o.activeForm === "string" ? (o.activeForm as string) : undefined,
    };
  });
}

function blocksFromSDKContent(content: unknown): DisplayBlock[] {
  if (typeof content === "string") return [{ kind: "text", text: content }];
  if (!Array.isArray(content)) return [];
  const out: DisplayBlock[] = [];
  for (const raw of content as SDKContentBlock[]) {
    if (raw.type === "text" && typeof raw.text === "string") out.push({ kind: "text", text: raw.text });
    else if (raw.type === "thinking" && typeof raw.thinking === "string")
      out.push({ kind: "thinking", text: raw.thinking });
    else if (raw.type === "redacted_thinking")
      out.push({ kind: "thinking", text: "", redacted: true });
    else if (raw.type === "tool_use") {
      const tu = raw as Extract<SDKContentBlock, { type: "tool_use" }>;
      out.push({ kind: "tool_use", id: tu.id, name: tu.name, input: tu.input ?? {} });
    }
  }
  return out;
}

function extractToolResult(content: unknown): { tool_use_id: string; text: string; isError?: boolean } | null {
  if (!Array.isArray(content)) return null;
  for (const raw of content as SDKContentBlock[]) {
    if (raw.type === "tool_result") {
      const tr = raw as Extract<SDKContentBlock, { type: "tool_result" }>;
      let text = "";
      if (typeof tr.content === "string") text = tr.content;
      else if (Array.isArray(tr.content))
        text = tr.content
          .map((c) => (typeof c === "object" && c && "text" in c ? c.text ?? "" : ""))
          .join("");
      return { tool_use_id: tr.tool_use_id, text, isError: tr.is_error };
    }
  }
  return null;
}

/**
 * Pick a single representative argument from a tool's input, keyed off the
 * tool name. Best-effort — falls back to common keys, then gives up. Used by
 * the activity rail's tool history to put a recognizable subtitle under each
 * tool call without showing the full JSON.
 */
function pickPrimaryArg(name: string, input: Record<string, unknown>): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const perTool: Record<string, string[]> = {
    Bash: ["command"],
    BashOutput: ["bash_id", "shell_id"],
    KillBash: ["shell_id", "bash_id"],
    Edit: ["file_path"],
    MultiEdit: ["file_path"],
    Write: ["file_path"],
    Read: ["file_path"],
    NotebookEdit: ["notebook_path"],
    Glob: ["pattern"],
    Grep: ["pattern"],
    WebFetch: ["url"],
    WebSearch: ["query"],
    Task: ["description"],
    TodoWrite: [],
    ExitPlanMode: [],
  };
  const keys = perTool[name] ?? ["file_path", "command", "pattern", "url", "query", "description", "path"];
  for (const k of keys) {
    const v = (input as Record<string, unknown>)[k];
    if (typeof v === "string" && v) return v;
  }
  return undefined;
}

type DeltaScratch = {
  blocks: Map<
    number,
    {
      kind: "text" | "thinking" | "tool_use";
      text?: string;
      redacted?: boolean;
      toolUseId?: string;
      toolName?: string;
      partialJson?: string;
    }
  >;
};

export function useSession(): ChatState & ChatActions {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(false);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [systemEntries, setSystemEntries] = useState<SystemEntry[]>([]);
  const [toolProgress, setToolProgress] = useState<Record<string, ToolProgressInfo>>({});
  const [queue, setQueue] = useState<QueuedMessage[]>([]);
  const [pendingPermission, setPendingPermission] = useState<PermissionRequestEvent | null>(null);
  const [pendingAsk, setPendingAsk] = useState<AskUserQuestionEvent | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [slashCommands, setSlashCommands] = useState<string[]>([]);
  const [agents, setAgents] = useState<string[]>([]);
  const [skills, setSkills] = useState<string[]>([]);
  const [cwd, setCwd] = useState<string | null>(null);
  const [usage, setUsage] = useState<SessionUsage | null>(null);
  const [tasks, setTasks] = useState<Record<string, TaskInfo>>({});
  const [subagentMessages, setSubagentMessages] = useState<Record<string, DisplayMessage[]>>({});
  const [pendingPlan, setPendingPlan] = useState<PendingPlan | null>(null);
  const [fastModeState, setFastModeState] = useState<"off" | "cooldown" | "on" | null>(null);
  const [promptSuggestions, setPromptSuggestions] = useState<string[]>([]);
  const [replaying, setReplaying] = useState(true);
  const [hasMoreAbove, setHasMoreAbove] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [latestTodos, setLatestTodos] = useState<AgentTodo[]>([]);
  const [recentEdits, setRecentEdits] = useState<RecentEdit[]>([]);
  const [backgroundBashes, setBackgroundBashes] = useState<Record<string, BackgroundBash>>({});
  const [toolHistory, setToolHistory] = useState<ToolHistoryEntry[]>([]);
  const [sessionTitle, setSessionTitle] = useState<string | null>(null);
  const [permissionMode, setPermissionModeState] = useState<PermissionMode>("default");
  const [model, setModelState] = useState<string | null>(null);
  // Reasoning effort. The SDK doesn't expose the *current* effort on any
  // event we replay — there's no `effort_changed` analogue to
  // `model_changed`. We mirror what we know: "auto" until the user picks an
  // explicit level via the picker, then whatever they picked. A user who
  // types `/effort high` directly into the composer bypasses this mirror and
  // the card will lag — acceptable because the picker is the canonical
  // surface and the value re-syncs on the next picker interaction.
  const [effort, setEffortState] =
    useState<"low" | "medium" | "high" | "xhigh" | "max" | "auto">("auto");
  const [sessions, setSessions] = useState<SessionInfo[]>([]);

  // Mirror `model` into the ref so SSE handlers can compute pricing without
  // re-binding on every model change.
  useEffect(() => {
    modelRef.current = model;
  }, [model]);

  const sessionIdRef = useRef<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const messagesRef = useRef<DisplayMessage[]>([]);
  const scratchRef = useRef<Map<string, DeltaScratch>>(new Map());
  const lastAssistantUuidRef = useRef<string>("");
  const pendingRef = useRef(false);

  // Mirror messages into a ref so callbacks can read the freshest head without
  // re-binding on every state change.
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const hasMoreAboveRef = useRef(false);
  useEffect(() => {
    hasMoreAboveRef.current = hasMoreAbove;
  }, [hasMoreAbove]);

  const queueRef = useRef<QueuedMessage[]>([]);
  const pendingPermissionRef = useRef<PermissionRequestEvent | null>(null);
  const pendingPlanRef = useRef<PendingPlan | null>(null);
  // UUIDs of assistant messages whose `usage` has already been folded into
  // the running session totals. Streaming can re-emit the same uuid as
  // partials accumulate, and historical replays re-broadcast every
  // assistant message — we want each one counted exactly once.
  const countedUsageRef = useRef<Set<string>>(new Set());
  // Mirror of `model` for SSE callbacks. The pricing math needs the active
  // model name but the SSE event handler in `applyEvent` is stable (memoized
  // against state); a ref keeps it current without re-binding the EventSource.
  const modelRef = useRef<string | null>(null);
  // Mid-turn cost estimate accumulator. Per-assistant-message we estimate
  // cost from token counts using `costFromTokens` so the `$` tile updates
  // alongside the IN/OUT/CACHE tiles (the SDK's authoritative `total_cost_usd`
  // only lands on the `result` event at turn-end — until then the tile would
  // sit at $0.00 even with thousands of tokens flowing). At result time we
  // reconcile: subtract this turn's estimate and add the auth value.
  // Reset to 0 on every result event AND on session reset.
  // NOTE: subagent assistant events are intentionally counted here too — the
  // existing token accumulator includes them (see comment near `countedUsageRef`
  // dedupe below) and the SDK's `total_cost_usd` covers subagent cost as well,
  // so reconciliation nets to zero. Don't "fix" that without re-reading both
  // paths.
  const estimatedTurnCostRef = useRef<number>(0);
  // UUIDs of result events whose cost/turn totals have already been folded
  // into session state. EventSource reconnects (network blip, dev HMR,
  // tail-replay window) replay recent events, including the most recent
  // `result` — without dedupe, cost would get added each time and the `$`
  // tile would drift upward on every reconnect. Mirrors `countedUsageRef`'s
  // contract but for the turn-end frame.
  const seenResultUuidsRef = useRef<Set<string>>(new Set());
  // Per-scope (parent_tool_use_id, "" for top-level) → Anthropic message.id
  // currently being streamed. Captured from the inner `message_start` event
  // so subsequent content_block_* partials in the same scope can be anchored
  // on the same identity as the eventual terminal `SDKAssistantMessage`
  // events (which carry `message.id` directly). Cleared on `message_stop`.
  const scopeMessageIdRef = useRef<Map<string, string>>(new Map());
  const flushQueueRef = useRef<() => void>(() => {});
  // Monotonic counter for in-flight session transitions (switch / create).
  // Each call increments and captures it; after the wake POST resolves the
  // call rechecks the counter and bails if a newer transition has started.
  // Without this, two rapid switches (tab-click, then notification-jump,
  // for example) interleave their resetState/bindToSession pairs and the
  // chat ends up with messages from both sessions stacked together. The
  // SSE-close-at-top fix earlier in this file stops the OUT-of-band leak
  // through the EventSource; this counter stops the IN-band leak through
  // setMessages on a stale bindToSession callsite.
  const switchGenRef = useRef(0);

  // ── sessionStorage persistence ────────────────────────────────────────
  // Queue lives only for the duration of this tab — explicitly NOT
  // localStorage, because a tab close should drop it.
  const queueKey = (sid: string | null) => (sid ? `claudius.queue.${sid}` : null);

  /**
   * Persist a specific session's queue into sessionStorage. Keyed by the
   * explicit `sid` parameter — NOT `sessionIdRef.current` — because the
   * drain loop in `flushQueue` may write back to the originating session's
   * queue (e.g. restoring a failed send) AFTER the user has switched to a
   * different tab. Using the captured id keeps storage correctly partitioned
   * per session. React state is only updated when `sid` matches the active
   * binding; otherwise we touch only persistent storage so the queue is
   * intact for when the user returns to that session.
   *
   * Trims oldest items when the serialized payload would exceed the
   * QUEUE_MAX_BYTES cap. Surfaces a one-shot "queue too large" error in that
   * case so the user knows we dropped something.
   */
  const persistQueueForSession = useCallback((sid: string, items: QueuedMessage[]) => {
    if (typeof window === "undefined") return;
    const k = queueKey(sid);
    if (!k) return;
    let trimmedDueToSize = false;
    let toWrite = items;
    let serialized = JSON.stringify(toWrite);
    if (serialized.length > QUEUE_MAX_BYTES) {
      const trimmed = items.slice();
      while (trimmed.length > 1 && JSON.stringify(trimmed).length > QUEUE_MAX_BYTES) {
        trimmed.shift();
      }
      if (trimmed.length === 1 && JSON.stringify(trimmed).length > QUEUE_MAX_BYTES) {
        trimmed.length = 0;
      }
      toWrite = trimmed;
      serialized = JSON.stringify(toWrite);
      trimmedDueToSize = true;
      // Only mirror the trim into React state if this is the currently
      // bound session. Otherwise the user is on a different tab; we'd be
      // silently mutating their visible queue.
      if (sid === sessionIdRef.current) {
        queueRef.current = toWrite;
        setQueue([...toWrite]);
      }
    }
    try {
      window.sessionStorage.setItem(k, serialized);
    } catch {
      // Most likely QuotaExceededError — surface as the same kind of warning.
      trimmedDueToSize = true;
    }
    if (trimmedDueToSize) {
      setErrors((e) => {
        const msg = "Queue too large; oldest items removed";
        return e[e.length - 1] === msg ? e : [...e, msg];
      });
    }
  }, []);

  /**
   * Back-compat wrapper that persists the *current* session's queue.
   * Reads `sessionIdRef.current` at call time. Safe for user-driven
   * actions (enqueue, cancel, edit, reorder) because those are synchronous
   * with the active binding.
   */
  const persistQueue = useCallback((sid: string | null) => {
    if (!sid) return;
    persistQueueForSession(sid, queueRef.current);
  }, [persistQueueForSession]);

  const rehydrateQueue = useCallback((sid: string) => {
    if (typeof window === "undefined") return;
    const k = queueKey(sid);
    if (!k) return;
    try {
      const raw = window.sessionStorage.getItem(k);
      if (!raw) {
        queueRef.current = [];
        setQueue([]);
        return;
      }
      const parsed = JSON.parse(raw) as QueuedMessage[];
      if (!Array.isArray(parsed)) return;
      queueRef.current = parsed;
      setQueue([...parsed]);
    } catch {
      // ignore
    }
  }, []);


  const writeQueue = useCallback(
    (next: QueuedMessage[]) => {
      queueRef.current = next;
      setQueue([...next]);
      persistQueue(sessionIdRef.current);
    },
    [persistQueue],
  );

  /**
   * Like `writeQueue`, but parameterised on the target session id. Used by
   * the drain loop in `flushQueue` so reads/writes during a long-running
   * drain always land in the queue that *started* the drain, even if the
   * user switches to a different session mid-flight. React state is only
   * updated when `sid` is the currently bound session, so an in-flight
   * drain that races with a tab switch never bleeds queue items into the
   * incoming session's UI.
   */
  const writeQueueForSession = useCallback(
    (sid: string, next: QueuedMessage[]) => {
      if (sid === sessionIdRef.current) {
        queueRef.current = next;
        setQueue([...next]);
      }
      persistQueueForSession(sid, next);
    },
    [persistQueueForSession],
  );

  /**
   * Read a specific session's queue from sessionStorage WITHOUT touching
   * React state. Used by `flushQueue`'s error-restore path so we can
   * prepend a failed message back to its originating session's queue even
   * when the user has navigated away. Returns null when no entry exists or
   * the JSON is malformed.
   */
  const readQueueFromStorage = useCallback((sid: string): QueuedMessage[] | null => {
    if (typeof window === "undefined") return null;
    const k = queueKey(sid);
    if (!k) return null;
    try {
      const raw = window.sessionStorage.getItem(k);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as QueuedMessage[];
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }, []);

  const setPendingTracked = useCallback((p: boolean) => {
    const wasPending = pendingRef.current;
    pendingRef.current = p;
    setPending(p);
    // Any transition out of pending is a chance to drain the queue.
    if (wasPending && !p) flushQueueRef.current();
  }, []);

  const resetState = useCallback(() => {
    setReady(false);
    setPending(false);
    pendingRef.current = false;
    setMessages([]);
    setSystemEntries([]);
    setToolProgress({});
    // DON'T wipe sessionStorage[claudius.queue.<sessionIdRef.current>]
    // here. resetState runs at the top of switchSession / createSession —
    // i.e. while `sessionIdRef.current` still points at the session the
    // user is *leaving*. Wiping its queue dropped any unsent messages the
    // user had staged there (user-visible bug: "I queued three follow-ups,
    // switched away to check something, came back, and they're gone").
    // The queue is intentionally scoped per-session-id in storage and
    // rehydrated by bindToSession's `rehydrateQueue(newId)`; leaving the
    // outgoing entry alone is exactly the right behavior. React state of
    // the queue still gets cleared below so the outgoing UI doesn't bleed
    // into the incoming view.
    setQueue([]);
    queueRef.current = [];
    setPendingPermission(null);
    pendingPermissionRef.current = null;
    // DEBUG — see [ask-restore] block in applyEvent. Logs every reset so a
    // bind→subscribe race can show up as "reset cleared the ask we just set".
    console.log("[ask-restore] resetState clearing pendingAsk", {
      sessionId: sessionIdRef.current,
    });
    setPendingAsk(null);
    setErrors([]);
    setSlashCommands([]);
    setAgents([]);
    setSkills([]);
    setCwd(null);
    setUsage(null);
    countedUsageRef.current = new Set();
    estimatedTurnCostRef.current = 0;
    seenResultUuidsRef.current = new Set();
    setTasks({});
    setSubagentMessages({});
    setPendingPlan(null);
    pendingPlanRef.current = null;
    setFastModeState(null);
    setPromptSuggestions([]);
    setReplaying(true);
    setHasMoreAbove(false);
    setLoadingOlder(false);
    setLatestTodos([]);
    setRecentEdits([]);
    setBackgroundBashes({});
    setToolHistory([]);
    setSessionTitle(null);
    setPermissionModeState("default");
    setModelState(null);
    setEffortState("auto");
    scratchRef.current.clear();
    scopeMessageIdRef.current = new Map();
    lastAssistantUuidRef.current = "";
  }, []);

  const refreshSessions = useCallback(async () => {
    // Merge two sources so the dropdown shows historical sessions too — not
    // just whatever survives the in-memory reaper:
    //   - /api/sessions       → live sessions held by sessionManager
    //                           (freshest title from SSE, accurate `model`)
    //   - /api/sessions/all   → durable JSONL list with `lastModified` for
    //                           sorting and `customTitle` for renamed sessions
    //
    // Live wins on overlap. We sort by recency and keep the top 20 — the
    // dropdown links to /sessions for the long tail.
    //
    // IMPORTANT (2026-05-12): we deliberately do NOT use `summary` or
    // `firstPrompt` from the disk row as a title fallback. The SDK
    // computes `summary` as `customTitle || aiTitle || lastPrompt ||
    // summaryHint || firstPrompt`, so when the user hasn't renamed the
    // session, both fields collapse to prompt text — and tabs end up
    // labelled with a sentence the user typed instead of a name. Mirrors
    // the server-side `resolveSessionTitle` invariant. When no trusted
    // title exists, leave it null and `tabLabelFor` renders the id prefix.
    try {
      const [liveRes, diskRes] = await Promise.allSettled([
        fetch("/api/sessions"),
        fetch("/api/sessions/all?limit=25"),
      ]);

      let live: SessionInfo[] = [];
      if (liveRes.status === "fulfilled" && liveRes.value.ok) {
        const data = (await liveRes.value.json()) as unknown;
        if (Array.isArray(data)) live = data as SessionInfo[];
      }

      type DiskItem = {
        sessionId: string;
        /** Title persisted in our SQLite index (per-project `.claudius.db`).
         *  Set by `setSessionTitle` on every Claudius-side rename, even
         *  when the SDK's `renameSession` couldn't write the JSONL header
         *  yet. This is the authoritative signal that the user named the
         *  session — see the API route comment for the full rationale. */
        claudiusTitle?: string;
        /** Title persisted by the SDK in the JSONL header. Set by the
         *  TUI's `/rename`, by `renameSession` when it succeeds, and by
         *  the SDK's auto-derived `aiTitle`. Empty for sessions renamed
         *  before their first turn flushed to disk. */
        customTitle?: string;
        summary?: string;
        firstPrompt?: string;
        lastModified?: number;
        cwd?: string;
      };
      let disk: DiskItem[] = [];
      if (diskRes.status === "fulfilled" && diskRes.value.ok) {
        const data = (await diskRes.value.json()) as { sessions?: unknown };
        if (Array.isArray(data.sessions)) disk = data.sessions as DiskItem[];
      }

      const byId = new Map<string, SessionInfo>();
      // Seed with disk first so live entries can override cwd/model/title.
      for (const d of disk) {
        if (!d.sessionId) continue;
        // Trusted sources only — see the IMPORTANT note at the top of
        // this callback. Prefer our DB title (claudiusTitle) over the
        // SDK's customTitle since the DB write survives the JSONL-not-
        // yet-flushed window; never use summary/firstPrompt as a title
        // because those collapse to prompt text.
        const title =
          (d.claudiusTitle && d.claudiusTitle.trim()) ||
          (d.customTitle && d.customTitle.trim()) ||
          null;
        byId.set(d.sessionId, {
          id: d.sessionId,
          cwd: d.cwd,
          title,
          lastModified: d.lastModified,
        });
      }
      for (const l of live) {
        if (!l?.id) continue;
        const prev = byId.get(l.id);
        byId.set(l.id, {
          ...prev,
          ...l,
          // Live `title` is null until the user renames — fall back to
          // the trusted disk title (customTitle only, no prompt text).
          // When everything is null, `tabLabelFor` renders the id prefix.
          title: l.title ?? prev?.title ?? null,
          // Live-only entries (just spawned, no JSONL flush yet) get
          // "right now" so they bubble to the top of the recency sort.
          lastModified: prev?.lastModified ?? Date.now(),
        });
      }

      const sorted = [...byId.values()].sort(
        (a, b) => (b.lastModified ?? 0) - (a.lastModified ?? 0),
      );
      const top = sorted.slice(0, 20);
      // Always keep every live session present so the SessionTabs status
      // dot has a status field to read for tabs whose JSONL `lastModified`
      // is old enough that recency sort pushed them past the cutoff. A live
      // tab paints "running"/"idle"; without this fallback it would silently
      // revert to "background" and confuse the user.
      const liveIds = new Set(live.map((l) => l.id));
      const inTop = new Set(top.map((s) => s.id));
      const extras = sorted.filter((s) => liveIds.has(s.id) && !inTop.has(s.id));
      const merged = extras.length === 0 ? top : [...top, ...extras];

      setSessions(merged);
    } catch {
      // ignore
    }
  }, []);

  // Re-pull the sessions list when the tab regains focus. Background tabs
  // may have started or finished turns while this client was asleep — without
  // this poke the SessionTabs status dots would freeze at whatever the
  // server returned on last refresh.
  //
  // Using `visibilitychange` (not `focus`) so a window getting moved between
  // monitors doesn't fire a spurious refresh, and so it actually catches the
  // common case of switching desktops / coming back from a long sleep.
  useEffect(() => {
    function onVis() {
      if (!document.hidden) void refreshSessions();
    }
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [refreshSessions]);

  /**
   * Single-pass flush: pop the head of the active session's queue, send it
   * to the SDK, and STOP — waiting for the SDK's `result` event to flip
   * pending back to false before the next call (which fires from
   * `setPendingTracked`'s edge logic). This keeps the queue UI behaving
   * like a staging area: while the agent is busy, follow-ups sit visible
   * in the queue strip; each turn's completion peels off exactly one
   * queued message and starts the next turn.
   *
   * Bails when:
   *   - No active session id.
   *   - The SDK is busy (`pendingRef.current`) — the next pending-edge
   *     transition will retrigger us.
   *   - A permission card is open (`pendingPermissionRef.current`) — the
   *     SDK is parked on `canUseTool`; `resolvePermission` retriggers us.
   *   - Queue is empty.
   *
   * Persistence: captures `id` at entry and routes every storage write
   * through `writeQueueForSession(id, …)`. So if the user switches session
   * during the POST and the send then fails, the failed item is restored
   * into the *originating* session's queue, not the incoming one. (The
   * pre-fix flushQueue persisted under `sessionIdRef.current`, which moved
   * during the await.)
   */
  const flushQueue = useCallback(async () => {
    const id = sessionIdRef.current;
    if (!id) return;
    if (pendingRef.current) return;
    if (pendingPermissionRef.current) return;
    if (queueRef.current.length === 0) return;

    const next = queueRef.current[0];
    const rest = queueRef.current.slice(1);
    writeQueueForSession(id, rest);
    const uuid = crypto.randomUUID();
    // Same slash-command rule as `send()`: skip the optimistic user-message
    // render so `/compact` doesn't show up as if the user typed it — the
    // server emits a `slash_invoked` system pill instead.
    if (!next.slash) {
      const sentAt = Date.now();
      setMessages((prev) => [
        ...prev,
        {
          uuid,
          role: "user",
          blocks: [{ kind: "text", text: next.text }],
          ...(next.images && next.images.length ? { images: next.images } : {}),
          createdAt: sentAt,
        },
      ]);
    }
    setPendingTracked(true);
    let res: Response;
    try {
      res = await fetch(`/api/sessions/${id}/input`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: next.text,
          images: next.images,
          uuid,
          ...(next.slash ? { slash: true } : {}),
        }),
      });
    } catch (err) {
      // POST failed — restore THIS message into the originating session's
      // queue (prepended). Read storage fresh in case more items landed
      // while the POST was in flight. React state only mirrors the restore
      // when we're still on `id`.
      const currentForId = readQueueFromStorage(id) ?? rest;
      writeQueueForSession(id, [next, ...currentForId]);
      setErrors((e) => [
        ...e,
        `send failed: ${err instanceof Error ? err.message : String(err)}`,
      ]);
      if (sessionIdRef.current === id) setPendingTracked(false);
      return;
    }
    if (!res.ok) {
      const currentForId = readQueueFromStorage(id) ?? rest;
      writeQueueForSession(id, [next, ...currentForId]);
      setErrors((e) => [...e, `send failed: ${res.status}`]);
      if (sessionIdRef.current === id) setPendingTracked(false);
    }
  }, [setPendingTracked, writeQueueForSession, readQueueFromStorage]);
  flushQueueRef.current = () => {
    void flushQueue();
  };

  const applyEvent = useCallback(
    (ev: ServerEvent) => {
      if (ev.type === "ready") {
        setReady(true);
        return;
      }
      if (ev.type === "error") {
        setErrors((e) => [...e, ev.message]);
        setPendingTracked(false);
        return;
      }
      if (ev.type === "permission_request") {
        setPendingPermission(ev);
        pendingPermissionRef.current = ev;
        return;
      }
      if (ev.type === "ask_user_question") {
        // DEBUG (issue: modal doesn't reappear after workspace switch).
        // Tag with current sessionId + the event's requestId/toolUseId so the
        // browser console shows whether SSE re-delivered the pending ask on
        // resume — and whether the bound session matches by the time we apply.
        // Remove once the workspace-switch restore is fully understood.
        console.log("[ask-restore] sse ask_user_question", {
          eventSessionExpected: sessionIdRef.current,
          requestId: ev.requestId,
          toolUseId: ev.toolUseId,
          questionCount: ev.questions.length,
        });
        setPendingAsk(ev);
        return;
      }
      if (ev.type === "plan_approval_request") {
        const next: PendingPlan = {
          requestId: ev.requestId,
          toolUseId: ev.toolUseId,
          plan: ev.plan,
          ...(ev.raw ? { raw: ev.raw } : {}),
        };
        setPendingPlan(next);
        pendingPlanRef.current = next;
        return;
      }
      if (ev.type === "mode_changed") {
        setPermissionModeState(ev.mode);
        return;
      }
      if (ev.type === "model_changed") {
        setModelState(ev.model ?? null);
        return;
      }
      if (ev.type === "session_title") {
        setSessionTitle(ev.title ?? null);
        return;
      }
      if (ev.type === "session_snapshot") {
        // Server-side derived-state rehydration. Carries derived state
        // that lives upstream of the tail-replay window:
        //   - Latest TodoWrite payload (so the rail repopulates).
        //   - Last real user prompt (so the chat shows "what did I ask?"
        //     even when the prompt is buried under a long tool chain
        //     and the tail window dropped it off the top).
        if (Array.isArray(ev.todos)) setLatestTodos(coerceTodos(ev.todos));
        const prompt = ev.lastUserPrompt;
        if (prompt && prompt.uuid && prompt.text) {
          // Inject the user message into the transcript if the SSE replay
          // didn't already deliver it. Prepend, not append: the snapshot
          // fires when the prompt is chronologically OLDER than everything
          // in the replay window (otherwise we'd already have it). Dedupe
          // by uuid so a later replay-window fix or a history load doesn't
          // double-render it.
          setMessages((prev) => {
            if (prev.some((m) => m.uuid === prompt.uuid)) return prev;
            return [
              {
                uuid: prompt.uuid,
                role: "user",
                blocks: [{ kind: "text", text: prompt.text }],
                ...(typeof prompt.at === "number" ? { createdAt: prompt.at } : {}),
              },
              ...prev,
            ];
          });
        }
        return;
      }
      if (ev.type === "turn_status") {
        // Authoritative "is the agent busy?" signal from the server. Fires
        // on transitions of `turnInFlight` / pending-prompt maps, and is
        // re-emitted after `replay_done` so a tab that attached mid-turn
        // (long Bash, slow tool) paints the StatusLine / tab dot correctly
        // even when no further assistant chunks arrive.
        setPendingTracked(ev.status === "running");
        return;
      }
      if (ev.type === "replay_done") {
        setReplaying(false);
        setHasMoreAbove(ev.hasMoreAbove);
        // The assistant-message handler marks every replayed message as
        // `streaming: true` and flips pending — that's correct for live
        // turns but wrong for historical ones. Reconcile here once the
        // replay window is over.
        setMessages((prev) => prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)));
        setPendingTracked(false);
        // Recovery for in-flight interactive prompts. The server's
        // subscribe() re-emits these on attach, but in dev-mode HMR an
        // existing Session instance can stay bound to a pre-edit
        // prototype — the resolved API route below always picks up edits,
        // so this fetch is the belt to the subscribe()'s suspenders.
        const id = sessionIdRef.current;
        if (id) {
          console.log("[ask-restore] replay_done — fetching /pending-prompts", { id });
          void fetch(`/api/sessions/${id}/pending-prompts`)
            .then(async (res) => {
              if (!res.ok) {
                console.log("[ask-restore] /pending-prompts non-OK", {
                  id,
                  status: res.status,
                });
                return;
              }
              const j = (await res.json().catch(() => ({}))) as {
                asks?: AskUserQuestionEvent[];
                permissions?: PermissionRequestEvent[];
              };
              console.log("[ask-restore] /pending-prompts response", {
                id,
                asksCount: j.asks?.length ?? 0,
                permissionsCount: j.permissions?.length ?? 0,
                stillBoundToSameSession: sessionIdRef.current === id,
              });
              if (sessionIdRef.current !== id) return; // user switched
              const ask = j.asks?.[0];
              if (ask) {
                console.log("[ask-restore] recovery setPendingAsk", {
                  requestId: ask.requestId,
                  toolUseId: ask.toolUseId,
                });
                setPendingAsk(ask);
              }
              const perm = j.permissions?.[0];
              if (perm) {
                setPendingPermission(perm);
                pendingPermissionRef.current = perm;
              }
            })
            .catch((err) => {
              console.log("[ask-restore] /pending-prompts fetch threw", { err: String(err) });
              // Best-effort — the subscribe() path is the primary delivery.
            });
        }
        return;
      }
      if (ev.type !== "sdk") return;

      const msg = ev.message;

      if (msg.type === "assistant") {
        const beta = msg.message as {
          id?: string;
          content?: unknown;
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
          };
        };
        const sdkUuid = msg.uuid;
        // Anthropic message id, shared across every SDK split of one API
        // response. The SDK emits one `SDKAssistantMessage` per content block
        // with its own wrapper uuid but the same `message.id` — coalesce on
        // that id so [thinking, tool_use] renders as one bubble rather than
        // two. Fall back to the wrapper uuid when the inner id is missing
        // (defensive: synthetic events, older replays).
        const messageId = typeof beta.id === "string" && beta.id ? beta.id : sdkUuid;
        // For token / cost dedupe, key on `messageId` rather than the wrapper
        // uuid. Each split carries the full turn `usage` payload — keying on
        // wrapper uuid double-counts by the number of splits (a thinking +
        // tool_use response would count usage twice).
        const usageDedupKey = messageId;

        // Accumulate per-API-call token usage so the rail meters update
        // mid-turn (the `result` event only fires when the whole turn ends).
        // Counted before the subagent early-return so sub-agent tokens land
        // in the session total too. Cost is left alone — that needs the
        // pricing math the SDK does in its result event.
        if (beta.usage && !countedUsageRef.current.has(usageDedupKey)) {
          countedUsageRef.current.add(usageDedupKey);
          const u = beta.usage;
          // Estimate per-call cost so the `$` tile updates alongside the
          // token tiles. Reconciled with the SDK's authoritative
          // `total_cost_usd` at result-event time (see below). Falls back to
          // Sonnet pricing when the model is unknown, which is good enough
          // for a mid-turn indicator — the auth value replaces it within a
          // few seconds anyway.
          const turnEstimate = costFromTokens(
            (beta as { model?: string }).model ?? modelRef.current ?? undefined,
            {
              input: u.input_tokens ?? 0,
              output: u.output_tokens ?? 0,
              cacheRead: u.cache_read_input_tokens ?? 0,
              cacheWrite5m: u.cache_creation_input_tokens ?? 0,
              cacheWrite1h: 0,
            },
          );
          estimatedTurnCostRef.current += turnEstimate;
          setUsage((prev) => ({
            totalCostUsd: (prev?.totalCostUsd ?? 0) + turnEstimate,
            numTurns: prev?.numTurns ?? 0,
            durationMs: prev?.durationMs ?? 0,
            durationApiMs: prev?.durationApiMs ?? 0,
            inputTokens: (prev?.inputTokens ?? 0) + (u.input_tokens ?? 0),
            outputTokens: (prev?.outputTokens ?? 0) + (u.output_tokens ?? 0),
            cacheReadInputTokens:
              (prev?.cacheReadInputTokens ?? 0) + (u.cache_read_input_tokens ?? 0),
            cacheCreationInputTokens:
              (prev?.cacheCreationInputTokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
            modelUsage: prev?.modelUsage,
          }));
        }

        const parent = (msg as { parent_tool_use_id?: string | null }).parent_tool_use_id ?? null;
        const blocks = blocksFromSDKContent(beta?.content);
        // If we already have a streaming scratch keyed on this messageId, the
        // bubble's blocks are being assembled live from content_block_*
        // deltas — the terminal split's content is already represented there.
        // Append from terminal only when no scratch exists (replay path or
        // SDK builds without partials).
        const hasStreamScratch = (scratchRef.current.get(messageId)?.blocks.size ?? 0) > 0;
        if (parent) {
          // Subagent traffic — keep separate from the main transcript.
          setSubagentMessages((prev) => ({
            ...prev,
            [parent]: upsertAssistantSplit(
              prev[parent] ?? [],
              messageId,
              sdkUuid,
              blocks,
              hasStreamScratch,
              parent,
              ev.at,
            ),
          }));
          // Don't override the main lastAssistantUuid — deltas anchor to top-level.
          return;
        }
        lastAssistantUuidRef.current = messageId;
        setMessages((prev) =>
          upsertAssistantSplit(prev, messageId, sdkUuid, blocks, hasStreamScratch, undefined, ev.at),
        );
        setPendingTracked(true);
        // Activity-rail: surface thinking phases that arrived on the
        // terminal assistant split (i.e. JSONL replay on reload, or a
        // turn whose stream_event partials never reached this tab).
        // The live path adds the same key from `content_block_start` —
        // the dedup-by-id below means we don't double-insert. We mark
        // these "done" because by the time the terminal split lands the
        // thinking block is complete; for the live path the entry is
        // already present and is marked done by `message_stop`.
        for (let i = 0; i < blocks.length; i++) {
          const b = blocks[i];
          if (b.kind !== "thinking") continue;
          const thinkingId = `thinking:${messageId}:${i}`;
          setToolHistory((prev) => {
            if (prev.some((e) => e.toolUseId === thinkingId)) return prev;
            const entry: ToolHistoryEntry = {
              toolUseId: thinkingId,
              toolName: b.redacted ? "Thinking (encrypted)" : "Thinking",
              startedAt: Date.now(),
              done: true,
              endedAt: Date.now(),
              kind: "thinking",
            };
            return [entry, ...prev].slice(0, 100);
          });
        }
        // Activity-rail reducers: per-tool side effects.
        for (const b of blocks) {
          if (b.kind !== "tool_use") continue;

          // Tool history — record every tool_use exactly once, regardless of
          // whether downstream tool_progress events ever fire.
          setToolHistory((prev) => {
            if (prev.some((e) => e.toolUseId === b.id)) return prev;
            const entry: ToolHistoryEntry = {
              toolUseId: b.id,
              toolName: b.name,
              primaryArg: pickPrimaryArg(b.name, b.input),
              startedAt: Date.now(),
              parentToolUseId: parent,
            };
            return [entry, ...prev].slice(0, 100);
          });

          // ExitPlanMode is intercepted server-side in canUseTool — the
          // browser receives a `plan_approval_request` event instead, so the
          // tool_use block doesn't need any special handling here.

          // TodoWrite — capture the latest todos snapshot.
          if (b.name === "TodoWrite") {
            const raw = (b.input as { todos?: unknown }).todos;
            if (Array.isArray(raw)) setLatestTodos(coerceTodos(raw));
            continue;
          }

          // Edit / MultiEdit / Write — record the path for the Recent Edits widget.
          if (b.name === "Edit" || b.name === "MultiEdit" || b.name === "Write") {
            const fp = (b.input as { file_path?: unknown }).file_path;
            if (typeof fp === "string" && fp) {
              setRecentEdits((prev) => {
                if (prev.some((r) => r.toolUseId === b.id)) return prev;
                return [
                  { toolUseId: b.id, toolName: b.name, filePath: fp, startedAt: Date.now() },
                  ...prev,
                ].slice(0, 20);
              });
            }
            continue;
          }

          // Bash with run_in_background — track as a backgrounded shell.
          if (b.name === "Bash") {
            const inp = b.input as { command?: unknown; run_in_background?: unknown };
            if (inp.run_in_background === true && typeof inp.command === "string") {
              setBackgroundBashes((prev) => {
                if (prev[b.id]) return prev;
                const entry: BackgroundBash = {
                  toolUseId: b.id,
                  command: inp.command as string,
                  startedAt: Date.now(),
                };
                return { ...prev, [b.id]: entry };
              });
            }
            continue;
          }

          // KillBash — mark the matching bash entry as killed.
          if (b.name === "KillBash") {
            const sid = (b.input as { shell_id?: unknown; bash_id?: unknown }).shell_id ??
              (b.input as { bash_id?: unknown }).bash_id;
            if (typeof sid === "string") {
              setBackgroundBashes((prev) => {
                // shell_id may be a SDK-side id (not the tool_use_id) — try
                // both: exact tool_use_id match, else best-effort by command
                // start substring.
                if (prev[sid]) {
                  return { ...prev, [sid]: { ...prev[sid], killed: true } };
                }
                return prev;
              });
            }
            continue;
          }
        }
        return;
      }

      if (msg.type === "stream_event") {
        const sm = msg as {
          uuid: string;
          parent_tool_use_id?: string | null;
          event: {
            type: string;
            index?: number;
            content_block?: SDKContentBlock;
            delta?: { type: string; text?: string; thinking?: string; partial_json?: string };
            message?: { id?: string };
          };
        };
        const evt = sm.event;
        // Anchor partials on the inner Anthropic `message.id`, not on the
        // SDK wrapper uuid — those wrappers are minted PER stream_event and
        // PER terminal split, so they don't match each other and don't match
        // across deltas. Capture the message.id from `message_start` and
        // hold it per-scope until `message_stop`, then key the scratch and
        // bubble lookup on that id. The eventual `SDKAssistantMessage`
        // splits carry the same id directly, so the assistant-handler and
        // this branch land on the same bubble.
        const subagentParent = sm.parent_tool_use_id ?? null;
        const scopeKey = subagentParent ?? "";
        if (evt.type === "message_start" && evt.message?.id) {
          scopeMessageIdRef.current.set(scopeKey, evt.message.id);
          // Initialize a (possibly empty) scratch so subsequent
          // content_block_start events have a slot. No bubble yet — we wait
          // for the first content_block_start so an empty placeholder bubble
          // doesn't flash.
          if (!scratchRef.current.has(evt.message.id)) {
            scratchRef.current.set(evt.message.id, { blocks: new Map() });
          }
          return;
        }
        // Resolve anchor from the per-scope map. Fall back to sm.uuid for
        // defensive coverage — message_start may be missing from a buffer
        // window that started mid-message after a reconnect.
        const anchor = scopeMessageIdRef.current.get(scopeKey) ?? sm.uuid;
        if (!anchor) return;
        let scratch = scratchRef.current.get(anchor);
        if (!scratch) {
          scratch = { blocks: new Map() };
          scratchRef.current.set(anchor, scratch);
        }
        if (evt.type === "content_block_start" && typeof evt.index === "number" && evt.content_block) {
          const cb = evt.content_block;
          if (cb.type === "text")
            scratch.blocks.set(evt.index, { kind: "text", text: typeof cb.text === "string" ? cb.text : "" });
          else if (cb.type === "thinking" || cb.type === "redacted_thinking") {
            const redacted = cb.type === "redacted_thinking";
            scratch.blocks.set(evt.index, {
              kind: "thinking",
              text: cb.type === "thinking" && typeof cb.thinking === "string" ? cb.thinking : "",
              ...(redacted ? { redacted: true } : {}),
            });
            // Surface the thinking phase in the right-pane Tools list as a
            // synthetic spinner row. Keyed on `thinking:<msgId>:<idx>` so a
            // subsequent message_stop / replay can mark this exact entry
            // done without colliding with real tool_use ids. Skipped for
            // subagent turns — those don't push into the top-level tool
            // history today (only the parent Task tool_use is tracked).
            if (!subagentParent) {
              const thinkingId = `thinking:${anchor}:${evt.index}`;
              setToolHistory((prev) => {
                if (prev.some((e) => e.toolUseId === thinkingId)) return prev;
                const entry: ToolHistoryEntry = {
                  toolUseId: thinkingId,
                  toolName: redacted ? "Thinking (encrypted)" : "Thinking",
                  startedAt: Date.now(),
                  kind: "thinking",
                };
                return [entry, ...prev].slice(0, 100);
              });
            }
          } else if (cb.type === "tool_use") {
            const tu = cb as Extract<SDKContentBlock, { type: "tool_use" }>;
            scratch.blocks.set(evt.index, { kind: "tool_use", toolUseId: tu.id, toolName: tu.name, partialJson: "" });
          }
        } else if (evt.type === "content_block_delta" && typeof evt.index === "number" && evt.delta) {
          const slot = scratch.blocks.get(evt.index);
          if (!slot) return;
          if (evt.delta.type === "text_delta" && evt.delta.text) slot.text = (slot.text ?? "") + evt.delta.text;
          else if (evt.delta.type === "thinking_delta" && evt.delta.thinking)
            slot.text = (slot.text ?? "") + evt.delta.thinking;
          else if (evt.delta.type === "input_json_delta" && evt.delta.partial_json)
            slot.partialJson = (slot.partialJson ?? "") + evt.delta.partial_json;
        } else if (evt.type === "content_block_stop" && typeof evt.index === "number" && evt.content_block) {
          // Some SDK builds emit the final block payload here rather than
          // streaming deltas through the whole turn (notably for short
          // thinking blocks). Fold the stop payload into the slot if the
          // deltas didn't fill it.
          const cb = evt.content_block;
          const slot = scratch.blocks.get(evt.index);
          if (
            slot &&
            slot.kind === "thinking" &&
            !slot.text &&
            cb.type === "thinking" &&
            typeof cb.thinking === "string"
          ) {
            // Narrow on the discriminator AND the field — the catch-all arm
            // of `SDKContentBlock` carries an `[k: string]: unknown` index
            // signature that poisons a bare `cb.thinking` access. The typeof
            // guard collapses it back to `string`.
            slot.text = cb.thinking;
          }
        } else if (evt.type === "message_stop") {
          if (subagentParent) {
            setSubagentMessages((prev) => ({
              ...prev,
              [subagentParent]: (prev[subagentParent] ?? []).map((m) =>
                m.uuid === anchor ? { ...m, streaming: false } : m,
              ),
            }));
          } else {
            setMessages((prev) => prev.map((m) => (m.uuid === anchor ? { ...m, streaming: false } : m)));
            // Close out any synthetic thinking rows owned by this message —
            // their id namespace is `thinking:<anchor>:<idx>`. Real tool_use
            // rows resolve via their tool_result; thinking has no result, so
            // we use message_stop as the falling edge.
            setToolHistory((prev) => {
              const prefix = `thinking:${anchor}:`;
              let changed = false;
              const next = prev.map((e) => {
                if (e.kind !== "thinking" || e.done) return e;
                if (!e.toolUseId.startsWith(prefix)) return e;
                changed = true;
                return { ...e, done: true, endedAt: Date.now() };
              });
              return changed ? next : prev;
            });
          }
          // Release the scope so the next message_start in this scope mints
          // a fresh anchor instead of inheriting the just-closed message's.
          if (scopeMessageIdRef.current.get(scopeKey) === anchor) {
            scopeMessageIdRef.current.delete(scopeKey);
          }
          return;
        } else {
          return;
        }
        const buildMerged = (existingBlocks: DisplayBlock[]): DisplayBlock[] => {
          const merged: DisplayBlock[] = [];
          const indices = [...scratch!.blocks.keys()].sort((a, b) => a - b);
          for (const i of indices) {
            const slot = scratch!.blocks.get(i)!;
            if (slot.kind === "text") merged.push({ kind: "text", text: slot.text ?? "" });
            else if (slot.kind === "thinking")
              merged.push({
                kind: "thinking",
                text: slot.text ?? "",
                ...(slot.redacted ? { redacted: true } : {}),
              });
            else if (slot.kind === "tool_use") {
              let parsed: Record<string, unknown> = {};
              try {
                parsed = slot.partialJson ? JSON.parse(slot.partialJson) : {};
              } catch {
                parsed = { __partial: slot.partialJson ?? "" };
              }
              merged.push({
                kind: "tool_use",
                id: slot.toolUseId ?? "",
                name: slot.toolName ?? "",
                input: parsed,
              });
            }
          }
          // Preserve any tool_result already folded onto a tool_use we own —
          // the result lands via a separate `user`/`tool_result` event and
          // would otherwise get wiped on every scratch flush.
          const preservedResults = new Map<string, { content: string; isError?: boolean }>();
          for (const b of existingBlocks) {
            if (b.kind === "tool_use" && b.result) preservedResults.set(b.id, b.result);
          }
          for (const b of merged) {
            if (b.kind === "tool_use" && preservedResults.has(b.id)) b.result = preservedResults.get(b.id);
          }
          return merged;
        };
        if (subagentParent) {
          setSubagentMessages((prev) => {
            const list = prev[subagentParent] ?? [];
            const idx = list.findIndex((m) => m.uuid === anchor);
            if (idx === -1) {
              // Partial for a subagent whose terminal `assistant` hasn't
              // landed yet — seed a placeholder at the Anthropic message.id
              // so the eventual terminal splits land on the same bubble.
              const placeholder: DisplayMessage = {
                uuid: anchor,
                role: "assistant",
                blocks: buildMerged([]),
                streaming: true,
                parentToolUseId: subagentParent,
                ...(typeof ev.at === "number" ? { createdAt: ev.at } : {}),
              };
              return { ...prev, [subagentParent]: [...list, placeholder] };
            }
            const next = list.slice();
            next[idx] = { ...next[idx], blocks: buildMerged(next[idx].blocks) };
            return { ...prev, [subagentParent]: next };
          });
        } else {
          setMessages((prev) => {
            const idx = prev.findIndex((m) => m.uuid === anchor);
            if (idx === -1) {
              // Partial whose terminal `assistant` event hasn't landed yet
              // (the common path with includePartialMessages: true) — seed
              // a placeholder keyed on the Anthropic message.id so the
              // eventual terminal splits merge into this same bubble.
              const placeholder: DisplayMessage = {
                uuid: anchor,
                role: "assistant",
                blocks: buildMerged([]),
                streaming: true,
                ...(typeof ev.at === "number" ? { createdAt: ev.at } : {}),
              };
              // Keep the "latest top-level assistant" pointer in sync so
              // system pills (status, rate_limit) anchor under the active
              // bubble rather than the previous turn's.
              lastAssistantUuidRef.current = anchor;
              return [...prev, placeholder];
            }
            const next = prev.slice();
            next[idx] = { ...next[idx], blocks: buildMerged(next[idx].blocks) };
            return next;
          });
        }
        return;
      }

      if (msg.type === "user") {
        const inner = (msg as { message: { content?: unknown } }).message;
        const isSynthetic = (msg as { isSynthetic?: boolean }).isSynthetic === true;
        const parent = (msg as { parent_tool_use_id?: string | null }).parent_tool_use_id ?? null;
        const result = extractToolResult(inner?.content);
        if (result) {
          // Tool results land on whichever tool_use carries that id, in main or subagent.
          setMessages((prev) =>
            prev.map((m) => ({
              ...m,
              blocks: m.blocks.map((b) =>
                b.kind === "tool_use" && b.id === result.tool_use_id
                  ? { ...b, result: { content: result.text, isError: result.isError } }
                  : b,
              ),
            })),
          );
          setSubagentMessages((prev) => {
            const next = { ...prev };
            for (const [pid, list] of Object.entries(prev)) {
              next[pid] = list.map((m) => ({
                ...m,
                blocks: m.blocks.map((b) =>
                  b.kind === "tool_use" && b.id === result.tool_use_id
                    ? { ...b, result: { content: result.text, isError: result.isError } }
                    : b,
                ),
              }));
            }
            return next;
          });
          setToolProgress((prev) => {
            if (!(result.tool_use_id in prev)) return prev;
            const copy = { ...prev };
            delete copy[result.tool_use_id];
            return copy;
          });
          // Mark the tool_history entry done.
          setToolHistory((prev) => {
            const idx = prev.findIndex((e) => e.toolUseId === result.tool_use_id);
            if (idx === -1) return prev;
            const copy = prev.slice();
            copy[idx] = {
              ...copy[idx],
              done: true,
              endedAt: Date.now(),
              isError: result.isError,
            };
            return copy;
          });
          // Mark a tracked recent-edit as done (best-effort — toolUseId match).
          setRecentEdits((prev) => {
            const idx = prev.findIndex((r) => r.toolUseId === result.tool_use_id);
            if (idx === -1) return prev;
            const copy = prev.slice();
            copy[idx] = { ...copy[idx], done: true, isError: result.isError };
            return copy;
          });
          // If this tool_result is the launch acknowledgement for a background
          // bash, extract the SDK-side `bash_id` so the viewer can stitch
          // subsequent BashOutput results.
          setBackgroundBashes((prev) => {
            const entry = prev[result.tool_use_id];
            if (!entry || entry.bashId) return prev;
            const m = result.text.match(/bash[_-]?(?:id)?[: ]+([\w-]+)/i);
            const bashId = m?.[1];
            if (!bashId) return prev;
            return { ...prev, [result.tool_use_id]: { ...entry, bashId } };
          });
          return;
        }
        // Subagent user-shaped message (typically the spawning prompt). Route to subagent.
        if (parent && inner) {
          const content = inner.content;
          let text = "";
          if (typeof content === "string") text = content;
          else if (Array.isArray(content)) {
            for (const c of content as Array<{ type?: string; text?: string }>) {
              if (c?.type === "text" && c.text) text += c.text;
            }
          }
          if (text) {
            const uuid = (msg as { uuid?: string }).uuid ?? crypto.randomUUID();
            setSubagentMessages((prev) => {
              const list = prev[parent] ?? [];
              if (list.some((m) => m.uuid === uuid)) return prev;
              return {
                ...prev,
                [parent]: [
                  ...list,
                  {
                    uuid,
                    role: "user",
                    blocks: [{ kind: "text", text }],
                    parentToolUseId: parent,
                    ...(typeof ev.at === "number" ? { createdAt: ev.at } : {}),
                  },
                ],
              };
            });
          }
          return;
        }
        // Surface user messages from a resumed transcript so the chat shows history.
        if (!isSynthetic && inner) {
          // Drop transcript-only plumbing the SDK flags on the envelope —
          // the post-/compact "Session continued from a previous conversation"
          // synthesized user message (isCompactSummary + isVisibleInTranscriptOnly)
          // and the <local-command-caveat> wrapper around slash runs (isMeta).
          // Both look like user prose by content shape (the parsers below see
          // them as "real" text) but they were authored by the SDK for the
          // model's eyes only. The `compact_boundary` system event already
          // marks the transition, so we don't replace these with pills.
          if (isSdkInternalEnvelope(msg)) return;
          const content = inner.content;
          // Content-shape fallback for the live iterator. The SDK's `query`
          // async iterator forwards SDKUserMessage envelopes WITHOUT the
          // `isCompactSummary` / `isMeta` flags that exist on the JSONL —
          // only the disk-replay paths (`resyncFromDisk`, `synthesizeOlder`)
          // see them. Without these two content-shape checks, the live
          // /compact run dumps the full summary AND the local-command-caveat
          // wrapper into the chat as user bubbles. See `isCompactSummaryContent`.
          if (isCompactSummaryContent(content)) return;
          if (isLocalCommandCaveatContent(content)) return;
          // Drop SDK-injected <task-notification> wrappers — they're context
          // for the model, not user-authored prose, and rendering them as a
          // user bubble surfaces XML the user didn't write. The matching
          // system `task_notification` event still updates the TaskBlock UI.
          if (isSyntheticTaskNotification(content)) return;
          // Same idea for SDK-handled slash commands replayed from disk: a
          // prior `/compact` lives on in the JSONL as a user message, and
          // re-rendering it as user prose would re-introduce the echo bug on
          // reload. Render a small system pill instead — symmetric with the
          // live-send path's `slash_invoked` event.
          const slash = isSdkSlashUserMessage(content);
          if (slash) {
            const uuid = (msg as { uuid?: string }).uuid ?? crypto.randomUUID();
            const anchor = lastAssistantUuidRef.current;
            setSystemEntries((prev) => {
              if (prev.some((e) => e.uuid === uuid)) return prev;
              return [
                ...prev,
                {
                  uuid,
                  afterMessageUuid: anchor,
                  kind: "info",
                  label: `Ran ${slash.command}${slash.args ? ` ${slash.args}` : ""}`,
                },
              ];
            });
            return;
          }
          // CLI plumbing wrappers around a slash command run:
          //   <command-name>/X</command-name><command-message>…</command-message><command-args>…</command-args>
          //   <local-command-stdout>…</local-command-stdout>
          //   <local-command-stderr>…</local-command-stderr>
          // The subprocess sends these as user-role messages so the model can
          // see what command ran and what its output was. Render them as
          // assistant-side system pills so the user doesn't see XML in their
          // own bubble.
          const cli = parseSyntheticCliWrapper(content);
          if (cli) {
            const uuid = (msg as { uuid?: string }).uuid ?? crypto.randomUUID();
            const anchor = lastAssistantUuidRef.current;
            let label: string;
            if (cli.kind === "command") {
              label = `Ran ${cli.command}${cli.args ? ` ${cli.args}` : ""}`;
            } else if (cli.kind === "stdout") {
              label = cli.text ? `CLI: ${cli.text}` : "CLI ran";
            } else {
              // stderr: surface as plain info with a "CLI error:" prefix; we
              // don't promote to a red ShieldAlert pill (that kind is reserved
              // for blocked tool calls — a slash that writes a warning to
              // stderr shouldn't look like a security alert).
              label = cli.text ? `CLI error: ${cli.text}` : "CLI error";
            }
            setSystemEntries((prev) => {
              if (prev.some((e) => e.uuid === uuid)) return prev;
              return [...prev, { uuid, afterMessageUuid: anchor, kind: "info", label }];
            });
            return;
          }
          let text = "";
          if (typeof content === "string") text = content;
          else if (Array.isArray(content)) {
            for (const c of content as Array<{ type?: string; text?: string }>) {
              if (c?.type === "text" && c.text) text += c.text;
            }
          }
          if (text) {
            const uuid = (msg as { uuid?: string }).uuid ?? crypto.randomUUID();
            setMessages((prev) => {
              if (prev.some((m) => m.uuid === uuid)) return prev;
              return [
                ...prev,
                {
                  uuid,
                  role: "user",
                  blocks: [{ kind: "text", text }],
                  ...(typeof ev.at === "number" ? { createdAt: ev.at } : {}),
                },
              ];
            });
          }
        }
        return;
      }

      if (msg.type === "result") {
        setPendingTracked(false);
        // The active session just transitioned running → idle. Pull a fresh
        // sessions list so the SessionTabs strip can repaint the non-active
        // tabs' status dots — they get no live signal of their own and would
        // otherwise stay stuck at whatever was true when the dropdown was
        // last opened.
        void refreshSessions();
        const anchor = lastAssistantUuidRef.current;
        if (anchor) setMessages((prev) => prev.map((m) => (m.uuid === anchor ? { ...m, streaming: false } : m)));
        const r = msg as {
          uuid?: string;
          subtype?: string;
          duration_ms?: number;
          duration_api_ms?: number;
          num_turns?: number;
          total_cost_usd?: number;
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
          };
          modelUsage?: Record<string, unknown>;
          fast_mode_state?: "off" | "cooldown" | "on";
        };
        if (r.fast_mode_state) setFastModeState(r.fast_mode_state);

        // Idempotency: every SDK result event carries a uuid (see
        // SDKResultSuccess / SDKResultError). If we've already folded this
        // one into session state, the SSE stream is just replaying it — bail
        // out before double-counting cost/turns. Still call flushQueue so
        // the queued-input side-effects fire normally.
        if (r.uuid && seenResultUuidsRef.current.has(r.uuid)) {
          void flushQueue();
          return;
        }
        if (r.uuid) seenResultUuidsRef.current.add(r.uuid);

        // Capture the mid-turn estimate to a local BEFORE the setter so the
        // reducer closes over the value we measured here, not whatever the
        // ref happens to hold by the time React commits. The ref is reset
        // synchronously below so the next turn starts at 0 even if the
        // setter runs later.
        const estimate = estimatedTurnCostRef.current;
        estimatedTurnCostRef.current = 0;

        // Cost reconciliation runs on EVERY result event — including
        // non-success subtypes (`error_max_turns`, `error_during_execution`,
        // cancellations). Errors still cost tokens, and gating on
        // `subtype === "success"` was the second half of the "$0.00 forever"
        // bug. If the SDK supplies an auth value we use it; otherwise we
        // keep the estimate as the best signal we have.
        const authCost = typeof r.total_cost_usd === "number" ? r.total_cost_usd : null;
        setUsage((prev) => ({
          totalCostUsd:
            (prev?.totalCostUsd ?? 0) - estimate + (authCost ?? estimate),
          numTurns: (prev?.numTurns ?? 0) + (r.num_turns ?? 0),
          durationMs: (prev?.durationMs ?? 0) + (r.duration_ms ?? 0),
          durationApiMs: (prev?.durationApiMs ?? 0) + (r.duration_api_ms ?? 0),
          inputTokens: prev?.inputTokens ?? 0,
          outputTokens: prev?.outputTokens ?? 0,
          cacheReadInputTokens: prev?.cacheReadInputTokens ?? 0,
          cacheCreationInputTokens: prev?.cacheCreationInputTokens ?? 0,
          modelUsage: r.modelUsage ?? prev?.modelUsage,
        }));
        void flushQueue();
        return;
      }

      if (msg.type === "tool_progress") {
        const tp = msg as {
          tool_use_id: string;
          tool_name: string;
          elapsed_time_seconds: number;
          parent_tool_use_id: string | null;
        };
        setToolProgress((prev) => ({
          ...prev,
          [tp.tool_use_id]: {
            toolUseId: tp.tool_use_id,
            toolName: tp.tool_name,
            elapsedSeconds: tp.elapsed_time_seconds,
            parentToolUseId: tp.parent_tool_use_id,
          },
        }));
        return;
      }

      if (msg.type === "system") {
        const sysAny = msg as { subtype?: string; uuid: string; [k: string]: unknown };
        const anchor = lastAssistantUuidRef.current;
        const baseEntry: Omit<SystemEntry, "kind" | "label"> = {
          uuid: sysAny.uuid,
          afterMessageUuid: anchor,
        };
        if (sysAny.subtype === "init") {
          const init = sysAny as {
            tools?: string[];
            slash_commands?: string[];
            agents?: string[];
            skills?: string[];
            cwd?: string;
            model?: string;
            permissionMode?: PermissionMode;
            claude_code_version?: string;
          };
          if (init.slash_commands) setSlashCommands(init.slash_commands);
          if (init.agents) setAgents(init.agents);
          if (init.skills) setSkills(init.skills);
          if (init.cwd) setCwd(init.cwd);
          if (init.model) setModelState(init.model);
          if (init.permissionMode) setPermissionModeState(init.permissionMode);
          setSystemEntries((prev) => [
            ...prev,
            {
              ...baseEntry,
              kind: "init",
              label: `Session ready · ${init.model ?? ""}`,
              detail: `${init.tools?.length ?? 0} tools · ${init.slash_commands?.length ?? 0} commands · ${init.agents?.length ?? 0} agents`,
            },
          ]);
          return;
        }
        if (sysAny.subtype === "hook_started") {
          const h = sysAny as { hook_name?: string; hook_event?: string };
          setSystemEntries((prev) => [
            ...prev,
            { ...baseEntry, kind: "hook_started", label: `Hook ${h.hook_name ?? h.hook_event ?? ""}` },
          ]);
          return;
        }
        if (sysAny.subtype === "hook_response") {
          const h = sysAny as { hook_name?: string; exit_code?: number; outcome?: string };
          setSystemEntries((prev) => [
            ...prev,
            {
              ...baseEntry,
              kind: "hook_response",
              label: `Hook ${h.hook_name ?? ""} → ${h.outcome ?? "ok"}`,
              detail: typeof h.exit_code === "number" ? `exit ${h.exit_code}` : undefined,
            },
          ]);
          return;
        }
        if (sysAny.subtype === "status") {
          const s = sysAny as { status?: string };
          setSystemEntries((prev) => [
            ...prev,
            { ...baseEntry, kind: "status", label: `Status: ${s.status ?? ""}` },
          ]);
          return;
        }
        if (sysAny.subtype === "compact_boundary") {
          setSystemEntries((prev) => [
            ...prev,
            { ...baseEntry, kind: "compact_boundary", label: "Compacted earlier conversation" },
          ]);
          return;
        }
        if (sysAny.subtype === "slash_invoked") {
          // Server-side breadcrumb for an SDK-handled slash command. We
          // render it as a small "Running /compact…" pill so the chat
          // doesn't go silent while the SDK works — the eventual outcome
          // (compact_boundary, init reload, etc.) lands as its own pill.
          const s = sysAny as { command?: string; args?: string };
          const cmd = (s.command ?? "").trim() || "/?";
          const args = (s.args ?? "").trim();
          setSystemEntries((prev) => [
            ...prev,
            {
              ...baseEntry,
              kind: "info",
              label: `Running ${cmd}${args ? ` ${args}` : ""}…`,
            },
          ]);
          return;
        }
        if (sysAny.subtype === "task_started") {
          const t = sysAny as unknown as {
            task_id: string;
            tool_use_id?: string;
            description?: string;
            task_type?: string;
            workflow_name?: string;
          };
          setTasks((prev) => ({
            ...prev,
            [t.task_id]: {
              taskId: t.task_id,
              toolUseId: t.tool_use_id,
              description: t.description ?? "(no description)",
              taskType: t.task_type,
              workflowName: t.workflow_name,
              status: "running",
            },
          }));
          return;
        }
        if (sysAny.subtype === "task_updated") {
          const t = sysAny as unknown as {
            task_id: string;
            patch: { status?: TaskStatus; description?: string; error?: string; is_backgrounded?: boolean };
          };
          setTasks((prev) => {
            const existing = prev[t.task_id];
            if (!existing) return prev;
            return {
              ...prev,
              [t.task_id]: {
                ...existing,
                status: t.patch.status ?? existing.status,
                description: t.patch.description ?? existing.description,
                error: t.patch.error ?? existing.error,
                isBackgrounded: t.patch.is_backgrounded ?? existing.isBackgrounded,
              },
            };
          });
          return;
        }
        if (sysAny.subtype === "task_progress") {
          const t = sysAny as unknown as {
            task_id: string;
            description?: string;
            usage?: { total_tokens?: number; tool_uses?: number; duration_ms?: number };
            last_tool_name?: string;
            summary?: string;
          };
          setTasks((prev) => {
            const existing = prev[t.task_id];
            if (!existing) return prev;
            return {
              ...prev,
              [t.task_id]: {
                ...existing,
                description: t.description ?? existing.description,
                totalTokens: t.usage?.total_tokens ?? existing.totalTokens,
                toolUses: t.usage?.tool_uses ?? existing.toolUses,
                durationMs: t.usage?.duration_ms ?? existing.durationMs,
                lastToolName: t.last_tool_name ?? existing.lastToolName,
                summary: t.summary ?? existing.summary,
              },
            };
          });
          return;
        }
        if (sysAny.subtype === "task_notification") {
          const t = sysAny as unknown as {
            task_id: string;
            status: "completed" | "failed" | "stopped";
            summary?: string;
            usage?: { total_tokens?: number; tool_uses?: number; duration_ms?: number };
          };
          setTasks((prev) => {
            const existing = prev[t.task_id];
            const base: TaskInfo = existing ?? {
              taskId: t.task_id,
              description: t.summary ?? "(unknown)",
              status: "completed",
            };
            return {
              ...prev,
              [t.task_id]: {
                ...base,
                status: t.status,
                summary: t.summary ?? base.summary,
                totalTokens: t.usage?.total_tokens ?? base.totalTokens,
                toolUses: t.usage?.tool_uses ?? base.toolUses,
                durationMs: t.usage?.duration_ms ?? base.durationMs,
              },
            };
          });
          return;
        }
        setSystemEntries((prev) => [
          ...prev,
          { ...baseEntry, kind: "info", label: `system/${sysAny.subtype ?? "?"}` },
        ]);
        return;
      }

      if (msg.type === "rate_limit_event") {
        const r = msg as { rate_limit_info?: { status?: string; rateLimitType?: string }; uuid: string };
        const anchor = lastAssistantUuidRef.current;
        setSystemEntries((prev) => [
          ...prev,
          {
            uuid: r.uuid,
            afterMessageUuid: anchor,
            kind: "rate_limit",
            label: `Rate limit: ${r.rate_limit_info?.status ?? "?"} (${r.rate_limit_info?.rateLimitType ?? ""})`,
          },
        ]);
        return;
      }

      if (msg.type === "prompt_suggestion") {
        const s = (msg as { suggestion?: string }).suggestion;
        if (typeof s === "string" && s.trim()) {
          setPromptSuggestions((prev) => (prev.includes(s) ? prev : [...prev, s].slice(-4)));
        }
        return;
      }
    },
    [flushQueue, refreshSessions, setPendingTracked],
  );

  const bindToSession = useCallback(
    (id: string) => {
      eventSourceRef.current?.close();
      sessionIdRef.current = id;
      setSessionId(id);
      rehydrateQueue(id);
      // No flush trigger here. Rehydrated items stay visible in the
      // QueueIndicator; the normal pending-edge cadence (turn ends →
      // setPendingTracked false → flushQueue) drains them when the SDK
      // returns to idle. If the SDK is *already* idle when the user
      // returns to this session, the items wait for a manual user action
      // — matching the staging-area UX the user reported preferring.
      // Reflect the bound session id in the URL so a refresh resumes it.
      // Use replaceState (no history entry) and strip the `at` cursor — it's
      // a one-shot resume anchor and shouldn't survive past the first bind.
      if (typeof window !== "undefined") {
        try {
          const url = new URL(window.location.href);
          url.searchParams.set("session", id);
          url.searchParams.delete("at");
          window.history.replaceState(null, "", url.toString());
        } catch {
          // ignore — non-fatal
        }
        // Next.js's `useSearchParams` doesn't observe `replaceState`, so the
        // workspace-level NotificationsProvider would stall on the previous
        // session id after an in-app tab switch (and notify on / auto-read
        // the wrong tab). Dispatch a custom event so `useActiveSessionId`
        // can pick up the new binding without waiting for the next router
        // navigation.
        try {
          window.dispatchEvent(
            new CustomEvent("claudius:session-bound", { detail: { sessionId: id } }),
          );
        } catch {
          // ignore — non-fatal
        }
      }
      // Capture the bound id in the closure so SSE callbacks can early-out
      // when this tab has moved on. Two race shapes this defends against:
      //   1. `close()` is supposed to stop event delivery synchronously, but
      //      already-queued onmessage tasks can still fire one more time on
      //      some browsers — without a guard those bleed events from the
      //      outgoing session into the freshly-cleared state of the next one
      //      (user reported "messages from other sessions appear").
      //   2. Rapid switches (notification jump fires while a tab click is
      //      still mid-await on the wake POST) can stack two bindToSession
      //      invocations whose closures both hold live EventSources for a
      //      few ms; the guard makes sure only the latest closure wins.
      // `sessionIdRef.current` is the single source of truth for the active
      // binding — bindToSession sets it synchronously above.
      const boundId = id;
      const es = new EventSource(`/api/sessions/${id}/stream?tail=20`);
      eventSourceRef.current = es;
      es.onmessage = (msg) => {
        if (sessionIdRef.current !== boundId) return;
        try {
          const ev = JSON.parse(msg.data) as ServerEvent;
          applyEvent(ev);
        } catch (err) {
          console.error("bad SSE payload", err, msg.data);
        }
      };
      es.onerror = () => {
        if (sessionIdRef.current !== boundId) return;
        // EventSource fires `error` for both transient drops (it will retry
        // automatically) and permanent failures. Distinguish by readyState:
        //   CONNECTING (0) → reconnect in flight, do nothing — when it lands
        //                    the server replays buffered events and the
        //                    `replay_done` handler re-asserts pending state.
        //   CLOSED (2)     → browser has given up (server returned non-2xx,
        //                    or repeated retries failed). No more events
        //                    will arrive on this socket, so a `pending`
        //                    flag set to true earlier is now stuck — clear
        //                    it so the StatusLine stops claiming "Working"
        //                    against a dead stream.
        if (es.readyState === EventSource.CLOSED) {
          setPendingTracked(false);
        }
      };
    },
    [applyEvent, rehydrateQueue, setPendingTracked],
  );

  const switchSession = useCallback(
    async (id: string): Promise<void> => {
      if (sessionIdRef.current === id) return;
      // Bump the generation counter FIRST. Any concurrent switchSession
      // / createSession call that's awaiting its wake POST will see the
      // bumped value and bail out before its bindToSession runs — that
      // prevents two transitions from interleaving and bleeding state
      // from one into the other.
      const gen = ++switchGenRef.current;

      // Hard-cut the outgoing session.
      //  - Close the EventSource synchronously per the WHATWG spec, so
      //    the browser stops dispatching its events immediately.
      //  - Null sessionIdRef BEFORE the await: every read site (send,
      //    flushQueue, resolvePermission, …) checks `if (!id) return`,
      //    so any user activity during the ~30–100 ms wake POST window
      //    fail-softs instead of POSTing to the OUTGOING session and
      //    leaving an optimistic bubble that then renders against the
      //    INCOMING session's freshly-replayed state. (The user kept
      //    reporting "my messages went somewhere else / disappeared";
      //    this synchronous in-band leak via setMessages was the path
      //    that survived the earlier SSE-close fix.)
      //  - resetState clears the transcript so the user sees an empty
      //    pane while the new session loads, not a half-stale view.
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      sessionIdRef.current = null;
      setSessionId(null);
      resetState();
      // AWAIT the wake POST before opening the SSE — this mirrors the
      // boot path exactly (`createSession` does `await fetch(...)` then
      // `bindToSession`). Earlier we used `void fetch(...)` for a tighter
      // perceived latency, but the POST and SSE then raced and the SSE
      // sometimes subscribed to a Session whose `start()` had only
      // half-populated the buffer — the symptom the user reported as
      // "old session is empty until I refresh."
      //
      // POST is idempotent on the server: `sessionManager.create` with a
      // `resume` opt returns the in-memory Session if one exists, and
      // otherwise loads from the JSONL — in BOTH cases awaiting `start()`
      // so by the time POST resolves, the buffer is fully populated and
      // the SSE subscribe immediately replays the whole transcript.
      //
      // Cost: one extra round-trip (~30-100ms typical on localhost). The
      // user sees the same brief "Starting" state they'd see during boot
      // refresh — strictly an improvement over the broken empty-until-
      // reload behaviour.
      try {
        const res = await fetch("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ resume: id }),
        });
        if (process.env.NEXT_PUBLIC_CLAUDIUS_DEBUG_SESSIONS) {
           
          console.log("[sess-load] switchSession wake POST", {
            id,
            status: res.status,
            ok: res.ok,
          });
        }
        // Body intentionally not parsed — we already have the id, and the
        // server's reply just confirms which one it bound (idempotent).
      } catch (err) {
        if (process.env.NEXT_PUBLIC_CLAUDIUS_DEBUG_SESSIONS) {
           
          console.warn("[sess-load] switchSession wake POST failed", {
            id,
            err: err instanceof Error ? err.message : String(err),
          });
        }
        // Non-fatal: the stream route still does its own getOrResumeSession
        // fallback, so we proceed to bindToSession either way.
      }
      // A newer transition started while we were awaiting? Give up.
      // The newer call has already bumped the generation, closed any ES,
      // and will run its own bindToSession when its await resolves.
      // Continuing here would clobber it.
      if (switchGenRef.current !== gen) return;
      bindToSession(id);
      void refreshSessions();
    },
    [bindToSession, resetState, refreshSessions],
  );

  const createSession = useCallback(
    async (opts: CreateSessionRequest = {}): Promise<string | null> => {
      // Mirror switchSession's discipline. Bump the generation counter so
      // any in-flight switch bails when it next checks. Cut the outgoing
      // session (ES + sessionIdRef) at the top so user activity during
      // the create POST can't leak into the outgoing session. resetState
      // wipes the transcript so the user sees an empty pane while the
      // new session is being born.
      const gen = ++switchGenRef.current;
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      sessionIdRef.current = null;
      setSessionId(null);
      resetState();
      try {
        const res = await fetch("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(opts),
        });
        if (!res.ok) throw new Error(`create session failed: ${res.status}`);
        const { id } = (await res.json()) as { id: string };
        // A newer transition superseded this one — don't bind.
        if (switchGenRef.current !== gen) return null;
        bindToSession(id);
        await refreshSessions();
        return id;
      } catch (err) {
        setErrors((e) => [...e, err instanceof Error ? err.message : String(err)]);
        return null;
      }
    },
    [bindToSession, refreshSessions, resetState],
  );

  const createNewSession = useCallback(async () => {
    await createSession({});
  }, [createSession]);

  const createSessionAt = useCallback(
    async (newCwd: string) => {
      await createSession({ cwd: newCwd });
    },
    [createSession],
  );

  // Boot on mount; honor URL ?session=, ?at=, and ?prompt= (seed initial input).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    // ?new=1 forces creating a fresh session, even if ?session= is present
    // and even if a last-active tab is persisted. Used by /clear and any
    // explicit "new chat" entry point.
    const forceNew = params.get("new") === "1";
    let resume: string | undefined = forceNew ? undefined : params.get("session") || undefined;
    const at = forceNew ? undefined : params.get("at") || undefined;
    const seed = params.get("prompt") || undefined;
    if (forceNew && typeof window !== "undefined") {
      try {
        const url = new URL(window.location.href);
        url.searchParams.delete("new");
        url.searchParams.delete("session");
        url.searchParams.delete("at");
        window.history.replaceState(null, "", url.toString());
      } catch {
        // ignore
      }
    }
    (async () => {
      // Fall back to the last-active tab when no explicit session was
      // requested in the URL — otherwise every page load would spawn a
      // brand-new session on top of the persisted strip.
      if (!resume && !forceNew) {
        try {
          const r = await fetch("/api/sessions/open-tabs");
          if (r.ok) {
            const data = (await r.json()) as { activeId?: unknown };
            if (typeof data.activeId === "string" && data.activeId) {
              resume = data.activeId;
            }
          }
        } catch {
          // Best-effort: a network failure just means we create fresh.
        }
      }
      const created = await createSession(resume ? { resume, resumeSessionAt: at } : {});
      if (created && seed) {
        // Wait briefly for the session to be `ready` before sending.
        const start = Date.now();
        while (!sessionIdRef.current && Date.now() - start < 5000) {
          await new Promise((r) => setTimeout(r, 100));
        }
        // Strip ?prompt from URL so refresh doesn't re-fire it.
        try {
          const url = new URL(window.location.href);
          url.searchParams.delete("prompt");
          window.history.replaceState({}, "", url.toString());
        } catch {
          // ignore
        }
        // Push to the input queue once ready.
        const tick = () => {
          if (pendingRef.current === false) {
            const id = sessionIdRef.current;
            if (id) {
              void fetch(`/api/sessions/${id}/input`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ text: seed }),
              });
            }
          } else {
            setTimeout(tick, 250);
          }
        };
        setTimeout(tick, 600);
      }
    })();
    return () => {
      eventSourceRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const send = useCallback(
    async (
      text: string,
      images?: Array<{ id?: string; ordinal?: number; data: string; mediaType: string }>,
      opts?: { asSlashCommand?: boolean },
    ) => {
      const id = sessionIdRef.current;
      const trimmedText = text.trim();
      const hasImages = Array.isArray(images) && images.length > 0;
      if (!id || (!trimmedText && !hasImages)) return;
      const isSlash = !!opts?.asSlashCommand;
      // Normalize to AttachedImage shape for client/queue persistence.
      const normalized = hasImages
        ? images!.map((img, i) => ({
            id: img.id ?? crypto.randomUUID(),
            ordinal: typeof img.ordinal === "number" ? img.ordinal : i + 1,
            data: img.data,
            mediaType: img.mediaType,
          }))
        : undefined;
      if (pendingRef.current || pendingPermissionRef.current) {
        const q: QueuedMessage = {
          id: crypto.randomUUID(),
          text,
          ...(normalized ? { images: normalized } : {}),
          ...(isSlash ? { slash: true } : {}),
        };
        writeQueue([...queueRef.current, q]);
        // No flush trigger here — that's intentional. The queue is a
        // staging area: items stay visible in the QueueIndicator strip
        // until the current turn finishes, then `setPendingTracked`'s
        // true→false edge peels off exactly one item and starts the next
        // turn. This is the original "single-pass" cadence; an earlier
        // pipeline-drain version that auto-flushed here turned the queue
        // into "type 3 messages, all 3 land as user bubbles immediately"
        // which lost the staging UX.
        return;
      }
      const uuid = crypto.randomUUID();
      // Slash commands shouldn't render as user messages — the server emits a
      // `slash_invoked` system pill in their place. Skipping the optimistic
      // add here keeps the chat clean even before the SSE pill arrives.
      if (!isSlash) {
        const sentAt = Date.now();
        setMessages((prev) => [
          ...prev,
          {
            uuid,
            role: "user",
            blocks: [{ kind: "text", text }],
            ...(normalized ? { images: normalized } : {}),
            createdAt: sentAt,
          },
        ]);
      }
      setPromptSuggestions([]);
      setPendingTracked(true);
      setErrors([]);
      const res = await fetch(`/api/sessions/${id}/input`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Pass the optimistic uuid so the server's broadcast echoes it back
        // with the same id; applyEvent dedups by uuid so this tab doesn't
        // double-render, while other subscribers pick it up for the first
        // time on SSE replay. For slash commands the server doesn't echo a
        // user message at all — the uuid still rides along as the SDK input
        // id so the JSONL stays consistent.
        body: JSON.stringify({
          text,
          images: normalized,
          uuid,
          ...(isSlash ? { slash: true } : {}),
        }),
      });
      if (!res.ok) {
        setErrors((e) => [...e, `send failed: ${res.status}`]);
        setPendingTracked(false);
      }
    },
    [setPendingTracked, writeQueue],
  );

  const enqueue = useCallback(
    (text: string, images?: AttachedImage[]) => {
      const trimmed = text.trim();
      if (!trimmed && (!images || images.length === 0)) return;
      const q: QueuedMessage = {
        id: crypto.randomUUID(),
        text: trimmed,
        ...(images && images.length ? { images } : {}),
      };
      writeQueue([...queueRef.current, q]);
      // Intentionally no flush trigger — see comment in `send()`. Items
      // sit in the queue until the next pending-edge transition drains
      // the head.
    },
    [writeQueue],
  );

  const cancelQueued = useCallback(
    (qid: string) => {
      writeQueue(queueRef.current.filter((q) => q.id !== qid));
    },
    [writeQueue],
  );

  const editQueued = useCallback(
    (qid: string): { text: string; images?: AttachedImage[] } | null => {
      const item = queueRef.current.find((q) => q.id === qid);
      if (!item) return null;
      writeQueue(queueRef.current.filter((q) => q.id !== qid));
      return {
        text: item.text,
        ...(item.images && item.images.length ? { images: item.images } : {}),
      };
    },
    [writeQueue],
  );

  const reorderQueued = useCallback(
    (qid: string, dir: -1 | 1) => {
      const idx = queueRef.current.findIndex((q) => q.id === qid);
      if (idx === -1) return;
      const swap = idx + dir;
      if (swap < 0 || swap >= queueRef.current.length) return;
      const next = [...queueRef.current];
      [next[idx], next[swap]] = [next[swap], next[idx]];
      writeQueue(next);
    },
    [writeQueue],
  );

  const resolvePermission = useCallback(async (requestId: string, decision: PermissionDecision) => {
    const id = sessionIdRef.current;
    if (!id) return;
    setPendingPermission(null);
    pendingPermissionRef.current = null;
    const res = await fetch(`/api/sessions/${id}/permission`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId, decision }),
    });
    if (res.ok) flushQueueRef.current();
  }, []);

  const submitAskAnswer = useCallback(
    async (requestId: string, answers: AskAnswer[]) => {
      const id = sessionIdRef.current;
      if (!id) return;
      setPendingAsk(null);
      await fetch(`/api/sessions/${id}/ask-answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId, answers }),
      }).catch(() => {});
    },
    [],
  );

  const interrupt = useCallback(async () => {
    const id = sessionIdRef.current;
    if (!id) return;
    await fetch(`/api/sessions/${id}/interrupt`, { method: "POST" });
    setPendingTracked(false);
  }, [setPendingTracked]);

  const setPermissionMode = useCallback(async (mode: PermissionMode) => {
    const id = sessionIdRef.current;
    if (!id) return;
    setPermissionModeState(mode);
    await fetch(`/api/sessions/${id}/mode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    }).catch(() => {});
  }, []);

  const resolvePlan = useCallback(async (decision: PlanDecision) => {
    const id = sessionIdRef.current;
    if (!id) return;
    // Snapshot the pending request so we can clear local state immediately
    // (closes the modal) while the POST is in flight. If there's nothing
    // pending, treat as a no-op — the prompt was already resolved.
    const pending = pendingPlanRef.current;
    if (!pending) return;
    setPendingPlan(null);
    pendingPlanRef.current = null;
    await fetch(`/api/sessions/${id}/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: pending.requestId, decision }),
    }).catch(() => {});
  }, []);

  const loadOlder = useCallback(async () => {
    const id = sessionIdRef.current;
    if (!id) return;
    if (!hasMoreAbove) return;
    if (loadingOlder) return;
    setLoadingOlder(true);
    try {
      // The transcript route looks up `before` against the JSONL's raw
      // wrapper uuids — pass an SDK wrapper uuid (the first split folded
      // into the head bubble) instead of the bubble's primary identity
      // (which is the Anthropic `message.id`, not present in JSONL records'
      // top-level `uuid` field). For user-message heads, the primary uuid
      // IS the wrapper uuid, so the fallback works without extra cases.
      const headBubble = messagesRef.current[0];
      const head =
        headBubble?.foldedSdkUuids?.values().next().value ?? headBubble?.uuid;
      const url = head
        ? `/api/sessions/${id}/transcript?before=${encodeURIComponent(head)}&limit=50`
        : `/api/sessions/${id}/transcript?limit=50`;
      const res = await fetch(url);
      if (!res.ok) return;
      const data = (await res.json()) as {
        messages: Array<Record<string, unknown>>;
        hasMore: boolean;
      };
      const synth = synthesizeOlder(data.messages);
      if (synth.messages.length > 0) {
        setMessages((prev) => {
          const seen = new Set(prev.map((m) => m.uuid));
          const fresh = synth.messages.filter((m) => !seen.has(m.uuid));
          return [...fresh, ...prev];
        });
      }
      setHasMoreAbove(data.hasMore);
    } finally {
      setLoadingOlder(false);
    }
  }, [hasMoreAbove, loadingOlder]);

  /**
   * Make sure a given uuid is loaded into `messages` state, paginating older
   * pages as needed. Accepts either a bubble's primary uuid (Anthropic
   * `message.id` for assistants, wrapper uuid for users) OR any SDK wrapper
   * uuid that was folded into a bubble — search hits carry the latter.
   *
   * Returns the bubble's primary uuid on success (use that for highlight /
   * scroll-into-view, which key on `data-message-uuid` set from the primary),
   * or null if the head of the transcript was reached without a match.
   */
  const jumpToUuid = useCallback(
    async (uuid: string): Promise<string | null> => {
      const resolve = (): string | null => {
        for (const m of messagesRef.current) {
          if (m.uuid === uuid) return m.uuid;
          if (m.foldedSdkUuids?.has(uuid)) return m.uuid;
        }
        return null;
      };
      const first = resolve();
      if (first) return first;
      // Cap iterations defensively — transcripts above ~10k messages are
      // pathological enough that we'd rather give up than spin.
      for (let i = 0; i < 200; i++) {
        if (!hasMoreAboveRef.current) break;
        await loadOlder();
        const next = resolve();
        if (next) return next;
      }
      return resolve();
    },
    [loadOlder],
  );

  const setModel = useCallback(async (m: string | null) => {
    const id = sessionIdRef.current;
    if (!id) return;
    setModelState(m);
    await fetch(`/api/sessions/${id}/model`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: m }),
    }).catch(() => {});
  }, []);

  /**
   * Effort/reasoning level. Routed through a dedicated `/effort` API route
   * that calls `Query.applyFlagSettings({ effortLevel: <level> })` on the
   * server. The first cut sent `/effort <level>` as a slash command, but
   * the SDK doesn't register that command and answered with
   * "/effort isn't available in this environment." — leaving the picker
   * looking like it worked while the model kept its prior effort.
   *
   * `"auto"` clears the override and restores adaptive thinking. We
   * optimistic-mirror the pick locally so the SessionCard pill reflects
   * the chosen level immediately; the SDK doesn't emit an
   * `effort_changed` event we can subscribe to, so this mirror is the
   * source of truth as long as users only change effort through the
   * picker.
   */
  const setEffort = useCallback(
    async (level: "low" | "medium" | "high" | "xhigh" | "max" | "auto") => {
      const id = sessionIdRef.current;
      if (!id) return;
      setEffortState(level);
      await fetch(`/api/sessions/${id}/effort`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ level }),
      }).catch(() => {});
    },
    [],
  );

  const renameTitle = useCallback(
    async (title: string): Promise<{ ok: true } | { ok: false; error: string }> => {
      const id = sessionIdRef.current;
      if (!id) return { ok: false, error: "no active session" };
      const trimmed = title.trim();
      if (!trimmed) return { ok: false, error: "title required" };
      // Optimistic local update — the SSE `session_title` event will confirm
      // (or, if the API call fails below, we revert).
      const prev = sessionTitle;
      setSessionTitle(trimmed);
      try {
        const res = await fetch(`/api/sessions/rename`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: id, title: trimmed }),
        });
        if (!res.ok) {
          setSessionTitle(prev);
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          return { ok: false, error: body.error ?? `HTTP ${res.status}` };
        }
        // Refresh the indexed sessions list so non-active *tabs* in the same
        // browser tab pick up the new title via tabLabelFor's lookup. The
        // active tab already reflects the rename through `sessionTitle` /
        // the SSE `session_title` event.
        void refreshSessions();
        return { ok: true };
      } catch (err) {
        setSessionTitle(prev);
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    [sessionTitle, refreshSessions],
  );

  return {
    sessionId,
    ready,
    pending,
    messages,
    systemEntries,
    toolProgress,
    queue,
    pendingPermission,
    pendingAsk,
    errors,
    slashCommands,
    agents,
    permissionMode,
    model,
    effort,
    sessions,
    skills,
    cwd,
    usage,
    tasks,
    subagentMessages,
    pendingPlan,
    fastModeState,
    promptSuggestions,
    replaying,
    hasMoreAbove,
    loadingOlder,
    latestTodos,
    recentEdits,
    backgroundBashes,
    toolHistory,
    sessionTitle,
    send,
    enqueue,
    cancelQueued,
    editQueued,
    reorderQueued,
    resolvePermission,
    submitAskAnswer,
    interrupt,
    setPermissionMode,
    setModel,
    setEffort,
    switchSession,
    createNewSession,
    createSessionAt,
    refreshSessions,
    resolvePlan,
    loadOlder,
    jumpToUuid,
    renameTitle,
  };
}

type RawSDKMessage = {
  uuid?: string;
  type?: string;
  parent_tool_use_id?: string | null;
  message?: { id?: string; role?: string; content?: unknown };
  /**
   * ISO timestamp set by the SDK on user-message records in the JSONL.
   * Assistant records don't carry one — their `createdAt` stays undefined
   * on the older-pagination path and the UI hides the chip.
   */
  timestamp?: string;
  /**
   * Envelope flags the SDK writes on transcript-only plumbing messages —
   * `isMeta` (local-command-caveat wrappers around slash runs), and the
   * `isCompactSummary` / `isVisibleInTranscriptOnly` pair the SDK stamps on
   * the synthesized "Session continued from a previous conversation"
   * user-shaped record it emits right after a successful /compact. These
   * aren't in the SDK's TypeScript type but are present on the JSONL
   * envelope; `isSdkInternalEnvelope` reads them and the synthesizeOlder
   * loop skips matching records so paginated history doesn't show two
   * bonus user bubbles the user never typed.
   */
  isMeta?: boolean;
  isCompactSummary?: boolean;
  isVisibleInTranscriptOnly?: boolean;
};

/**
 * Convert a page of raw SDK messages (JSONL records) into DisplayMessages,
 * folding tool_results onto the matching tool_use blocks of prior assistant
 * messages. Subagent traffic (parent_tool_use_id) is dropped here — the older
 * pagination view shows top-level turns only, mirroring the live tail behavior.
 *
 * Multi-content-block model responses arrive as N consecutive JSONL records
 * (one per content block) sharing a `message.id` but differing in wrapper
 * uuid. We merge them into a single bubble keyed by `message.id`, matching
 * the live-stream identity so search hits and pagination heads round-trip
 * cleanly.
 */
function synthesizeOlder(raw: Array<Record<string, unknown>>): {
  messages: DisplayMessage[];
} {
  const out: DisplayMessage[] = [];
  for (const r of raw as RawSDKMessage[]) {
    if (!r || (r.type !== "assistant" && r.type !== "user")) continue;
    if (r.parent_tool_use_id) continue;
    const uuid = typeof r.uuid === "string" ? r.uuid : "";
    if (!uuid) continue;
    // Drop SDK transcript-only plumbing (isMeta caveats, isCompactSummary
    // continuations). Mirrors the live `applyEvent` branch — without this,
    // scrolling past a /compact in the paginated history showed the
    // "Session continued from a previous conversation…" summary AND the
    // <local-command-caveat> wrapper as user-typed bubbles.
    if (isSdkInternalEnvelope(r)) continue;
    const content = r.message?.content;

    if (r.type === "assistant") {
      const msgId = typeof r.message?.id === "string" && r.message.id ? r.message.id : uuid;
      const newBlocks = blocksFromSDKContent(content);
      // Merge into the most recent assistant bubble if it shares this
      // message.id. Intervening tool_results don't push new entries into
      // `out` (they patch in place), so consecutive same-message-id splits
      // remain adjacent even when their tool_results sit between them in
      // the JSONL.
      const last = out[out.length - 1];
      if (last && last.role === "assistant" && last.uuid === msgId) {
        const folded = new Set(last.foldedSdkUuids ?? []);
        if (!folded.has(uuid)) {
          folded.add(uuid);
          const existingToolIds = new Set<string>();
          for (const b of last.blocks) if (b.kind === "tool_use") existingToolIds.add(b.id);
          const toAppend = newBlocks.filter(
            (b) => !(b.kind === "tool_use" && existingToolIds.has(b.id)),
          );
          out[out.length - 1] = {
            ...last,
            blocks: [...last.blocks, ...toAppend],
            foldedSdkUuids: folded,
          };
        }
      } else {
        out.push({
          uuid: msgId,
          role: "assistant",
          blocks: newBlocks,
          streaming: false,
          foldedSdkUuids: new Set([uuid]),
        });
      }
      continue;
    }

    // user — could be plain text input, or a tool_result envelope.
    const tr = extractToolResult(content);
    if (tr) {
      // Walk back through `out` and patch the matching tool_use block.
      for (let i = out.length - 1; i >= 0; i--) {
        const m = out[i];
        if (m.role !== "assistant") continue;
        const idx = m.blocks.findIndex((b) => b.kind === "tool_use" && b.id === tr.tool_use_id);
        if (idx === -1) continue;
        const blk = m.blocks[idx];
        if (blk.kind !== "tool_use") break;
        const patched = { ...blk, result: { content: tr.text, isError: tr.isError } };
        const blocks = m.blocks.slice();
        blocks[idx] = patched;
        out[i] = { ...m, blocks };
        break;
      }
      continue;
    }

    // Skip SDK-injected <task-notification> wrappers on the replay path too —
    // see the live `if (msg.type === "user")` branch for the rationale.
    if (isSyntheticTaskNotification(content)) continue;

    // Content-shape fallback that mirrors the live `applyEvent` branch.
    // On the pagination/disk-replay path the envelope check above already
    // handles these via `isMeta` / `isCompactSummary`, but keeping the same
    // content-shape filters here means a future SDK change that drops the
    // flags on disk too (or a malformed JSONL line) still won't surface
    // these synthesized messages as user bubbles.
    if (isCompactSummaryContent(content)) continue;
    if (isLocalCommandCaveatContent(content)) continue;

    // Mirror the live path's slash-command filters: a `/compact` user-shape
    // message OR the synthetic `<command-name>/compact</command-name>` /
    // `<local-command-stdout>` plumbing the CLI wraps around a slash run
    // would otherwise render as user bubbles when the user scrolls past
    // them in paginated history. The live path lifts each to a small
    // `Ran /X` system pill — synthesizeOlder doesn't produce SystemEntries
    // (its only output channel is DisplayMessage[]), so we drop them
    // silently here. The `compact_boundary` divider already marks the
    // transition for the user; recreating per-record pills on the
    // pagination path would also double-count after a subsequent
    // resyncFromDisk.
    if (isSdkSlashUserMessage(content)) continue;
    if (parseSyntheticCliWrapper(content)) continue;

    // Plain user message — text or array content. The SDK stamps user
    // records in the JSONL with an ISO `timestamp`; parse it so paginated
    // history shows the original send time rather than nothing.
    const parsedTs = typeof r.timestamp === "string" ? Date.parse(r.timestamp) : NaN;
    out.push({
      uuid,
      role: "user",
      blocks: blocksFromSDKContent(content),
      ...(Number.isFinite(parsedTs) ? { createdAt: parsedTs } : {}),
    });
  }
  return { messages: out };
}

/**
 * Fold one SDK split (a single `SDKAssistantMessage`, carrying one content
 * block) into the bubble identified by `messageId`. See the comment on
 * `DisplayMessage.uuid` for why we coalesce by `message.id`.
 *
 * `hasStreamScratch` indicates that `stream_event` partials are driving block
 * assembly for this `message.id`. We used to early-return in that case on the
 * theory that the terminal's content was already represented in scratch — but
 * that assumption breaks when an Anthropic message contains a `server_tool_use`
 * (e.g. the advisor / web_search server tool). The SDK can resume the message
 * after the server tool with content blocks that arrive ONLY as terminal
 * `SDKAssistantMessage` splits — no `content_block_*` partials — so scratch
 * never sees them. The previous early-return then silently dropped every
 * post-server-tool block on the live wire; only a page refresh (which paints
 * from the replay buffer instead) surfaced them.
 *
 * Fix: always run a dedupe-and-append pass. Match `tool_use` by id (as the
 * pre-existing replay path did) and `text` / `thinking` by exact content
 * equality against existing same-kind blocks. Blocks scratch already
 * produced (via `buildMerged`) will match and be skipped; blocks scratch
 * never saw will append.
 */
function upsertAssistantSplit(
  prev: DisplayMessage[],
  messageId: string,
  sdkUuid: string,
  newBlocks: DisplayBlock[],
  hasStreamScratch: boolean,
  parentToolUseId?: string | null,
  /** Server-stamped epoch ms for this SDK envelope (cf. `ServerEvent.sdk.at`). */
  at?: number,
): DisplayMessage[] {
  const idx = prev.findIndex((m) => m.uuid === messageId);
  if (idx === -1) {
    return [
      ...prev,
      {
        uuid: messageId,
        role: "assistant",
        blocks: hasStreamScratch ? [] : newBlocks,
        streaming: true,
        foldedSdkUuids: new Set([sdkUuid]),
        ...(parentToolUseId ? { parentToolUseId } : {}),
        ...(typeof at === "number" ? { createdAt: at } : {}),
      },
    ];
  }
  const existing = prev[idx];
  const folded = existing.foldedSdkUuids ?? new Set<string>();
  if (folded.has(sdkUuid)) {
    // Replay of a split we've already folded — preserve blocks but make sure
    // the streaming flag reflects "still in flight" (SDK reconnect replays
    // the terminal events). The `result` event flips it back to false.
    if (existing.streaming === true) return prev;
    const copy = prev.slice();
    copy[idx] = { ...existing, streaming: true };
    return copy;
  }
  const nextFolded = new Set(folded);
  nextFolded.add(sdkUuid);
  // Dedupe-and-append. See the function-level comment above for why this runs
  // unconditionally (including when scratch is active) — `server_tool_use`
  // can leave scratch blind to post-advisor blocks that arrive only as
  // terminal splits.
  const existingToolIds = new Set<string>();
  const existingTextContents = new Set<string>();
  const existingThinkingContents = new Set<string>();
  for (const b of existing.blocks) {
    if (b.kind === "tool_use") existingToolIds.add(b.id);
    else if (b.kind === "text") existingTextContents.add(b.text);
    else if (b.kind === "thinking") existingThinkingContents.add(b.text);
  }
  const blocksToAppend: DisplayBlock[] = [];
  for (const b of newBlocks) {
    if (b.kind === "tool_use") {
      if (existingToolIds.has(b.id)) continue;
    } else if (b.kind === "text") {
      // Skip empties — scratch may have an empty placeholder slot whose
      // delta hasn't filled yet, and we don't want to duplicate that as
      // an empty bubble appendix. The next buildMerged will paint the
      // real text into the scratch-owned slot anyway.
      if (b.text === "" || existingTextContents.has(b.text)) continue;
    } else if (b.kind === "thinking") {
      if (b.text === "" || existingThinkingContents.has(b.text)) continue;
    }
    blocksToAppend.push(b);
  }
  const copy = prev.slice();
  copy[idx] = {
    ...existing,
    blocks:
      blocksToAppend.length === 0 ? existing.blocks : [...existing.blocks, ...blocksToAppend],
    foldedSdkUuids: nextFolded,
    streaming: true,
  };
  return copy;
}
