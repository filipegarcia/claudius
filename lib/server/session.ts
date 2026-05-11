import { randomUUID } from "node:crypto";
import { watch as watchFs, type FSWatcher } from "node:fs";
import {
  getSessionInfo,
  getSessionMessages,
  query,
  renameSession,
  type CanUseTool,
  type Options,
  type PermissionMode,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { projectRoot } from "./db";
import { AsyncQueue } from "./async-queue";
import { notificationBus } from "./notification-bus";
import {
  getSessionTitle,
  setSessionTitle,
  touchSession,
  upsertSession,
} from "./sessions-db";
import type {
  AskAnswer,
  AskQuestion,
  AskQuestionOption,
  PermissionDecision,
  PermissionRequestEvent,
  PlanDecision,
  ServerEvent,
} from "@/lib/shared/events";

type Subscriber = (event: ServerEvent) => void;

type PendingPermission = {
  requestId: string;
  resolve: (result: PermissionResult) => void;
  meta: PermissionRequestEvent;
};

type PendingAskQuestion = {
  requestId: string;
  toolUseId: string;
  questions: AskQuestion[];
  resolve: (result: PermissionResult) => void;
};

type PendingPlan = {
  requestId: string;
  toolUseId: string;
  plan: string;
  raw?: Record<string, unknown>;
  resolve: (result: PermissionResult) => void;
};

/**
 * Decide which slice of an event buffer to replay on attach.
 *
 * The naive "keep the last N top-level turns" sliding window has a known
 * failure mode in Claude Code sessions: a single user prompt can be
 * followed by 30+ assistant turns (one per tool round-trip), so `tail=20`
 * ends up showing only the bottom of an assistant chain with no visible
 * context for what was asked. After picking the naive start by turn count
 * we extend the window upward (smaller index) to always include the most
 * recent top-level USER turn. The 1000-event buffer cap upstream bounds
 * the worst-case replay size; in practice this adds at most a few dozen
 * events for the long-tool-chain case.
 *
 * Exported for unit testing — the slicing is pure and worth pinning down
 * separately from the Session lifecycle.
 *
 * @param buffer  Session events in chronological order.
 * @param tail    Conversation-turn budget (counts only top-level,
 *                non-subagent user/assistant SDK messages). `undefined`
 *                or `<= 0` means "replay everything".
 * @returns       `{ startIdx, hasMoreAbove }` — caller slices
 *                `buffer.slice(startIdx)` and forwards `hasMoreAbove` on
 *                the trailing `replay_done` so the client knows whether
 *                to show the "load older" affordance.
 */
export function computeReplayWindow(
  buffer: ReadonlyArray<ServerEvent>,
  tail: number | undefined,
): { startIdx: number; hasMoreAbove: boolean } {
  if (typeof tail !== "number" || tail <= 0) {
    return { startIdx: 0, hasMoreAbove: false };
  }
  const turnIdx: number[] = [];
  let lastUserTurnIdx = -1;
  for (let i = 0; i < buffer.length; i++) {
    const ev = buffer[i];
    if (ev.type !== "sdk") continue;
    const m = ev.message as {
      type?: string;
      parent_tool_use_id?: string | null;
      message?: { content?: unknown };
    };
    if (m.type !== "assistant" && m.type !== "user") continue;
    if (m.parent_tool_use_id) continue;
    turnIdx.push(i);
    // Only count REAL user prompts as user-turn anchors. Tool round-trips
    // in Claude Code emit a `user`-role SDK message whose content is a
    // `tool_result` block — those are bookkeeping, not user input, and
    // there are typically dozens of them between real prompts. If we
    // anchored on those we'd pin on the most recent tool result (already
    // inside the default tail) and the actual prompt would still get
    // dropped off the top — exactly the bug we're fixing here.
    if (m.type === "user" && isRealUserPrompt(m.message?.content)) {
      lastUserTurnIdx = i;
    }
  }
  const skip = Math.max(0, turnIdx.length - tail);
  if (skip === 0) {
    return { startIdx: 0, hasMoreAbove: false };
  }
  let startIdx = turnIdx[skip];
  // Anchor on the most recent user turn even when it sits before the
  // naive tail window — refresh/reattach on long sessions should land
  // with what was asked still in view, not at the bottom of a tool spew.
  if (lastUserTurnIdx >= 0 && lastUserTurnIdx < startIdx) {
    startIdx = lastUserTurnIdx;
  }
  return { startIdx, hasMoreAbove: startIdx > 0 };
}

/**
 * Distinguish a real user prompt from an SDK-synthetic tool_result wrapper.
 * Real prompts have either a string content or an array containing at
 * least one text/image block; synthetic wrappers are pure tool_result
 * arrays. Exported alongside `computeReplayWindow` because the same
 * distinction shows up in any "find the last actual user message"
 * code path (and the client-side `extractToolResult` mirrors this).
 */
function isRealUserPrompt(content: unknown): boolean {
  if (typeof content === "string") return content.length > 0;
  if (!Array.isArray(content)) return false;
  for (const block of content) {
    const t = (block as { type?: string } | null)?.type;
    if (t === "text" || t === "image") return true;
  }
  return false;
}

export class Session {
  readonly id: string;
  readonly cwd: string;
  readonly model?: string;
  readonly resumeFrom?: string;
  readonly resumeAt?: string;
  /**
   * Human-readable display title. Sourced from the SDK's persisted session
   * metadata (`customTitle` first, falling back to `summary`). Updated when
   * the user renames the session via the chat header.
   */
  title?: string;
  private permissionMode: PermissionMode;

  private inputQueue = new AsyncQueue<SDKUserMessage>();
  private query: Query | null = null;
  private abortController = new AbortController();

  private buffer: ServerEvent[] = [];
  private subscribers = new Set<Subscriber>();
  private subscriberCountListeners = new Set<(count: number) => void>();
  private pendingPermissions = new Map<string, PendingPermission>();
  private pendingAskQuestions = new Map<string, PendingAskQuestion>();
  private pendingPlans = new Map<string, PendingPlan>();
  private done = false;
  // True between the user pushing input and the SDK emitting the matching
  // `result` event. Surfaced via `getStatus()` so the SessionTabs strip can
  // paint a "running" dot on non-active tabs whose live SSE isn't bound to
  // this client — without it the inactive tabs are forever "background".
  private turnInFlight = false;
  // Last `turn_status` value broadcast over SSE. `broadcastTurnStatusIfChanged`
  // compares `getStatus()` against this and emits only on transitions so we
  // don't flood the wire with redundant events (every pending-map mutation
  // calls into the helper).
  private lastBroadcastStatus: "running" | "idle" | null = null;
  // Watches `~/.claude/projects/<encoded-cwd>/` for changes to this
  // session's JSONL so external writers (`claude --resume <id>` in the
  // terminal) trigger a live resync instead of waiting for a refresh.
  private jsonlWatcher: FSWatcher | null = null;
  private jsonlResyncTimer: ReturnType<typeof setTimeout> | null = null;
  // Set to true while resyncFromDisk is in flight, so a watch event that
  // arrives during the sync doesn't stack up redundant work.
  private jsonlResyncBusy = false;

  constructor(opts: {
    id?: string;
    cwd?: string;
    model?: string;
    permissionMode?: PermissionMode;
    resume?: string;
    resumeSessionAt?: string;
  }) {
    // When resuming, the server-side Session.id MUST equal the SDK's session
    // id (the resumed conversation's id) — otherwise user messages we push
    // through the input queue carry a `session_id` that the SDK doesn't
    // recognize, and it errors with "No conversation found with session ID".
    this.id = opts.id ?? opts.resume ?? randomUUID();
    this.cwd = opts.cwd ?? process.cwd();
    this.model = opts.model;
    this.permissionMode = opts.permissionMode ?? "default";
    this.resumeFrom = opts.resume;
    this.resumeAt = opts.resumeSessionAt;
  }

  async start(): Promise<void> {
    if (this.query) return;

    // The SDK's `resume` option loads the conversation into the model's
    // context but does NOT re-emit historical events to our consumer
    // iterable. Read them from disk via `getSessionMessages` and broadcast
    // each into our buffer so SSE subscribers replay the full transcript.
    if (this.resumeFrom) {
      try {
        const historical = await getSessionMessages(this.resumeFrom, {
          dir: this.cwd,
          includeSystemMessages: true,
        });
        for (const m of historical) {
          this.broadcast({ type: "sdk", message: m as unknown as SDKMessage });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.broadcast({ type: "error", message: `Failed to load session history: ${message}` });
      }
      // Pull the persisted title. Our index is authoritative because it
      // works even for sessions that haven't completed a turn yet (the
      // SDK's customTitle requires a JSONL on disk). Fall back to the SDK's
      // metadata if we have nothing locally — this picks up titles authored
      // in another client (e.g. the TUI's `/rename`).
      try {
        const local = await getSessionTitle(this.cwd, this.resumeFrom);
        if (local) {
          this.title = local;
        } else {
          const info = await getSessionInfo(this.resumeFrom, { dir: this.cwd });
          const t = info?.customTitle ?? info?.summary;
          if (t) this.title = t;
        }
      } catch {
        // non-fatal — header just shows the prefix fallback
      }
    } else {
      // Even for fresh (non-resume) sessions, check our index in case
      // the user renamed this session id in a previous boot of Claudius.
      try {
        const local = await getSessionTitle(this.cwd, this.id);
        if (local) this.title = local;
      } catch {
        // ignore
      }
    }

    // Upsert into the per-project sessions index so the row exists from
    // the moment the session is bound, regardless of whether the SDK has
    // written a JSONL yet.
    try {
      await upsertSession({
        id: this.id,
        cwd: this.cwd,
        model: this.model,
        title: this.title,
      });
    } catch {
      // non-fatal — index is for listing; the session still works without it
    }

    const options: Options = {
      cwd: this.cwd,
      model: this.model,
      permissionMode: this.permissionMode,
      abortController: this.abortController,
      canUseTool: this.canUseTool,
      includePartialMessages: true,
      // Opt into adaptive extended thinking explicitly so the agent
      // emits the full reasoning text in `thinking` blocks. Without
      // this, recent SDK builds default to a `display: 'omitted'`
      // shape on short turns and the chat surface renders empty
      // Thinking blocks. Leaving `display` unset means "full text"
      // (the alternatives — 'summarized' / 'omitted' — both hide it).
      thinking: { type: "adaptive" },
      // Tell the model to emit HTML (not markdown) in option `preview` fields,
      // so the AskUserQuestion modal can render rich previews (mockups, code
      // snippets, configuration examples) directly in the browser. Default
      // is markdown, which the CLI shows in a monospace box.
      toolConfig: {
        askUserQuestion: { previewFormat: "html" },
      },
      // Pin the session id so the SDK names its on-disk JSONL with our id.
      // This makes Claudius web ids match the TUI: `claude --resume <id>`
      // resolves the same conversation. The SDK forbids `sessionId` together
      // with `resume` (it'd be ambiguous), so only set it for new sessions.
      ...(this.resumeFrom ? { resume: this.resumeFrom } : { sessionId: this.id }),
      ...(this.resumeAt ? { resumeSessionAt: this.resumeAt } : {}),
    };
    this.query = query({ prompt: this.inputQueue, options });
    this.broadcast({ type: "ready", sessionId: this.id });
    if (this.title) this.broadcast({ type: "session_title", title: this.title });
    void this.consume();
    // Start watching the on-disk JSONL so external writers (CLI `claude
    // --resume <id>`) trigger a resync that broadcasts new turns to all
    // open browser tabs without a manual refresh.
    this.startJsonlWatcher();
  }

  private startJsonlWatcher(): void {
    if (this.jsonlWatcher) return;
    const dir = projectRoot(this.cwd);
    const target = `${this.id}.jsonl`;
    try {
      // Watch the parent directory rather than the file directly: the file
      // may not exist yet for a brand-new session, and atomic-rename writes
      // (some editors do this) replace the inode, breaking a file-level
      // watch. Filtering by filename in the listener gives us a reliable
      // signal regardless.
      this.jsonlWatcher = watchFs(dir, { persistent: false }, (_event, filename) => {
        if (filename !== target) return;
        this.scheduleJsonlResync();
      });
      this.jsonlWatcher.on("error", () => {
        // Best-effort — losing the watcher just means we're back to
        // refresh-driven resync. Don't crash the session.
        this.stopJsonlWatcher();
      });
    } catch {
      // Directory might not exist on first-ever boot; the SDK creates it
      // when it writes the session JSONL. The next subscribe() call still
      // does a best-effort resyncFromDisk, so we're not stuck.
    }
  }

  private stopJsonlWatcher(): void {
    if (this.jsonlResyncTimer) {
      clearTimeout(this.jsonlResyncTimer);
      this.jsonlResyncTimer = null;
    }
    if (this.jsonlWatcher) {
      try {
        this.jsonlWatcher.close();
      } catch {
        // ignore
      }
      this.jsonlWatcher = null;
    }
  }

  private scheduleJsonlResync(): void {
    // Coalesce bursty filesystem events. The SDK writes one JSONL line per
    // SDK message; a single user prompt produces several events back to
    // back. 200ms is comfortably below human-noticeable latency and well
    // above the OS event burst window.
    if (this.jsonlResyncTimer) clearTimeout(this.jsonlResyncTimer);
    this.jsonlResyncTimer = setTimeout(() => {
      this.jsonlResyncTimer = null;
      if (this.jsonlResyncBusy) {
        // Another sync is already running — re-arm so we pick up anything
        // that lands after it finishes.
        this.scheduleJsonlResync();
        return;
      }
      void this.resyncFromDisk();
    }, 200);
  }

  async rename(title: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const trimmed = title.trim();
    if (!trimmed) return { ok: false, error: "title required" };
    // The sessions index is authoritative — it works regardless of whether
    // the SDK's JSONL exists yet. If this throws we fail the whole
    // operation; the user sees the error and the title doesn't change.
    // Best-effort mirror to the SDK so external clients (the CLI's
    // `/rename`, other tooling) see it too.
    try {
      await setSessionTitle(this.cwd, this.id, trimmed);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    try {
      await renameSession(this.id, trimmed, { dir: this.cwd });
    } catch {
      // Non-fatal. The most common reason this fails is "no JSONL yet" for a
      // fresh session that hasn't completed a turn — once the SDK persists
      // the first turn, our local title remains the source of truth and a
      // future boot of any client reading both will see them in agreement.
    }
    this.title = trimmed;
    this.broadcast({ type: "session_title", title: trimmed });
    return { ok: true };
  }

  private canUseTool: CanUseTool = (toolName, input, ctx) => {
    return new Promise<PermissionResult>((resolve) => {
      const requestId = randomUUID();

      // ── ExitPlanMode is the model's "ready to execute" signal ─────────
      // Don't show the generic Allow/Deny card — surface the plan in our own
      // overlay so the user can read it and decide. Accepting flips the
      // session out of plan mode (handled in resolvePlan); rejecting sends
      // a deny message back so the model can iterate.
      if (toolName === "ExitPlanMode") {
        const planText =
          typeof (input as { plan?: unknown }).plan === "string"
            ? ((input as { plan: string }).plan)
            : JSON.stringify(input, null, 2);
        const pending: PendingPlan = {
          requestId,
          toolUseId: ctx.toolUseID,
          plan: planText,
          raw: input as Record<string, unknown>,
          resolve,
        };
        this.pendingPlans.set(requestId, pending);
        this.broadcast({
          type: "plan_approval_request",
          requestId,
          toolUseId: ctx.toolUseID,
          plan: planText,
          raw: input as Record<string, unknown>,
        });
        this.broadcastTurnStatusIfChanged();
        ctx.signal.addEventListener("abort", () => {
          const p = this.pendingPlans.get(requestId);
          if (!p) return;
          this.pendingPlans.delete(requestId);
          p.resolve({ behavior: "deny", message: "Aborted" });
          this.broadcastTurnStatusIfChanged();
        });
        return;
      }

      // ── AskUserQuestion is the model's interactive form ────────────────
      // Don't render the standard "Allow / Deny" permission card for it —
      // unpack the `questions` array and emit our own SSE event so the
      // browser shows the form. The user's selections come back via
      // submitAskAnswer(), which resolves this same promise with
      // updatedInput.answers — that's the shape the SDK feeds the model as
      // the tool's effective output.
      if (toolName === "AskUserQuestion") {
        const questions = parseQuestions(input);
        if (questions.length > 0) {
          const pending: PendingAskQuestion = {
            requestId,
            toolUseId: ctx.toolUseID,
            questions,
            resolve,
          };
          this.pendingAskQuestions.set(requestId, pending);
          this.broadcast({
            type: "ask_user_question",
            requestId,
            toolUseId: ctx.toolUseID,
            questions,
          });
          this.broadcastTurnStatusIfChanged();

          ctx.signal.addEventListener("abort", () => {
            const p = this.pendingAskQuestions.get(requestId);
            if (!p) return;
            this.pendingAskQuestions.delete(requestId);
            p.resolve({ behavior: "deny", message: "Aborted" });
            this.broadcastTurnStatusIfChanged();
          });
          return;
        }
        // Malformed input — fall through to the standard permission flow so
        // the user at least sees something, instead of silently hanging.
      }

      const meta: PermissionRequestEvent = {
        type: "permission_request",
        requestId,
        toolName,
        toolUseId: ctx.toolUseID,
        input,
        title: ctx.title,
        description: ctx.description,
        displayName: ctx.displayName,
      };
      this.pendingPermissions.set(requestId, { requestId, resolve, meta });
      this.broadcast(meta);
      this.broadcastTurnStatusIfChanged();

      ctx.signal.addEventListener("abort", () => {
        const pending = this.pendingPermissions.get(requestId);
        if (!pending) return;
        this.pendingPermissions.delete(requestId);
        pending.resolve({ behavior: "deny", message: "Aborted" });
        this.broadcastTurnStatusIfChanged();
      });
    });
  };

  resolvePermission(requestId: string, decision: PermissionDecision): boolean {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return false;
    this.pendingPermissions.delete(requestId);
    // The request is now resolved — clear the matching inbox row so the user
    // doesn't keep seeing "Claude needs permission" after they've answered.
    void notificationBus.markReadByRequestId(this.cwd, requestId);

    if (decision.kind === "deny") {
      pending.resolve({ behavior: "deny", message: decision.message ?? "User denied" });
      return true;
    }

    // The SDK's PermissionResult schema requires `updatedInput` to be a record
    // on every "allow" — it represents the (possibly-mutated) tool args that
    // will run. We don't mutate args here, so just echo the original input
    // captured when the prompt was raised. Without this the SDK rejects the
    // response with a Zod error ("expected record, received undefined") and
    // the tool call loops until the session aborts.
    const inputRecord =
      pending.meta.input && typeof pending.meta.input === "object" && !Array.isArray(pending.meta.input)
        ? (pending.meta.input as Record<string, unknown>)
        : {};
    const result: PermissionResult = { behavior: "allow", updatedInput: inputRecord };
    if (decision.kind === "allow_always_session") {
      result.updatedPermissions = [
        {
          type: "addRules",
          behavior: "allow",
          rules: [{ toolName: pending.meta.toolName }],
          destination: "session",
        },
      ];
    } else if (decision.kind === "allow_always_save") {
      result.updatedPermissions = [
        {
          type: "addRules",
          behavior: "allow",
          rules: [{ toolName: pending.meta.toolName }],
          destination: decision.destination,
        },
      ];
    }
    pending.resolve(result);
    this.broadcastTurnStatusIfChanged();
    return true;
  }

  /**
   * Resolve a pending AskUserQuestion form. The SDK's `AskUserQuestionOutput`
   * (sdk-tools.d.ts) is shaped as `{ questions, answers, annotations? }`
   * where `answers` is a MAP keyed by question text → string (multi-select
   * values are comma-separated). The original `questions` array must be
   * preserved on `updatedInput`, otherwise the SDK's post-processing
   * (it `.map`s over `input.questions` to format the result) crashes with
   * "undefined is not an object (evaluating 'H.map')".
   *
   * If the user submits no answers (the cancel path), we deny instead of
   * allow — that's a cleaner signal to the model than empty strings.
   */
  submitAskAnswer(requestId: string, answers: AskAnswer[]): boolean {
    const pending = this.pendingAskQuestions.get(requestId);
    if (!pending) return false;
    this.pendingAskQuestions.delete(requestId);
    // Mirror resolvePermission: clear the matching inbox row so an answered
    // question stops showing as unread.
    void notificationBus.markReadByRequestId(this.cwd, requestId);

    const hasAnyContent = answers.some((a) => {
      if (!a) return false;
      if (typeof a.label === "string" && a.label) return true;
      if (Array.isArray(a.selected) && a.selected.length > 0) return true;
      if (typeof a.custom === "string" && a.custom.trim()) return true;
      return false;
    });
    if (answers.length === 0 || !hasAnyContent) {
      pending.resolve({ behavior: "deny", message: "User cancelled the question" });
      this.broadcastTurnStatusIfChanged();
      return true;
    }

    // Build the answers map keyed by question text. For multi-select, the
    // SDK expects values comma-separated. "Other" free text gets joined too
    // when it accompanies a multi-select; otherwise it replaces the label.
    const answersMap: Record<string, string> = {};
    const annotations: Record<string, { preview?: string; notes?: string }> = {};
    for (let i = 0; i < pending.questions.length; i++) {
      const q = pending.questions[i];
      const a = answers[i] ?? {};
      let value = "";
      if (q.multiSelect) {
        const labels = Array.isArray(a.selected) ? a.selected : [];
        const all = a.custom && a.custom.trim() ? [...labels, a.custom.trim()] : labels;
        value = all.join(", ");
      } else if (a.custom && a.custom.trim()) {
        value = a.custom.trim();
      } else if (typeof a.label === "string" && a.label) {
        value = a.label;
      }
      answersMap[q.question] = value;
      // If we know the preview for the chosen option, attach it as the
      // annotation — gives the model the same context the user saw.
      const chosen = q.options.find((o) => o.label === a.label);
      if (chosen?.preview) {
        annotations[q.question] = { preview: chosen.preview };
      }
    }

    pending.resolve({
      behavior: "allow",
      updatedInput: {
        questions: pending.questions,
        answers: answersMap,
        ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
      },
    });
    this.broadcastTurnStatusIfChanged();
    return true;
  }

  /**
   * Resolve a pending ExitPlanMode prompt. Accepting also flips the session
   * out of plan mode into `acceptEdits` so the agent can actually execute the
   * plan it just laid out — that's the whole point of the exit. Rejecting
   * keeps plan mode and forwards the user's feedback as the deny message,
   * letting the model iterate.
   */
  async resolvePlan(requestId: string, decision: PlanDecision): Promise<boolean> {
    const pending = this.pendingPlans.get(requestId);
    if (!pending) return false;
    this.pendingPlans.delete(requestId);
    // Mirror resolvePermission: clear the matching inbox row so a resolved
    // plan-approval request stops showing as unread.
    void notificationBus.markReadByRequestId(this.cwd, requestId);

    if (decision.kind === "reject") {
      pending.resolve({
        behavior: "deny",
        message: decision.message ?? "User rejected the plan — keep iterating.",
      });
      this.broadcastTurnStatusIfChanged();
      return true;
    }

    // Hand the mode transition to the SDK via `updatedPermissions` instead
    // of pre-flipping with `query.setPermissionMode()`. The SDK's
    // ExitPlanMode tool checks its own pre-plan-mode state when it runs,
    // and a race-y external flip makes the tool emit `is_error: true`
    // ("ExitPlanMode never reached" / "gate is off"), which surfaced as a
    // red ⚠ icon on the activity rail even though the user had accepted
    // the plan. Returning the setMode as part of the allow lets the SDK
    // perform the transition atomically and the tool returns success.
    this.permissionMode = "acceptEdits";
    const result: PermissionResult = {
      behavior: "allow",
      updatedPermissions: [
        { type: "setMode", mode: "acceptEdits", destination: "session" },
      ],
    };
    // If the user hand-edited the plan in the overlay, ship their version
    // as the tool's effective input. The SDK feeds this to ExitPlanMode
    // which writes the file + records it in the tool_result, so the next
    // model turn references the edited plan rather than the original draft.
    // Preserve any other fields the model passed (e.g. `allowedPrompts`).
    const editedPlan = decision.editedPlan?.trim();
    if (editedPlan && editedPlan !== pending.plan.trim()) {
      result.updatedInput = { ...(pending.raw ?? {}), plan: editedPlan };
    }
    pending.resolve(result);
    // The SDK doesn't echo `setMode` permission updates back through its
    // message iterator — broadcast manually so the client UI's mode badge
    // (plan → acceptEdits) follows along immediately.
    this.broadcast({ type: "mode_changed", mode: "acceptEdits" });
    this.broadcastTurnStatusIfChanged();
    return true;
  }

  sendInput(
    text: string,
    images?: Array<{ data: string; mediaType: string; ordinal?: number }>,
    opts?: { uuid?: string },
  ): void {
    if (this.done) return;
    type ContentBlock =
      | { type: "text"; text: string }
      | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

    // Pin a uuid for this user turn. The SDK's iterator never echoes user
    // input back to consume(), so without surfacing it ourselves the in-memory
    // buffer would carry only assistant/result events — and any new SSE
    // subscriber (a reloaded tab, a second tab on the same session) would see
    // assistant replies floating with no preceding human message. We mint
    // here, broadcast into the buffer, and forward the same id into the
    // inputQueue so the SDK writes it to the JSONL — keeping the disk uuid
    // and the buffer uuid aligned for `loadOlder`'s `?before=<uuid>` cursor.
    // The SDK types `uuid` as a template-literal UUID. `randomUUID()` already
    // returns that branded type; a caller-supplied string needs to be widened
    // to it via cast (we trust the client to send a real uuid — worst case
    // is an inert dedup key, not a security issue).
    const uuid = (opts?.uuid ?? randomUUID()) as ReturnType<typeof randomUUID>;

    // Stamp the bus so the next `result` after this turn counts as "idle"
    // (i.e. crossed the IDLE_NOTIFY_MIN_MS threshold). Without this the
    // bus suppresses idle notifications because it never saw a user-input
    // signal for the session.
    notificationBus.markUserInput(this.id);
    this.turnInFlight = true;
    this.broadcastTurnStatusIfChanged();

    if (!images || images.length === 0) {
      const message = { role: "user" as const, content: text };
      this.broadcast({
        type: "sdk",
        message: {
          type: "user",
          message,
          parent_tool_use_id: null,
          session_id: this.id,
          uuid,
        } as unknown as SDKMessage,
      });
      this.inputQueue.push({
        type: "user",
        message,
        parent_tool_use_id: null,
        session_id: this.id,
        uuid,
      });
      return;
    }

    const byOrdinal = new Map<number, { data: string; mediaType: string }>();
    for (const img of images) {
      if (typeof img.ordinal === "number") {
        byOrdinal.set(img.ordinal, { data: img.data, mediaType: img.mediaType });
      }
    }

    const content: ContentBlock[] = [];
    const tokenRe = /\[Image #(\d+)\]/g;
    let cursor = 0;
    let m: RegExpExecArray | null;
    while ((m = tokenRe.exec(text))) {
      const ord = Number(m[1]);
      const img = byOrdinal.get(ord);
      if (!img) continue; // leave unknown tokens as literal text — fall through
      const before = text.slice(cursor, m.index);
      if (before) content.push({ type: "text", text: before });
      content.push({
        type: "image",
        source: { type: "base64", media_type: img.mediaType, data: img.data },
      });
      // Mark this ordinal consumed so a duplicate token in the text doesn't
      // try to inline the same image twice.
      byOrdinal.delete(ord);
      cursor = m.index + m[0].length;
    }
    const tail = text.slice(cursor);
    if (tail) content.push({ type: "text", text: tail });

    // Any images that didn't have a token in the text — append at the end so
    // they aren't silently dropped (mirrors current behavior for ordinal-less
    // legacy callers).
    for (const img of images) {
      if (typeof img.ordinal !== "number") {
        content.push({
          type: "image",
          source: { type: "base64", media_type: img.mediaType, data: img.data },
        });
      }
    }

    const message = { role: "user" as const, content: content as unknown as string };
    this.broadcast({
      type: "sdk",
      message: {
        type: "user",
        message,
        parent_tool_use_id: null,
        session_id: this.id,
        uuid,
      } as unknown as SDKMessage,
    });
    this.inputQueue.push({
      type: "user",
      message,
      parent_tool_use_id: null,
      session_id: this.id,
      uuid,
    });
  }

  async interrupt(): Promise<void> {
    if (this.query) await this.query.interrupt().catch(() => {});
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.permissionMode = mode;
    if (this.query) await this.query.setPermissionMode(mode).catch(() => {});
    this.broadcast({
      type: "mode_changed",
      mode,
    });
  }

  getPermissionMode(): PermissionMode {
    return this.permissionMode;
  }

  async setModel(model?: string): Promise<void> {
    if (this.query) await this.query.setModel(model).catch(() => {});
    this.broadcast({ type: "model_changed", model });
  }

  async getContextUsage(): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
    if (!this.query) return { ok: false, error: "no active query" };
    try {
      const data = await this.query.getContextUsage();
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async mcpServerStatus(): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
    if (!this.query) return { ok: false, error: "no active query" };
    try {
      const data = await this.query.mcpServerStatus();
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async reconnectMcp(name: string): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!this.query) return { ok: false, error: "no active query" };
    try {
      await this.query.reconnectMcpServer(name);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async toggleMcp(name: string, enabled: boolean): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!this.query) return { ok: false, error: "no active query" };
    try {
      await this.query.toggleMcpServer(name, enabled);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async reloadPlugins(): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
    if (!this.query) return { ok: false, error: "no active query" };
    try {
      const data = await this.query.reloadPlugins();
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async accountInfo(): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
    if (!this.query) return { ok: false, error: "no active query" };
    try {
      const data = await this.query.accountInfo();
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async end(): Promise<void> {
    this.inputQueue.close();
    this.abortController.abort();
    this.done = true;
    this.stopJsonlWatcher();
  }

  /**
   * Re-read the on-disk JSONL for this session and broadcast any messages
   * whose uuid isn't already in the buffer. Used so a browser refresh picks
   * up turns the user added via `claude --resume` in the terminal (or any
   * other writer to the same session file).
   *
   * Idempotent and best-effort — the SDK reader can fail (file moved,
   * permissions, malformed line) and we don't want to block the normal
   * subscribe flow when it does.
   */
  async resyncFromDisk(): Promise<{ added: number }> {
    let added = 0;
    this.jsonlResyncBusy = true;
    try {
      const disk = await getSessionMessages(this.id, {
        dir: this.cwd,
        includeSystemMessages: true,
      });
      if (disk.length === 0) return { added: 0 };
      const seen = new Set<string>();
      for (const ev of this.buffer) {
        if (ev.type !== "sdk") continue;
        const m = ev.message as { uuid?: string };
        if (m.uuid) seen.add(m.uuid);
      }
      for (const m of disk) {
        const uuid = (m as { uuid?: string }).uuid;
        if (!uuid || seen.has(uuid)) continue;
        this.broadcast({ type: "sdk", message: m as unknown as SDKMessage });
        added++;
      }
    } catch {
      // non-fatal — the caller proceeds with whatever's already in the buffer
    } finally {
      this.jsonlResyncBusy = false;
    }
    return { added };
  }

  subscribe(fn: Subscriber, opts?: { tail?: number }): () => void {
    const { startIdx, hasMoreAbove } = computeReplayWindow(this.buffer, opts?.tail);
    const toReplay: ServerEvent[] =
      startIdx === 0 ? this.buffer : this.buffer.slice(startIdx);
    // Drop ephemeral interactive events from the replay. `permission_request`
    // and `ask_user_question` represent live, in-flight UI prompts — once
    // resolved, replaying them on a new subscriber (reload, second tab,
    // late connect) would re-pop a stale modal whose answer is already on
    // the wire. Live subscribers still see them when the original
    // broadcast happens; only the buffer replay filters them out.
    for (const ev of toReplay) {
      if (
        ev.type === "permission_request" ||
        ev.type === "ask_user_question" ||
        ev.type === "plan_approval_request"
      )
        continue;
      fn(ev);
    }
    // Tell the client the replay window is over so it can anchor and arm
    // the "load older" sentinel.
    fn({ type: "replay_done", hasMoreAbove });
    // Rehydrate derived state that lives upstream of the tail window. A
    // session might have set its todos hundreds of turns ago — without
    // this snapshot the client's banner stays empty on reconnect even
    // though the tool_use is still in the canonical history on disk.
    if (this.latestTodosSnapshot) {
      fn({ type: "session_snapshot", todos: this.latestTodosSnapshot });
    }
    // Re-emit `ready` for tail-truncated sessions. `ready` is broadcast
    // exactly once at start() (sits at buffer index 0), so any session
    // with more turns than `tail` slices it off the replay window —
    // leaving the client stuck on the "starting" status indicator even
    // though the SDK Query is healthy. Same shape of bug the
    // `sendFreshTitle` path below works around for session_title.
    if (this.query) {
      fn({ type: "ready", sessionId: this.id });
    }
    // Re-emit the current permission mode for the same reason. A
    // `mode_changed` event broadcast mid-conversation (e.g. by the
    // session-create reconciler when a workspace's default flips, or by
    // the user clicking the mode pill) lives in the buffer at whatever
    // turn it landed on — `tail`-truncated replays slice it off and the
    // client falls back to its initial "default" state, even though the
    // SDK is running with a different mode. Echoing the authoritative
    // current mode here keeps the pill correct on every reconnect.
    fn({ type: "mode_changed", mode: this.permissionMode });
    // Echo the current turn status. The buffer replay only carries
    // streaming assistant chunks; on `replay_done` the client unconditionally
    // clears `pending`, which would leave the StatusLine / tab dot stuck on
    // "Idle" for a session that's still mid-turn (e.g. inside a long Bash).
    // This event resyncs `pending` to the server's authoritative state.
    fn({ type: "turn_status", status: this.getStatus() });
    // Now re-emit any interactive prompts that are STILL pending. The
    // historical replay above is filtered to "resolved" prompts; questions
    // and permission requests that the agent is still waiting on need to
    // be redelivered to the new subscriber, otherwise reloading the page
    // (or switching session tabs and coming back) leaves the user with no
    // way to answer them.
    for (const pending of this.pendingAskQuestions.values()) {
      fn({
        type: "ask_user_question",
        requestId: pending.requestId,
        toolUseId: pending.toolUseId,
        questions: pending.questions,
      });
    }
    for (const pending of this.pendingPermissions.values()) {
      fn(pending.meta);
    }
    for (const pending of this.pendingPlans.values()) {
      fn({
        type: "plan_approval_request",
        requestId: pending.requestId,
        toolUseId: pending.toolUseId,
        plan: pending.plan,
        ...(pending.raw ? { raw: pending.raw } : {}),
      });
    }
    this.subscribers.add(fn);
    this.notifySubscriberCount();
    // Pull the freshest SDK-derived title into this subscriber. Two reasons:
    //   1. start() captures the title once; if the SDK auto-generates an
    //      aiTitle/summary AFTER a turn lands (which is the common case for
    //      a fresh session), the original session_title broadcast is stale
    //      or absent and a reload would otherwise see no banner.
    //   2. tail-mode replay slices the buffer to the last N turns; the
    //      session_title event broadcast at start() lives at index 0 and
    //      gets pruned out for any session with more than `tail` turns,
    //      so reconnecting tabs miss it.
    void this.sendFreshTitle(fn);
    return () => {
      this.subscribers.delete(fn);
      this.notifySubscriberCount();
    };
  }

  /**
   * Register a callback fired on every subscriber-count change. Used by
   * SessionManager to drive idle reaping: if the count drops to zero and
   * stays there past a grace window, the manager calls `end()` to release
   * the SDK child process. Returns an unregister function.
   */
  onSubscriberCountChange(cb: (count: number) => void): () => void {
    this.subscriberCountListeners.add(cb);
    return () => {
      this.subscriberCountListeners.delete(cb);
    };
  }

  /** Current SSE subscriber count. */
  subscriberCount(): number {
    return this.subscribers.size;
  }

  /**
   * Coarse session state for the tabs strip and SessionPicker. Inactive
   * tabs need to know "is the agent currently producing output / awaiting my
   * input?" — this collapses the underlying signals (`turnInFlight`, the
   * three pending-decision maps) into a two-state answer so the StatusDot
   * stays readable.
   *
   *   - `"running"`  → a turn is in flight, OR a permission / ask-user /
   *                    plan-mode prompt is open and waiting for the user.
   *   - `"idle"`     → in memory, last result has been received, no pending
   *                    decisions. The session is ready to accept new input.
   */
  getStatus(): "running" | "idle" {
    if (this.turnInFlight) return "running";
    if (this.pendingPermissions.size > 0) return "running";
    if (this.pendingAskQuestions.size > 0) return "running";
    if (this.pendingPlans.size > 0) return "running";
    return "idle";
  }

  /**
   * Broadcast a `turn_status` event when (and only when) `getStatus()` has
   * flipped since the last broadcast. Call this from every site that mutates
   * `turnInFlight` or the three pending-decision maps — the dedupe keeps the
   * wire clean while guaranteeing late-attaching tabs hear about a running
   * turn even when no further assistant chunks arrive.
   */
  private broadcastTurnStatusIfChanged(): void {
    const next = this.getStatus();
    if (next === this.lastBroadcastStatus) return;
    this.lastBroadcastStatus = next;
    this.broadcast({ type: "turn_status", status: next });
  }

  private notifySubscriberCount(): void {
    const n = this.subscribers.size;
    for (const cb of this.subscriberCountListeners) {
      try {
        cb(n);
      } catch {
        // listener throws shouldn't break the subscribe path
      }
    }
  }

  private async sendFreshTitle(fn: Subscriber): Promise<void> {
    try {
      // Local rename store wins — that's the authoritative override for
      // titles set inside Claudius (and survives across SDK weirdness).
      const local = await getSessionTitle(this.cwd, this.id).catch(() => null);
      const fromLocal = local ?? null;
      let next = fromLocal;
      if (!next) {
        const info = await getSessionInfo(this.id, { dir: this.cwd }).catch(() => null);
        next = info?.customTitle ?? info?.summary ?? null;
      }
      if (!next) return;
      if (next !== this.title) {
        // Title moved — broadcast so every open tab updates, and mirror
        // into the sessions index so the picker reflects the new label.
        this.title = next;
        this.broadcast({ type: "session_title", title: next });
        upsertSession({
          id: this.id,
          cwd: this.cwd,
          model: this.model,
          title: next,
        }).catch(() => {});
      } else {
        // Title unchanged — only the new subscriber needs it (the buffer
        // slice may have pruned the original broadcast).
        fn({ type: "session_title", title: next });
      }
    } catch {
      // non-fatal — banner stays empty, header still works
    }
  }

  private broadcast(event: ServerEvent): void {
    this.buffer.push(event);
    if (this.buffer.length > 1000) this.buffer.splice(0, this.buffer.length - 1000);
    // Sniff for derived state we want to rehydrate on tab-switch / reload.
    // The tail-replay window can slice off the original tool_use that set
    // these, so we cache the latest payload server-side and replay it via
    // session_snapshot in subscribe().
    this.captureSnapshotState(event);
    for (const sub of this.subscribers) {
      try {
        sub(event);
      } catch {
        // ignore subscriber errors
      }
    }
    // Feed the workspace notification inbox. The bus filters/dedups internally
    // (subagent skip, kind whitelist, per-session mute) and swallows errors —
    // failures here must never disrupt the session flow.
    void notificationBus.recordSessionEvent(this.cwd, this.id, event);
  }

  /**
   * Latest `todos` payload from a TodoWrite tool_use. Stored as raw
   * `unknown[]` because the client already knows how to coerce that shape;
   * keeping it untouched here means the snapshot is byte-identical with
   * what would be re-synthesised from the buffer.
   */
  private latestTodosSnapshot: unknown[] | null = null;

  private captureSnapshotState(event: ServerEvent): void {
    if (event.type !== "sdk") return;
    const m = event.message as { type?: string; message?: { content?: unknown } };
    // Top-level assistant message — subagent TodoWrites don't shape the
    // main rail (those have parent_tool_use_id set and we don't track
    // subagent state here).
    if (m.type !== "assistant") return;
    const parent = (event.message as { parent_tool_use_id?: string | null }).parent_tool_use_id;
    if (parent) return;
    const content = m.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content as Array<{ type?: string; name?: string; input?: unknown }>) {
      if (block?.type !== "tool_use") continue;
      if (block.name === "TodoWrite") {
        const raw = (block.input as { todos?: unknown } | null)?.todos;
        if (Array.isArray(raw)) this.latestTodosSnapshot = raw;
      }
    }
  }

  private async consume(): Promise<void> {
    if (!this.query) return;
    try {
      for await (const message of this.query as AsyncIterable<SDKMessage>) {
        this.broadcast({ type: "sdk", message });
        // Bump the sessions index on each completed turn so list views can
        // sort newest-active first. `result` is the SDK's per-turn done
        // marker — independent of subagent activity.
        if ((message as { type?: string }).type === "result") {
          this.turnInFlight = false;
          this.broadcastTurnStatusIfChanged();
          void touchSession(this.cwd, this.id).catch(() => {
            // index update is non-critical; never crash consume() over it
          });
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.broadcast({ type: "error", message });
    } finally {
      this.done = true;
      // Defensive: if the SDK iterator returned without ever emitting a
      // `result` (crash / abort), the turn would otherwise look forever
      // "running" to the tabs strip.
      this.turnInFlight = false;
      this.broadcastTurnStatusIfChanged();
    }
  }
}

/**
 * Best-effort coercion of the SDK's AskUserQuestion tool input into our
 * server-event shape. Defensive against schema drift — if the SDK changes
 * the field names, we drop unknown shapes rather than crash the agent.
 */
function parseQuestions(input: unknown): AskQuestion[] {
  if (!input || typeof input !== "object") return [];
  const raw = (input as Record<string, unknown>).questions;
  if (!Array.isArray(raw)) return [];
  const out: AskQuestion[] = [];
  for (const q of raw) {
    if (!q || typeof q !== "object") continue;
    const qo = q as Record<string, unknown>;
    const question = typeof qo.question === "string" ? qo.question : "";
    const header = typeof qo.header === "string" ? qo.header : "";
    const multiSelect = qo.multiSelect === true;
    const optsRaw = Array.isArray(qo.options) ? qo.options : [];
    const options: AskQuestionOption[] = [];
    for (const o of optsRaw) {
      if (!o || typeof o !== "object") continue;
      const oo = o as Record<string, unknown>;
      const label = typeof oo.label === "string" ? oo.label : "";
      const description = typeof oo.description === "string" ? oo.description : "";
      const preview = typeof oo.preview === "string" ? oo.preview : undefined;
      if (label) options.push({ label, description, preview });
    }
    if (question && options.length >= 2) {
      out.push({ question, header, options, multiSelect });
    }
  }
  return out;
}
