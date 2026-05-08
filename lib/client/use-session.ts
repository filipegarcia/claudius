"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import type {
  CreateSessionRequest,
  PermissionDecision,
  PermissionRequestEvent,
  AskUserQuestionEvent,
  AskAnswer,
  ServerEvent,
} from "@/lib/shared/events";
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
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string | Array<{ type: string; text?: string }>;
      is_error?: boolean;
    }
  | { type: string; [k: string]: unknown };

function blocksFromSDKContent(content: unknown): DisplayBlock[] {
  if (typeof content === "string") return [{ kind: "text", text: content }];
  if (!Array.isArray(content)) return [];
  const out: DisplayBlock[] = [];
  for (const raw of content as SDKContentBlock[]) {
    if (raw.type === "text" && typeof raw.text === "string") out.push({ kind: "text", text: raw.text });
    else if (raw.type === "thinking" && typeof raw.thinking === "string")
      out.push({ kind: "thinking", text: raw.thinking });
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
  const [sessions, setSessions] = useState<SessionInfo[]>([]);

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
  const flushQueueRef = useRef<() => void>(() => {});

  // ── sessionStorage persistence ────────────────────────────────────────
  // Queue lives only for the duration of this tab — explicitly NOT
  // localStorage, because a tab close should drop it.
  const queueKey = (sid: string | null) => (sid ? `claudius.queue.${sid}` : null);

  // sessionStorage tops out around 5–10 MB per origin in most browsers.
  // Cap our serialized payload at 5 MB to leave room for everything else.
  const QUEUE_MAX_BYTES = 5 * 1024 * 1024;

  const persistQueue = useCallback((sid: string | null) => {
    if (typeof window === "undefined") return;
    const k = queueKey(sid);
    if (!k) return;
    let trimmedDueToSize = false;
    let serialized = JSON.stringify(queueRef.current);
    if (serialized.length > QUEUE_MAX_BYTES) {
      // Drop oldest items until under the cap. Preserve at least one item if
      // possible — it'd be worse to silently drop everything.
      const items = queueRef.current.slice();
      while (items.length > 1 && JSON.stringify(items).length > QUEUE_MAX_BYTES) {
        items.shift();
      }
      // If even the single tail item is over the cap, bail completely — the
      // user's about to hit a write error anyway and there's nothing to keep.
      if (items.length === 1 && JSON.stringify(items).length > QUEUE_MAX_BYTES) {
        items.length = 0;
      }
      queueRef.current = items;
      setQueue([...items]);
      serialized = JSON.stringify(items);
      trimmedDueToSize = true;
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


  const wipeQueueStorage = useCallback((sid: string | null) => {
    if (typeof window === "undefined") return;
    const k = queueKey(sid);
    if (!k) return;
    try {
      window.sessionStorage.removeItem(k);
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
    wipeQueueStorage(sessionIdRef.current);
    setQueue([]);
    queueRef.current = [];
    setPendingPermission(null);
    pendingPermissionRef.current = null;
    setPendingAsk(null);
    setErrors([]);
    setSlashCommands([]);
    setAgents([]);
    setSkills([]);
    setCwd(null);
    setUsage(null);
    setTasks({});
    setSubagentMessages({});
    setPendingPlan(null);
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
    scratchRef.current.clear();
    lastAssistantUuidRef.current = "";
  }, [wipeQueueStorage]);

  const refreshSessions = useCallback(async () => {
    try {
      const res = await fetch("/api/sessions");
      if (!res.ok) return;
      const data = (await res.json()) as SessionInfo[];
      setSessions(Array.isArray(data) ? data : []);
    } catch {
      // ignore
    }
  }, []);

  const flushQueue = useCallback(async () => {
    const id = sessionIdRef.current;
    if (!id) return;
    // Single-pass: send the head, wait for the SDK to return idle (next call
    // will fire from setPendingTracked(false) when the result comes back).
    // This keeps ordering deterministic and avoids races against the model.
    if (pendingRef.current) return;
    if (pendingPermissionRef.current) return;
    if (queueRef.current.length === 0) return;
    const next = queueRef.current[0];
    writeQueue(queueRef.current.slice(1));
    const uuid = crypto.randomUUID();
    setMessages((prev) => [
      ...prev,
      {
        uuid,
        role: "user",
        blocks: [{ kind: "text", text: next.text }],
        ...(next.images && next.images.length ? { images: next.images } : {}),
      },
    ]);
    setPendingTracked(true);
    let res: Response;
    try {
      res = await fetch(`/api/sessions/${id}/input`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Pass the optimistic uuid through. The server will broadcast a user
        // SDK event with the same id, and applyEvent's per-uuid dedup (line
        // ~721) silently drops the echo for this tab while letting other
        // subscribers see it for the first time.
        body: JSON.stringify({ text: next.text, images: next.images, uuid }),
      });
    } catch (err) {
      // Re-prepend, surface error, leave pending false. User must trigger again.
      writeQueue([next, ...queueRef.current]);
      setErrors((e) => [...e, `send failed: ${err instanceof Error ? err.message : String(err)}`]);
      setPendingTracked(false);
      return;
    }
    if (!res.ok) {
      writeQueue([next, ...queueRef.current]);
      setErrors((e) => [...e, `send failed: ${res.status}`]);
      setPendingTracked(false);
    }
  }, [setPendingTracked, writeQueue]);
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
        setPendingAsk(ev);
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
      if (ev.type === "replay_done") {
        setReplaying(false);
        setHasMoreAbove(ev.hasMoreAbove);
        // The assistant-message handler marks every replayed message as
        // `streaming: true` and flips pending — that's correct for live
        // turns but wrong for historical ones. Reconcile here once the
        // replay window is over.
        setMessages((prev) => prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)));
        setPendingTracked(false);
        return;
      }
      if (ev.type !== "sdk") return;

      const msg = ev.message;

      if (msg.type === "assistant") {
        const beta = msg.message as { content?: unknown };
        const uuid = msg.uuid;
        const parent = (msg as { parent_tool_use_id?: string | null }).parent_tool_use_id ?? null;
        const blocks = blocksFromSDKContent(beta?.content);
        if (parent) {
          // Subagent traffic — keep separate from the main transcript.
          setSubagentMessages((prev) => ({
            ...prev,
            [parent]: upsertMessage(prev[parent] ?? [], {
              uuid,
              role: "assistant",
              blocks,
              streaming: true,
              parentToolUseId: parent,
            }),
          }));
          // Don't override the main lastAssistantUuid — deltas anchor to top-level.
          return;
        }
        lastAssistantUuidRef.current = uuid;
        setMessages((prev) => upsertMessage(prev, { uuid, role: "assistant", blocks, streaming: true }));
        setPendingTracked(true);
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

          // ExitPlanMode tool_use surfaces a plan for the user to accept.
          if (b.name === "ExitPlanMode") {
            const planText =
              typeof (b.input as { plan?: unknown }).plan === "string"
                ? ((b.input as { plan: string }).plan)
                : JSON.stringify(b.input, null, 2);
            setPendingPlan({ toolUseId: b.id, plan: planText, raw: b.input });
            continue;
          }

          // TodoWrite — capture the latest todos snapshot.
          if (b.name === "TodoWrite") {
            const raw = (b.input as { todos?: unknown }).todos;
            if (Array.isArray(raw)) {
              const synth: AgentTodo[] = raw.map((t, i) => {
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
              setLatestTodos(synth);
            }
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
          event: {
            type: string;
            index?: number;
            content_block?: SDKContentBlock;
            delta?: { type: string; text?: string; thinking?: string; partial_json?: string };
          };
        };
        const evt = sm.event;
        const anchor = lastAssistantUuidRef.current;
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
          else if (cb.type === "thinking")
            scratch.blocks.set(evt.index, { kind: "thinking", text: typeof cb.thinking === "string" ? cb.thinking : "" });
          else if (cb.type === "tool_use") {
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
        } else if (evt.type === "message_stop") {
          setMessages((prev) => prev.map((m) => (m.uuid === anchor ? { ...m, streaming: false } : m)));
          return;
        } else {
          return;
        }
        setMessages((prev) =>
          prev.map((m) => {
            if (m.uuid !== anchor) return m;
            const merged: DisplayBlock[] = [];
            const indices = [...scratch!.blocks.keys()].sort((a, b) => a - b);
            for (const i of indices) {
              const slot = scratch!.blocks.get(i)!;
              if (slot.kind === "text") merged.push({ kind: "text", text: slot.text ?? "" });
              else if (slot.kind === "thinking") merged.push({ kind: "thinking", text: slot.text ?? "" });
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
            const preservedResults = new Map<string, { content: string; isError?: boolean }>();
            for (const b of m.blocks) {
              if (b.kind === "tool_use" && b.result) preservedResults.set(b.id, b.result);
            }
            for (const b of merged) {
              if (b.kind === "tool_use" && preservedResults.has(b.id)) b.result = preservedResults.get(b.id);
            }
            return { ...m, blocks: merged };
          }),
        );
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
                [parent]: [...list, { uuid, role: "user", blocks: [{ kind: "text", text }], parentToolUseId: parent }],
              };
            });
          }
          return;
        }
        // Surface user messages from a resumed transcript so the chat shows history.
        if (!isSynthetic && inner) {
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
            setMessages((prev) => {
              if (prev.some((m) => m.uuid === uuid)) return prev;
              return [...prev, { uuid, role: "user", blocks: [{ kind: "text", text }] }];
            });
          }
        }
        return;
      }

      if (msg.type === "result") {
        setPendingTracked(false);
        const anchor = lastAssistantUuidRef.current;
        if (anchor) setMessages((prev) => prev.map((m) => (m.uuid === anchor ? { ...m, streaming: false } : m)));
        const r = msg as {
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
        if (r.subtype === "success") {
          setUsage((prev) => {
            const u: SessionUsage = {
              totalCostUsd: (prev?.totalCostUsd ?? 0) + (r.total_cost_usd ?? 0),
              numTurns: (prev?.numTurns ?? 0) + (r.num_turns ?? 0),
              durationMs: (prev?.durationMs ?? 0) + (r.duration_ms ?? 0),
              durationApiMs: (prev?.durationApiMs ?? 0) + (r.duration_api_ms ?? 0),
              inputTokens: (prev?.inputTokens ?? 0) + (r.usage?.input_tokens ?? 0),
              outputTokens: (prev?.outputTokens ?? 0) + (r.usage?.output_tokens ?? 0),
              cacheReadInputTokens:
                (prev?.cacheReadInputTokens ?? 0) + (r.usage?.cache_read_input_tokens ?? 0),
              cacheCreationInputTokens:
                (prev?.cacheCreationInputTokens ?? 0) + (r.usage?.cache_creation_input_tokens ?? 0),
              modelUsage: r.modelUsage ?? prev?.modelUsage,
            };
            return u;
          });
        }
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
    [flushQueue, setPendingTracked],
  );

  const bindToSession = useCallback(
    (id: string) => {
      eventSourceRef.current?.close();
      sessionIdRef.current = id;
      setSessionId(id);
      rehydrateQueue(id);
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
      }
      const es = new EventSource(`/api/sessions/${id}/stream?tail=20`);
      eventSourceRef.current = es;
      es.onmessage = (msg) => {
        try {
          const ev = JSON.parse(msg.data) as ServerEvent;
          applyEvent(ev);
        } catch (err) {
          console.error("bad SSE payload", err, msg.data);
        }
      };
      es.onerror = () => {};
    },
    [applyEvent, rehydrateQueue],
  );

  const switchSession = useCallback(
    (id: string) => {
      if (sessionIdRef.current === id) return;
      resetState();
      bindToSession(id);
      void refreshSessions();
    },
    [bindToSession, resetState, refreshSessions],
  );

  const createSession = useCallback(
    async (opts: CreateSessionRequest = {}): Promise<string | null> => {
      try {
        const res = await fetch("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(opts),
        });
        if (!res.ok) throw new Error(`create session failed: ${res.status}`);
        const { id } = (await res.json()) as { id: string };
        resetState();
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
    // ?new=1 forces creating a fresh session, even if ?session= is present.
    // The Chat side-nav button uses this to mean "give me a new conversation."
    const forceNew = params.get("new") === "1";
    const resume = forceNew ? undefined : params.get("session") || undefined;
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
    ) => {
      const id = sessionIdRef.current;
      const trimmedText = text.trim();
      const hasImages = Array.isArray(images) && images.length > 0;
      if (!id || (!trimmedText && !hasImages)) return;
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
        };
        writeQueue([...queueRef.current, q]);
        return;
      }
      const uuid = crypto.randomUUID();
      setMessages((prev) => [
        ...prev,
        {
          uuid,
          role: "user",
          blocks: [{ kind: "text", text }],
          ...(normalized ? { images: normalized } : {}),
        },
      ]);
      setPromptSuggestions([]);
      setPendingTracked(true);
      setErrors([]);
      const res = await fetch(`/api/sessions/${id}/input`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Pass the optimistic uuid so the server's broadcast echoes it back
        // with the same id; applyEvent dedups by uuid so this tab doesn't
        // double-render, while other subscribers pick it up for the first
        // time on SSE replay.
        body: JSON.stringify({ text, images: normalized, uuid }),
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

  const dismissPlan = useCallback(() => setPendingPlan(null), []);

  const loadOlder = useCallback(async () => {
    const id = sessionIdRef.current;
    if (!id) return;
    if (!hasMoreAbove) return;
    if (loadingOlder) return;
    setLoadingOlder(true);
    try {
      const head = messagesRef.current[0]?.uuid;
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
   * Make sure a given message uuid is in `messages` state, paginating older
   * pages as needed. Returns true if the message ended up loaded, false if
   * the head of the transcript was reached without a match. Used by
   * transcript-search results to "jump to" a hit.
   */
  const jumpToUuid = useCallback(
    async (uuid: string): Promise<boolean> => {
      if (messagesRef.current.some((m) => m.uuid === uuid)) return true;
      // Cap iterations defensively — transcripts above ~10k messages are
      // pathological enough that we'd rather give up than spin.
      for (let i = 0; i < 200; i++) {
        if (!hasMoreAboveRef.current) break;
        await loadOlder();
        if (messagesRef.current.some((m) => m.uuid === uuid)) return true;
      }
      return messagesRef.current.some((m) => m.uuid === uuid);
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
    switchSession,
    createNewSession,
    createSessionAt,
    refreshSessions,
    dismissPlan,
    loadOlder,
    jumpToUuid,
    renameTitle,
  };
}

type RawSDKMessage = {
  uuid?: string;
  type?: string;
  parent_tool_use_id?: string | null;
  message?: { role?: string; content?: unknown };
};

/**
 * Convert a page of raw SDK messages (JSONL records) into DisplayMessages,
 * folding tool_results onto the matching tool_use blocks of prior assistant
 * messages. Subagent traffic (parent_tool_use_id) is dropped here — the older
 * pagination view shows top-level turns only, mirroring the live tail behavior.
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
    const content = r.message?.content;

    if (r.type === "assistant") {
      out.push({
        uuid,
        role: "assistant",
        blocks: blocksFromSDKContent(content),
        streaming: false,
      });
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

    // Plain user message — text or array content.
    out.push({
      uuid,
      role: "user",
      blocks: blocksFromSDKContent(content),
    });
  }
  return { messages: out };
}

function upsertMessage(prev: DisplayMessage[], next: DisplayMessage): DisplayMessage[] {
  const idx = prev.findIndex((m) => m.uuid === next.uuid);
  if (idx === -1) return [...prev, next];
  const copy = prev.slice();
  copy[idx] = { ...copy[idx], ...next };
  return copy;
}
