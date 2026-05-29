import { randomUUID } from "node:crypto";
import { watch as watchFs, type FSWatcher, promises as fsp } from "node:fs";
import {
  getSessionInfo,
  getSessionMessages,
  query,
  renameSession,
  type CanUseTool,
  type CwdChangedHookInput,
  type EffortLevel,
  type Options,
  type PermissionMode,
  type PermissionResult,
  type PreToolUseHookInput,
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
import {
  parseAskQuestions,
  type AskAnswer,
  type AskQuestion,
  type PermissionDecision,
  type PermissionRequestEvent,
  type PlanDecision,
  type ServerEvent,
  type TaskSnapshotEntry,
} from "@/lib/shared/events";
import { listSessionTasks, saveSessionTask } from "./session-tasks-db";
import { extractUserPromptText, isRealUserPrompt } from "@/lib/shared/user-prompt";
import {
  planThinkingReplayRecovery,
  thinkingReplayErrorFrom,
} from "./thinking-replay-recovery";
import { extractReadPaths } from "@/lib/shared/read-tool-paths";
import type { SessionLoop } from "@/lib/shared/session-loops";
import { readSettings, type ClaudeSettings } from "./settings";
import {
  coerceSurveyRate,
  getLastSurveyShownAt,
  noteSurveyShown,
  shouldOfferSurvey,
  SURVEY_MIN_INTERVAL_MS,
} from "./feedback-survey";

/**
 * If `filePath` lands inside a `.claude/worktrees/<name>/` tree, return the
 * absolute worktree root; otherwise null.
 *
 * This backs the PreToolUse fallback for the worktree badge. Harness-level
 * `EnterWorktree` moves the session into a git worktree WITHOUT firing the
 * SDK's `CwdChanged` (or, in some builds, `WorktreeCreate`) hook — so the
 * badge's normal signal never arrives. But any edit it makes carries an
 * absolute path under `<root>/.claude/worktrees/<name>/`, which we can sniff.
 */
export function worktreeRootFromPath(filePath: string): string | null {
  const m = /^(.*\/\.claude\/worktrees\/[^/]+)(?:\/|$)/.exec(filePath);
  return m ? m[1] : null;
}

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
  let latestUserTurnIdx = -1;
  let latestUserTurnSortKey: { at: number; idx: number } | null = null;
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
      const at =
        typeof ev.at === "number" && Number.isFinite(ev.at)
          ? ev.at
          : -Infinity;
      if (
        !latestUserTurnSortKey ||
        at > latestUserTurnSortKey.at ||
        (at === latestUserTurnSortKey.at && i > latestUserTurnSortKey.idx)
      ) {
        latestUserTurnIdx = i;
        latestUserTurnSortKey = { at, idx: i };
      }
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
  if (latestUserTurnIdx >= 0 && latestUserTurnIdx < startIdx) {
    startIdx = latestUserTurnIdx;
  }
  return { startIdx, hasMoreAbove: startIdx > 0 };
}

/**
 * Reorder `sdk` events in a replay slice into chronological order by their
 * `at` epoch ms. Non-sdk events (ready, session_title, mode_changed, etc.)
 * stay anchored at their original buffer index so control-plane ordering
 * isn't perturbed. Stable on tied `at` values — original index breaks ties
 * so multiple splits of one assistant message keep their emission order.
 * Events with no `at` are treated as 0 (so they fall to the start), which
 * is fine because every disk-replay and live broadcast path stamps `at`.
 *
 * Returns the same reference when no reordering would happen so subscribers
 * that read from the buffer don't pay needlessly.
 *
 * Exported for unit testing.
 */
export function orderSdkEventsChronologically(
  events: ReadonlyArray<ServerEvent>,
): ServerEvent[] {
  if (events.length <= 1) return events.slice();
  const sdkPositions: number[] = [];
  for (let i = 0; i < events.length; i++) {
    if (events[i].type === "sdk") sdkPositions.push(i);
  }
  if (sdkPositions.length <= 1) return events.slice();
  const sdkSorted = sdkPositions.slice().sort((a, b) => {
    const at_a = (events[a] as { at?: number }).at ?? 0;
    const at_b = (events[b] as { at?: number }).at ?? 0;
    if (at_a !== at_b) return at_a - at_b;
    return a - b;
  });
  let changed = false;
  for (let i = 0; i < sdkPositions.length; i++) {
    if (sdkSorted[i] !== sdkPositions[i]) {
      changed = true;
      break;
    }
  }
  if (!changed) return events.slice();
  const out = events.slice();
  for (let i = 0; i < sdkPositions.length; i++) {
    out[sdkPositions[i]] = events[sdkSorted[i]];
  }
  return out;
}

/**
 * Gate for the noisy `[sess-load]` logs around session start / subscribe /
 * resync. Enabled via `CLAUDIUS_DEBUG_SESSIONS=1` so we can ask a user
 * who's hitting the "old session is empty until I refresh" bug to set
 * the env var, repro, and send the server stdout. Hot-path-safe — a
 * single env-var read on the boolean coercion.
 */
function sessLoadDebug(): boolean {
  return !!process.env.CLAUDIUS_DEBUG_SESSIONS;
}

/**
 * Resolve the freshest session title from the *trusted* sources only.
 *
 * Precedence:
 *   1. `local`      — our DB row, set explicitly via `setSessionTitle`.
 *                     The user typed it in Claudius and we own this storage.
 *   2. `info.customTitle` — the SDK's persisted title (TUI `/rename`, or
 *                     the SDK's auto-derived `aiTitle` — it folds aiTitle
 *                     into the returned `customTitle` field).
 *   3. `null`       — caller leaves `this.title` empty and the UI falls
 *                     back to the id-prefix label (`tabLabelFor`).
 *
 * We deliberately do NOT fall back to `info.summary`. The SDK computes
 * that field as `customTitle || aiTitle || lastPrompt || summaryHint ||
 * firstPrompt`, so whenever neither customTitle nor aiTitle is set, the
 * "title" we'd surface is the user's latest (or first) prompt text. The
 * user reported this multiple times — they don't want a prompt sentence
 * masquerading as a session name. If the user wants a label they use
 * /rename, otherwise the id-prefix is the correct affordance.
 *
 * Exported for unit testing.
 *
 * @param local  Title from the per-project SQLite index, or null.
 * @param info   SDK session info (`customTitle`), or null. The `summary`
 *               field is accepted on the input type for forward-compat
 *               but intentionally not read.
 * @returns      The title to surface, or null when there's no trusted
 *               source. Caller treats null as "leave `this.title` alone
 *               and let the UI render the id prefix".
 */
export function resolveSessionTitle(opts: {
  local: string | null | undefined;
  info: { customTitle?: string | null; summary?: string | null } | null | undefined;
}): string | null {
  const localTrim = opts.local?.trim();
  if (localTrim) return localTrim;
  const customTrim = opts.info?.customTitle?.trim();
  if (customTrim) return customTrim;
  return null;
}

export class Session {
  readonly id: string;
  readonly cwd: string;
  /**
   * Active model id. Mutable — `setModel` flips it mid-session and the
   * picker UI relies on this being the source-of-truth so the next
   * `start()` (e.g. on resume) uses the latest pick.
   */
  model?: string;
  /**
   * Main-thread agent name (SDK Options.agent). When set, the SDK applies the
   * agent's system prompt, tool restrictions, and model to the main
   * conversation. Set at construction from the session-create request /
   * workspace default; the agent must exist (file under .claude/agents).
   */
  readonly agent?: string;
  /**
   * Hard spend cap (USD) for this session — SDK Options.maxBudgetUsd. The SDK
   * stops the turn with an `error_max_budget_usd` result once exceeded. Set at
   * construction from the create request / workspace default; undefined = no cap.
   */
  readonly maxBudgetUsd?: number;
  /**
   * Fallback model id — SDK Options.fallbackModel. The SDK switches to this
   * when the primary model is unavailable / errors. Undefined = no fallback.
   */
  readonly fallbackModel?: string;
  /**
   * Run shell commands in a sandbox — when true, the Options.sandbox config
   * forwarded to the SDK enables sandboxing with autoAllowBashIfSandboxed and
   * failIfUnavailable: false (graceful macOS degradation).
   */
  readonly sandboxEnabled?: boolean;
  readonly resumeFrom?: string;
  readonly resumeAt?: string;
  /**
   * Human-readable display title. Resolved by `resolveSessionTitle`:
   *   1. Our DB row (set via `setSessionTitle` on user rename)
   *   2. The SDK's `customTitle` (TUI rename / auto-derived `aiTitle`)
   *   3. As a *first-time-only* fallback when the title is still empty,
   *      the SDK's `summary` field — never used to overwrite an existing
   *      title, because `summary` falls back to the last user prompt.
   */
  title?: string;
  private permissionMode: PermissionMode;

  private inputQueue = new AsyncQueue<SDKUserMessage>();
  private query: Query | null = null;
  private abortController = new AbortController();

  private buffer: ServerEvent[] = [];
  private bufferTrimmed = false;
  private subscribers = new Set<Subscriber>();
  private subscriberCountListeners = new Set<(count: number) => void>();
  private pendingPermissions = new Map<string, PendingPermission>();
  private pendingAskQuestions = new Map<string, PendingAskQuestion>();
  private pendingPlans = new Map<string, PendingPlan>();
  private done = false;
  // True once a real user prompt has been pushed in THIS process. Gates the
  // feedback-survey nudge so we never survey scheduled-loop / resumed /
  // automated sessions where the human never typed (mirrors the bus's
  // `lastUserInputAt` gate for idle notifications).
  private sawUserInput = false;
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
  /**
   * Paths the model has Read this session. After every `compact_boundary`
   * message we replay them through `query.seedReadState(path, mtime)` so the
   * CLI's readFileState cache (which compaction strips) is repopulated and a
   * subsequent Edit doesn't fail "file not read yet" (B2.3).
   *
   * Accumulated across the session lifetime; seedReadState is idempotent for
   * the same path+mtime so reposting earlier reads after later compactions is
   * safe. We never remove entries — a file the model already touched stays in
   * the set even if it's later deleted on disk, because the re-seed pass
   * skips paths whose stat fails.
   */
  private recentReadPaths: Set<string> = new Set();
  // Set to true while resyncFromDisk is in flight, so a watch event that
  // arrives during the sync doesn't stack up redundant work.
  private jsonlResyncBusy = false;
  /**
   * Loops / wake-ups the agent has armed via the harness-provided
   * `CronCreate` and `ScheduleWakeup` tools. Mirrored from the SDK message
   * stream in `consume()` and exposed via `getScheduledLoops()` so the
   * `/schedule` page can show them across every open session (not just the
   * one the user is looking at).
   *
   * Map keyed by **stable loop id** — the cron id from CronCreate's result
   * (or, for wake-ups, the tool_use_id of the call). A separate pending
   * map keyed by tool_use_id lets us promote a CronCreate to the real id
   * once the result lands.
   *
   * Lives only as long as this Session object — when SessionManager
   * evicts us, the whole instance is GC'd and the loops vanish (which is
   * correct: the agent runtime dies with the session, so the crons it
   * armed die with it). No persistence layer.
   */
  private scheduledLoops = new Map<string, SessionLoop>();
  private pendingScheduledLoops = new Map<string, SessionLoop>();

  /**
   * Set once `consume()` has seen the thinking-block replay 400 for this
   * query lifetime and scheduled an auto-recovery, so a single poisoned turn
   * (which the SDK may surface more than once) triggers at most one rebuild.
   * See `runThinkingReplayRecovery` and `thinking-replay-recovery.ts`.
   */
  private thinkingReplayRecoveryScheduled = false;

  constructor(opts: {
    id?: string;
    cwd?: string;
    model?: string;
    agent?: string;
    maxBudgetUsd?: number;
    fallbackModel?: string;
    sandboxEnabled?: boolean;
    permissionMode?: PermissionMode;
    resume?: string;
    resumeSessionAt?: string;
  }) {
    // When resuming, the server-side Session.id MUST equal the SDK's session
    // id (the resumed conversation's id) — otherwise user messages we push
    // through the input queue carry a `session_id` that the SDK doesn't
    // recognize, and it errors with "No conversation found with session ID".
    const requestedId = opts.id ?? opts.resume ?? randomUUID();
    // Session ids flow into the JSONL filename (`<id>.jsonl`) and into the
    // per-session DB rows, so reject anything that could escape the
    // projects dir or contain path separators. Real SDK ids are UUIDs;
    // accept the broader `[\w-]+` to keep tests/fixtures working.
    if (!/^[\w-]+$/.test(requestedId)) {
      throw new Error("invalid session id");
    }
    this.id = requestedId;
    this.cwd = opts.cwd ?? process.cwd();
    this.model = opts.model;
    this.agent = opts.agent;
    this.maxBudgetUsd = opts.maxBudgetUsd;
    this.fallbackModel = opts.fallbackModel;
    this.sandboxEnabled = opts.sandboxEnabled;
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
        const loaded = await getSessionMessages(this.resumeFrom, {
          dir: this.cwd,
          includeSystemMessages: true,
        });
        // When resuming at a specific message (auto-recovery rewind — see
        // `thinking-replay-recovery.ts`), the SDK query is truncated to
        // `resumeAt` via Options.resumeSessionAt, but getSessionMessages has
        // no by-uuid cutoff, so the raw load still carries the dropped tail
        // (including the poisoned turn). Slice the replay to match so the chat
        // buffer reflects what the model actually sees. `resumeAt` is unset for
        // ordinary resumes, so this is a no-op there. If the uuid isn't found,
        // fall back to the full load rather than blank the history.
        let historical = loaded;
        if (this.resumeAt) {
          const cut = loaded.findIndex(
            (m) => (m as { uuid?: string }).uuid === this.resumeAt,
          );
          if (cut >= 0) historical = loaded.slice(0, cut + 1);
        }
        if (sessLoadDebug()) {
           
          console.log("[sess-load] start.resume loaded historical", {
            id: this.id,
            resumeFrom: this.resumeFrom,
            cwd: this.cwd,
            count: historical.length,
          });
        }
        // Carry-forward timestamp for assistants. JSONL only stamps user
        // records, so without this every historical assistant would fall
        // through to broadcast()'s `Date.now()` default — clustering every
        // resumed assistant at the time of resume and breaking any
        // downstream chronological sort. Inherit the most-recent preceding
        // user timestamp + 1ms-per-step so successive assistants in a turn
        // stay in their original order.
        let carriedAt: number | undefined;
        for (const m of historical) {
          const ts = (m as { timestamp?: string }).timestamp;
          const parsed = typeof ts === "string" ? Date.parse(ts) : NaN;
          let at: number | undefined;
          if (Number.isFinite(parsed)) {
            at = parsed;
            carriedAt = parsed;
          } else if (typeof carriedAt === "number") {
            carriedAt = carriedAt + 1;
            at = carriedAt;
          }
          const sdk = m as unknown as SDKMessage;
          this.broadcast({ type: "sdk", message: sdk, at });
          // Replay disk-resident tool_use / tool_result blocks through the
          // loop tracker too — without this, a session resumed from JSONL
          // would have a populated client rail (which observes the rebroadcast
          // SSE events) but an empty server-side store, breaking
          // `/api/schedule/session-loops` for any pre-existing loops.
          // Pass `at` so the entry's `startedAt` is the original arming
          // time from the JSONL timestamp, not the moment of replay.
          this.trackScheduledLoops(sdk, at);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (sessLoadDebug()) {

          console.warn("[sess-load] start.resume loadHistorical FAILED", {
            id: this.id,
            resumeFrom: this.resumeFrom,
            cwd: this.cwd,
            err: message,
          });
        }
        this.broadcast({ type: "error", message: `Failed to load session history: ${message}` });
      }
      // Pull the persisted title. Our index is authoritative because it
      // works even for sessions that haven't completed a turn yet (the
      // SDK's customTitle requires a JSONL on disk). Fall back to the SDK's
      // metadata if we have nothing locally — this picks up titles authored
      // in another client (e.g. the TUI's `/rename`). See
      // `resolveSessionTitle` for the precedence — we never derive a title
      // from prompt text.
      try {
        const local = await getSessionTitle(this.cwd, this.resumeFrom);
        const info = local ? null : await getSessionInfo(this.resumeFrom, { dir: this.cwd });
        const next = resolveSessionTitle({ local, info });
        if (next) this.title = next;
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

    // Resolve user-scope settings that map onto SDK Options. Best-effort:
    // a missing/invalid file yields `{}` so we fall back to defaults. Mirrors
    // the `feedbackSurveyRate` read in `maybeOfferFeedbackSurvey`.
    const userSettings = await readSettings("user", this.cwd).catch(
      () => ({}) as ClaudeSettings,
    );

    const options: Options = {
      cwd: this.cwd,
      model: this.model,
      // Main-thread agent (SDK `--agent`). When set, the agent's system
      // prompt, tools, and model apply to the main conversation — note the
      // agent's own model takes precedence over `model` above. Omitted when
      // unset so the default agent is used.
      ...(this.agent ? { agent: this.agent } : {}),
      // Hard spend cap. When set, the SDK stops the turn and returns an
      // `error_max_budget_usd` result once cumulative cost exceeds it. Only
      // forwarded when a positive number so 0/undefined means "no cap".
      ...(typeof this.maxBudgetUsd === "number" && this.maxBudgetUsd > 0
        ? { maxBudgetUsd: this.maxBudgetUsd }
        : {}),
      // Fallback model — the SDK switches to this if the primary model is
      // unavailable or errors (overload, model_not_found). Omitted when unset.
      ...(this.fallbackModel ? { fallbackModel: this.fallbackModel } : {}),
      // Sandbox shell commands. autoAllowBashIfSandboxed avoids permission
      // hammering once the sandbox is on; failIfUnavailable:false lets it
      // degrade gracefully on macOS (no bubblewrap) rather than failing the
      // whole query. The SDK leaves the actual access policy to the existing
      // Bash/WebFetch permission rules.
      ...(this.sandboxEnabled
        ? {
            sandbox: {
              enabled: true,
              autoAllowBashIfSandboxed: true,
              failIfUnavailable: false,
            },
          }
        : {}),
      permissionMode: this.permissionMode,
      abortController: this.abortController,
      canUseTool: this.canUseTool,
      includePartialMessages: true,
      // Forward subagent text and thinking blocks as assistant/user
      // messages with `parent_tool_use_id` set. Without this, SDK 0.3.152+
      // only emits subagent `tool_use` / `tool_result` blocks (enough for a
      // heartbeat counter) — the TaskBlock would then never have any
      // inner-message content to expand into, leaving the user staring at
      // the "Subagent working…" placeholder for the full run. With this
      // flag the SDK forwards the full subagent conversation so the
      // expanded TaskBlock renders the nested transcript the same way the
      // top-level chat renders the parent.
      forwardSubagentText: true,
      // Ask the SDK to emit periodic AI-generated progress summaries for
      // running subagents (foreground + background). Every ~30s the SDK
      // forks the subagent to produce a short present-tense status (e.g.
      // "Analyzing authentication module"), delivered on `task_progress`
      // via the `summary` field — which the client threads onto TaskInfo
      // and the BackgroundTasksPanel renders. The fork reuses the
      // subagent's model + prompt cache, so cost is typically minimal.
      agentProgressSummaries: true,
      // Ask the SDK to emit a predicted next-user-prompt (`prompt_suggestion`
      // message) after each turn's result. The client already threads these
      // into `promptSuggestions` state and renders them as clickable chips
      // (PromptSuggestions). Suggestions ride the parent's prompt cache so
      // they're nearly free, and the SDK self-suppresses on the first turn,
      // after API errors, and in plan mode. On by default; users turn them off
      // via the SDK's `promptSuggestionEnabled` user setting (Settings → Chat,
      // or the env gate CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false). The
      // `promptSuggestions` fallback honors files written before the rename.
      promptSuggestions:
        (userSettings.promptSuggestionEnabled ?? userSettings.promptSuggestions) !== false,
      // Track file edits so the user can rewind the working tree to its
      // state at any prior user message via Query.rewindFiles() (see the
      // `rewindFiles` method + POST /api/sessions/[id]/rewind). The SDK
      // snapshots files before each modification; cleanup follows the
      // `cleanupPeriodDays` setting (default 30d).
      enableFileCheckpointing: true,
      // Opt into adaptive extended thinking explicitly so the agent
      // emits the full reasoning text in `thinking` blocks. Without
      // this, recent SDK builds default to a `display: 'omitted'`
      // shape on short turns and the chat surface renders empty
      // Thinking blocks. Leaving `display` unset means "full text"
      // (the alternatives — 'summarized' / 'omitted' — both hide it).
      //
      // The chat verbosity selector (see `lib/shared/verbose.ts`) gates
      // whether `thinking` blocks render in the middle pane — but the SDK
      // setting stays at adaptive/full because the blocks still need to
      // arrive over the wire to be available for the "verbose" level and
      // the right-rail's Tools/thinking row. Hiding thinking is purely a
      // client-side filter.
      thinking: { type: "adaptive" },
      // Tell the model to emit HTML (not markdown) in option `preview` fields,
      // so the AskUserQuestion modal can render rich previews (mockups, code
      // snippets, configuration examples) directly in the browser. Default
      // is markdown, which the CLI shows in a monospace box.
      toolConfig: {
        askUserQuestion: { previewFormat: "html" },
      },
      // Observe the agent's working-directory transitions and surface a
      // "worktree" badge when it leaves the session root — otherwise the
      // user's "current changed files" won't reflect what the agent touched.
      //
      // Two signals feed `broadcastCwd` (deduped):
      //   1. `CwdChanged` — the SDK's own cwd move (fires when Claude Code
      //      spins up a worktree as part of normal operation).
      //   2. PreToolUse path heuristic — a mutating file tool whose target
      //      path lives under `<root>/.claude/worktrees/<name>/` means edits
      //      aren't landing in the user's checkout, so we flag the worktree.
      //      This is what catches harness-level `EnterWorktree`, which does
      //      NOT emit `CwdChanged`.
      //
      // DO NOT register a `WorktreeCreate`/`WorktreeRemove` hook to drive this.
      // Those are creation *extension points*, not observers: the SDK delegates
      // worktree creation to the hook and REQUIRES it to return
      // `hookSpecificOutput.worktreePath`. A passive `{ continue: true }`
      // handler makes `EnterWorktree` fail outright ("hook succeeded but
      // returned no worktree path"). Verified the hard way.
      //
      // Hooks return `{ continue: true }` so we never block the agent, and
      // programmatic hooks merge with any user settings.json hooks.
      hooks: {
        PreToolUse: [
          {
            hooks: [
              async (input) => {
                const pre = input as PreToolUseHookInput;
                // Worktree detection (signal #2 above).
                const ti = (pre.tool_input ?? {}) as {
                  file_path?: string;
                  notebook_path?: string;
                };
                const target = ti.file_path ?? ti.notebook_path;
                if (
                  typeof target === "string" &&
                  ["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(
                    pre.tool_name ?? "",
                  )
                ) {
                  const wt = worktreeRootFromPath(target);
                  if (wt) this.broadcastCwd(wt);
                }
                return { continue: true };
              },
            ],
          },
        ],
        CwdChanged: [
          {
            hooks: [
              async (input) => {
                const cwd = (input as CwdChangedHookInput).new_cwd;
                if (typeof cwd === "string" && cwd.length > 0) {
                  this.broadcastCwd(cwd);
                }
                return { continue: true };
              },
            ],
          },
        ],
      },
      // Pin the session id so the SDK names its on-disk JSONL with our id.
      // This makes Claudius web ids match the TUI: `claude --resume <id>`
      // resolves the same conversation. The SDK forbids `sessionId` together
      // with `resume` (it'd be ambiguous), so only set it for new sessions.
      ...(this.resumeFrom ? { resume: this.resumeFrom } : { sessionId: this.id }),
      ...(this.resumeAt ? { resumeSessionAt: this.resumeAt } : {}),
    };
    this.query = query({ prompt: this.inputQueue, options });
    this.broadcast({ type: "ready", sessionId: this.id, ...(this.agent ? { agent: this.agent } : {}) });
    if (this.title) this.broadcast({ type: "session_title", title: this.title });
    if (sessLoadDebug()) {
       
      console.log("[sess-load] start.complete", {
        id: this.id,
        resumeFrom: this.resumeFrom ?? null,
        bufferLen: this.buffer.length,
        title: this.title ?? null,
      });
    }
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
        const questions = parseAskQuestions(input);
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
    // `updatedInput` is REQUIRED on the allow branch even though sdk.d.ts
    // marks it optional — the SDK's runtime Zod validator rejects
    // `undefined` with "Invalid input: expected record, received undefined"
    // and surfaces it to the model as a tool_result error. The model then
    // retries ExitPlanMode (re-opening our plan overlay) and the user is
    // stuck in a loop. We mirror the original tool input here; the edited-
    // plan branch below replaces it with the user's draft when applicable.
    // Same defense as `resolvePermission` at line 708.
    const rawInput =
      pending.raw && typeof pending.raw === "object" && !Array.isArray(pending.raw)
        ? pending.raw
        : {};
    const result: PermissionResult = {
      behavior: "allow",
      updatedInput: rawInput,
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
      result.updatedInput = { ...rawInput, plan: editedPlan };
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
    opts?: { uuid?: string; slash?: boolean },
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
    this.sawUserInput = true;
    this.turnInFlight = true;
    this.broadcastTurnStatusIfChanged();

    // Slash-command shortcut: send `/compact`, `/init`, etc. to the SDK
    // verbatim so the CLI subprocess can interpret them, but DON'T broadcast
    // the synthetic user-message echo — otherwise the chat shows `/compact`
    // as if the user had typed it. We drop in a small `slash_invoked` system
    // event so the chat doesn't go silent while the SDK works. Image
    // attachments are not supported alongside slash commands (the dispatcher
    // in app/page.tsx already gates this), so we ignore `images` here.
    //
    // We re-use the *same* `uuid` for both the inputQueue user message and
    // the broadcast `slash_invoked` system event. This matters on reload:
    // `resyncFromDisk` (and `loadHistorical` on session start) build their
    // "already seen" set from buffer uuids and skip any JSONL message whose
    // uuid is already in the buffer. Without this, the disk-side `/compact`
    // user message would re-broadcast on every refresh and the echo bug
    // would come back via the resync path.
    if (opts?.slash) {
      const message = { role: "user" as const, content: text };
      const command = text.trim().split(/\s+/, 1)[0] ?? "/";
      const args = text.trim().slice(command.length).trim();
      this.broadcast({
        type: "sdk",
        message: {
          type: "system",
          subtype: "slash_invoked",
          command,
          args,
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

  /**
   * Snapshot of the session-only loops/wake-ups armed via the SDK's
   * `CronCreate` / `ScheduleWakeup` tools. Returned as a fresh array so
   * callers can't mutate the internal Map.
   *
   * Used by `GET /api/schedule/session-loops` to surface in-flight loops
   * on the `/schedule` page across every open session.
   */
  getScheduledLoops(): SessionLoop[] {
    return [...this.scheduledLoops.values()];
  }

  /**
   * Observe an SDK message and update `scheduledLoops` if it carries any
   * `CronCreate` / `CronDelete` / `ScheduleWakeup` tool_use blocks (or
   * the matching tool_result).
   *
   * Why duplicate the client-side reducer here:
   *   - The client only sees its own session via SSE; the `/schedule` page
   *     wants a global view across every live session. The server is the
   *     only place that can aggregate.
   *   - We need state that survives a closed browser tab — as long as the
   *     Session object lives (i.e. the agent runtime is still up and the
   *     cron can actually fire), the loop entry has to stay visible.
   *
   * The text-result regex must match `lib/client/use-session.ts`'s reducer
   * so the cron id / humanSchedule resolve to the same values on both
   * sides. Update them together.
   *
   * `at` is the observed-at timestamp for this message — the JSONL
   * `timestamp` field on disk-replay, or `Date.now()` for live SDK
   * events. We use it as `startedAt` so the countdown is anchored to
   * when the loop was *originally* armed, not when the page happened to
   * replay it. Without this, every refresh resets the timer to the
   * original delay (the user-visible "timer goes to 9m every reload"
   * bug). Defaults to `Date.now()` when callers don't pass one — that
   * preserves the original behavior for the live consume() path where
   * "now" is genuinely the arming time.
   */
  private trackScheduledLoops(message: SDKMessage, at?: number): void {
    const observedAt = typeof at === "number" ? at : Date.now();
    type ToolUseBlock = {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    };
    type ToolResultBlock = {
      type: "tool_result";
      tool_use_id: string;
      content: unknown;
      is_error?: boolean;
    };

    const m = message as {
      type?: string;
      message?: { content?: unknown };
    };

    const content = m.message?.content;
    if (!Array.isArray(content)) return;

    if (m.type === "assistant") {
      for (const raw of content) {
        const b = raw as { type?: string };
        if (b.type !== "tool_use") continue;
        const tu = raw as ToolUseBlock;

        if (tu.name === "CronCreate") {
          const inp = tu.input as {
            cron?: unknown;
            prompt?: unknown;
            recurring?: unknown;
          };
          const cron = typeof inp.cron === "string" ? inp.cron : "";
          const prompt = typeof inp.prompt === "string" ? inp.prompt : "";
          if (!cron) continue;
          // Dedup: if we've already promoted this tool_use into the
          // active map (via its later tool_result), don't re-stamp it as
          // pending — that would orphan the entry. The active-map
          // dedup below handles the unpromoted-pending case the same
          // way (idempotent on replay).
          if (this.pendingScheduledLoops.has(tu.id)) continue;
          this.pendingScheduledLoops.set(tu.id, {
            kind: "cron",
            id: tu.id, // placeholder; re-keyed once tool_result lands
            toolUseId: tu.id,
            cron,
            humanSchedule: null,
            delaySeconds: null,
            prompt,
            recurring: inp.recurring === true,
            durable: false,
            startedAt: observedAt,
            cancelled: false,
          });
          continue;
        }

        if (tu.name === "CronDelete") {
          const idRaw = (tu.input as { id?: unknown }).id;
          const id = typeof idRaw === "string" ? idRaw : null;
          if (!id) continue;
          const entry = this.scheduledLoops.get(id);
          if (entry) entry.cancelled = true;
          continue;
        }

        if (tu.name === "ScheduleWakeup") {
          const inp = tu.input as {
            delaySeconds?: unknown;
            reason?: unknown;
            prompt?: unknown;
          };
          // Dedup: replaying the same tool_use shouldn't reset its own
          // startedAt. Without this guard, the "delete prior wake-ups"
          // step below would drop the entry and we'd re-insert it with
          // a fresh `observedAt` — fine on the very first replay, but
          // would lose the entry on subsequent re-broadcasts when no
          // new wake-up has actually been armed.
          if (this.scheduledLoops.has(tu.id)) continue;
          // One-shot: a fresh wake-up supersedes any prior pending wake-up
          // for this session (matches the client's reducer).
          for (const [k, v] of this.scheduledLoops) {
            if (v.kind === "wakeup" && !v.cancelled) this.scheduledLoops.delete(k);
          }
          this.scheduledLoops.set(tu.id, {
            kind: "wakeup",
            id: tu.id,
            toolUseId: tu.id,
            cron: null,
            humanSchedule: null,
            delaySeconds: typeof inp.delaySeconds === "number" ? inp.delaySeconds : null,
            prompt: typeof inp.prompt === "string" ? inp.prompt : "",
            reason: typeof inp.reason === "string" ? inp.reason : undefined,
            recurring: false,
            durable: false,
            startedAt: observedAt,
            cancelled: false,
          });
          continue;
        }
      }
      return;
    }

    if (m.type === "user") {
      for (const raw of content) {
        const b = raw as { type?: string };
        if (b.type !== "tool_result") continue;
        const tr = raw as ToolResultBlock;
        const pending = this.pendingScheduledLoops.get(tr.tool_use_id);
        if (!pending) continue;
        this.pendingScheduledLoops.delete(tr.tool_use_id);

        // Extract the text payload — `content` is either a string or an
        // array of `{type:"text", text:string}` blocks per the Anthropic
        // wire format. Mirror what extractToolResult does on the client.
        let text = "";
        if (typeof tr.content === "string") {
          text = tr.content;
        } else if (Array.isArray(tr.content)) {
          for (const c of tr.content as Array<{ type?: string; text?: string }>) {
            if (c?.type === "text" && c.text) text += c.text;
          }
        }

        if (tr.is_error) continue; // drop pending: the tool failed

        // Same regex as the client reducer — keep in sync.
        const idMatch = text.match(/job\s+([a-z0-9]+)\s*\(([^)]+)\)/i);
        const cronId = idMatch?.[1] ?? pending.toolUseId;
        const humanSchedule = idMatch?.[2] ?? null;
        const durable = !/session[- ]only/i.test(text);

        this.scheduledLoops.set(cronId, {
          ...pending,
          id: cronId,
          humanSchedule,
          durable,
        });
      }
    }
  }

  async setModel(model?: string): Promise<void> {
    if (this.query) await this.query.setModel(model).catch(() => {});
    this.model = model;
    // Persist so the pick survives reap → resume. Without this the in-memory
    // mutation is lost when the SessionManager evicts the Session object, and
    // the next `start()` pulls the (stale) original model from the constructor
    // path. The `sessions.model` column already exists (migration 002) and
    // `upsertSession` upserts on conflict — no schema change needed.
    try {
      await upsertSession({
        id: this.id,
        cwd: this.cwd,
        model: this.model,
        title: this.title,
      });
    } catch {
      // Non-fatal: SSE listeners still get the change, and the SDK side
      // still applied it. DB write failure just means the next resume
      // falls back to the prior default.
    }
    this.broadcast({ type: "model_changed", model });
  }

  /**
   * Set the reasoning-effort level for subsequent turns.
   *
   * The SDK exposes effort via `applyFlagSettings({ effortLevel })`, not as
   * a slash command — an earlier cut of the client routed `/effort <level>`
   * through the input pipeline, but the SDK answers that with
   * `/effort isn't available in this environment.` because no such command
   * is registered. The flag-settings layer sits above project/user settings
   * and below managed-policy settings, so the override survives until we
   * clear it (or the SDK session ends).
   *
   * `null` / `"auto"` clears the override and returns the model to its
   * default adaptive behavior. Other values pass through verbatim — we let
   * the SDK validate against the active model's `supportedEffortLevels`
   * rather than re-implementing that check here. The `Settings.effortLevel`
   * type currently excludes `"max"` but the SDK's `EffortLevel` includes
   * it; we cast and forward so the picker's max chip works on models that
   * support it.
   *
   * No DB persistence — effort isn't on the `sessions` schema. After a
   * reap → resume, the level falls back to default. The client mirrors the
   * pick optimistically so the SessionCard pill stays honest within a
   * session's lifetime; that's the trade we accept until the SDK adds an
   * `effort_changed` event we can subscribe to.
   */
  async setEffort(level: EffortLevel | "auto"): Promise<void> {
    if (!this.query) return;
    // Cast: `Settings.effortLevel` is `'low' | 'medium' | 'high' | 'xhigh'`
    // (no max), but the SDK accepts max at runtime on supporting models.
    // Trust the SDK to reject unsupported levels rather than narrowing here.
    const value = level === "auto" ? null : (level as "low" | "medium" | "high" | "xhigh");
    await this.query.applyFlagSettings({ effortLevel: value }).catch(() => {});
  }

  /**
   * Forward user feedback to Anthropic via the SDK's *undocumented* control
   * method `query.submitFeedback`. It isn't in the SDK's public typings (no
   * `.d.ts` entry), but it lives on the same control-protocol object that
   * backs the typed methods like `setEffort`/`seedReadState` and routes
   * through the same channel the CLI's session-quality survey uses to reach
   * Anthropic. We feature-detect and swallow failures: if a future SDK drops
   * the method, forwarding degrades to a no-op and the caller still persists
   * the feedback locally. Returns whether the SDK accepted the forward.
   */
  async submitFeedback(description: string, surface = "claudius"): Promise<boolean> {
    const q = this.query as
      | (Query & {
          submitFeedback?: (
            description: string,
            opts?: { surface?: string },
          ) => Promise<unknown>;
        })
      | null;
    if (!q || typeof q.submitFeedback !== "function") return false;
    try {
      await q.submitFeedback(description, { surface });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * After a successful turn, occasionally nudge the user for feedback —
   * Claudius's replica of the CLI's session-quality survey. Eligibility +
   * probability live in `feedback-survey.ts` (pure, tested); the rate comes
   * from the user-scope `feedbackSurveyRate` setting. Best-effort: any error
   * is swallowed so the consume() loop is never disrupted by a nudge.
   */
  private async maybeOfferFeedbackSurvey(message: SDKMessage): Promise<void> {
    try {
      const isError = (message as { is_error?: boolean }).is_error === true;
      // Cheap synchronous gates first — avoid a settings file read on every
      // turn while throttled or ineligible.
      if (isError || !this.sawUserInput) return;
      const now = Date.now();
      if (now - getLastSurveyShownAt() < SURVEY_MIN_INTERVAL_MS) return;
      const settings = await readSettings("user", this.cwd).catch(
        () => ({}) as ClaudeSettings,
      );
      const rate = coerceSurveyRate(settings.feedbackSurveyRate);
      if (
        !shouldOfferSurvey({
          rate,
          isError,
          sawUserInput: this.sawUserInput,
          now,
          lastShownAt: getLastSurveyShownAt(),
        })
      ) {
        return;
      }
      noteSurveyShown(now);
      this.broadcast({ type: "feedback_survey", sessionId: this.id, surface: "claudius" });
    } catch {
      // A feedback nudge is never worth disrupting the turn loop.
    }
  }

  /**
   * Forward the model list the SDK advertises for this session. The SDK
   * returns per-model metadata (display name, description, supported effort
   * levels) so the picker can render the same options the CLI's `/model`
   * surface offers.
   *
   * Throws when there's no active query (session not started yet, or
   * reaped); the API route maps that to a 503 so the client can retry.
   */
  async supportedModels(): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
    if (!this.query) return { ok: false, error: "session not active" };
    try {
      const data = await this.query.supportedModels();
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Forward the subagent list the SDK has loaded for this session — the same
   * `AgentInfo[]` the CLI's `claude agents` surface and the `--agent` picker
   * read. This is the source of truth for "which agents are actually live"
   * (file-based `.claude/agents/*.md`, plugin-injected, and the built-in
   * general-purpose / Explore agents), as opposed to the filesystem listing
   * in `lib/server/agents.ts` which only sees the markdown files on disk.
   *
   * Same `{ ok, data | error }` envelope as `supportedModels`; the API route
   * maps `ok: false` to a 503 so a not-yet-started session can be retried.
   */
  async supportedAgents(): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
    if (!this.query) return { ok: false, error: "session not active" };
    try {
      const data = await this.query.supportedAgents();
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Forward the slash-command list the SDK advertises for this session as
   * rich `SlashCommand` objects (name + description + argumentHint + aliases)
   * — richer than the bare name list in the system:init message. Used to
   * enrich the slash-command picker's descriptions for SDK/plugin-provided
   * commands and to refresh after a plugin reload. Same `{ ok, data | error }`
   * envelope as `supportedAgents` / `supportedModels`.
   */
  async supportedCommands(): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
    if (!this.query) return { ok: false, error: "session not active" };
    try {
      const data = await this.query.supportedCommands();
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
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

  /**
   * Rewind tracked files to their state at a given user message. Requires
   * `enableFileCheckpointing` (set in start()). With `dryRun: true` the SDK
   * reports what *would* change (filesChanged / insertions / deletions)
   * without touching the working tree — the client uses that for a preview
   * before the user confirms a destructive rewind.
   *
   * Returns the SDK's RewindFilesResult on success. `canRewind: false` (with
   * an `error` string) is a normal, non-throwing outcome — e.g. the message
   * id is unknown or no checkpoint exists — and is surfaced to the caller
   * inside `data`, not as `{ ok: false }`.
   */
  async rewindFiles(
    userMessageId: string,
    opts?: { dryRun?: boolean },
  ): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
    if (!this.query) return { ok: false, error: "no active query" };
    try {
      const data = await this.query.rewindFiles(userMessageId, opts);
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Stop a single running task (Bash command or subagent) by its task id —
   * the SDK emits a `task_notification` with status 'stopped' in response.
   * Targets just that task, unlike `interrupt()` which aborts the whole turn
   * (B2.4). Task ids come from the `task_started` / `task_notification`
   * events the client already tracks in TaskInfo.
   */
  async stopTask(taskId: string): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!this.query) return { ok: false, error: "no active query" };
    try {
      await this.query.stopTask(taskId);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Push in-flight foreground work to the background — the control-request
   * equivalent of Ctrl+B in the terminal (B2.4). With `toolUseId` it targets
   * the single blocking task started by that tool_use block; without it,
   * backgrounds all foreground tasks. The blocking tool call returns
   * immediately with a "running in the background" tool_result and the turn
   * continues; the task keeps running and emits a `task_notification` when it
   * settles. Returns the SDK's boolean (false only when a given `toolUseId`
   * matched no foreground task).
   */
  async backgroundTasks(
    toolUseId?: string,
  ): Promise<{ ok: true; backgrounded: boolean } | { ok: false; error: string }> {
    if (!this.query) return { ok: false, error: "no active query" };
    try {
      const backgrounded = await this.query.backgroundTasks(toolUseId);
      return { ok: true, backgrounded };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * B2.3: replay every path the model has Read this session through the
   * SDK's `seedReadState(path, mtime)` so the CLI's readFileState cache is
   * repopulated after a `compact_boundary`. Without this, an Edit after
   * compaction fails "file not read yet" even though the model believes
   * (correctly) that it has read the file.
   *
   * Best-effort throughout: stat failures (file deleted, permission denied)
   * skip that single path; an SDK throw on `seedReadState` skips this path
   * too. Nothing here surfaces an error to the user — the worst case is the
   * "file not read yet" error this method was added to prevent, which the
   * user will see and recover from manually. We don't await this from the
   * consume loop; the iterator must keep draining the SDK stream.
   *
   * mtimeMs is floored per the SDK contract ("File mtime (floored ms) at
   * the time of the observed Read") so the SDK accepts the seed.
   */
  private async reseedReadPathsAfterCompact(): Promise<void> {
    if (!this.query) return;
    for (const path of this.recentReadPaths) {
      try {
        const st = await fsp.stat(path);
        await this.query.seedReadState(path, Math.floor(st.mtimeMs));
      } catch {
        // Single-path failure (stat threw / seedReadState threw / query
        // closed mid-pass) is non-fatal — move on to the next path.
      }
    }
  }

  /**
   * The subset of create options needed to rebuild this session under the
   * same id during auto-recovery (see `SessionManager.recoverInPlace`).
   * `resume` / `resumeSessionAt` are supplied by the caller.
   */
  getRebuildOpts(): {
    cwd: string;
    model?: string;
    agent?: string;
    maxBudgetUsd?: number;
    fallbackModel?: string;
    sandboxEnabled?: boolean;
    permissionMode: PermissionMode;
  } {
    return {
      cwd: this.cwd,
      model: this.model,
      agent: this.agent,
      maxBudgetUsd: this.maxBudgetUsd,
      fallbackModel: this.fallbackModel,
      sandboxEnabled: this.sandboxEnabled,
      permissionMode: this.permissionMode,
    };
  }

  /**
   * One-shot trigger for thinking-block-replay auto-recovery. Called from the
   * `consume()` loop when it observes the 400. Deferred so the current
   * iterator unwinds before we tear the Session down and rebuild it.
   */
  private scheduleThinkingReplayRecovery(): void {
    if (this.thinkingReplayRecoveryScheduled) return;
    this.thinkingReplayRecoveryScheduled = true;
    this.broadcast({
      type: "error",
      message:
        "Thinking-block replay error (HTTP 400) — auto-recovering: rewinding past the failed turn and retrying.",
    });
    setTimeout(() => {
      void this.runThinkingReplayRecovery();
    }, 0);
  }

  /**
   * Rebuild the session truncated to before the poisoned turn, then re-send
   * the prompt that started it. Reuses the proven resume path
   * (`SessionManager.recoverInPlace` → `create({ resume, resumeSessionAt })`)
   * so the session id — and therefore the open browser tab's URL — is
   * preserved; the client just reconnects to the rebuilt session. Failures
   * are surfaced to the user rather than silently looping.
   */
  private async runThinkingReplayRecovery(): Promise<void> {
    try {
      const messages = await getSessionMessages(this.id, {
        dir: this.cwd,
        includeSystemMessages: false,
      });
      const plan = planThinkingReplayRecovery(messages);
      if (!plan) {
        this.broadcast({
          type: "error",
          message:
            "Could not auto-recover from the thinking-block error (no safe rewind point). Start a new session, or fork before the failing turn.",
        });
        return;
      }
      // Dynamic import avoids a static session ⇄ session-manager import cycle
      // (the manager statically imports Session).
      const { sessionManager } = await import("./session-manager");
      const res = await sessionManager.recoverInPlace(this.id, {
        resumeAt: plan.resumeAt,
        replayPrompt: plan.replayPrompt,
      });
      if (!res.ok) {
        this.broadcast({
          type: "error",
          message:
            res.reason === "max_attempts"
              ? "Auto-recovery gave up after repeated thinking-block failures on the same turn — please start a new session."
              : `Auto-recovery could not rebuild the session (${res.reason}).`,
        });
      }
    } catch (err) {
      this.broadcast({
        type: "error",
        message: `Auto-recovery failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  async end(): Promise<void> {
    this.inputQueue.close();
    this.abortController.abort();
    this.done = true;
    this.stopJsonlWatcher();
    // Backstop: drain any pending agent-decision maps before the Session
    // is dropped. The per-tool `ctx.signal` abort listeners (set when each
    // request was raised) are SUPPOSED to fire from this `abortController.abort()`
    // and clean up the maps themselves, but the cascade depends on how the
    // SDK wires `ctx.signal` to `options.abortController` — if any tool-use
    // signal failed to propagate, the entry would sit forever and any caller
    // touching the stale Session would see `getStatus() === "running"`. The
    // map mutations here are no-ops when the abort listeners already ran
    // (they `.delete` and resolve, the map is empty by the time we get here),
    // so this is purely defensive. See docs/notifications.md §10.2.A.
    this.drainPendingDecisions("Aborted");
    // Drop ephemeral loop state. The Session instance itself is about to
    // be dropped by SessionManager.remove, but if anyone holds a stale
    // reference (test helper, etc.) we don't want them to read ghost
    // loops or pending entries that will never resolve.
    this.scheduledLoops.clear();
    this.pendingScheduledLoops.clear();
  }

  /**
   * Resolve + clear every entry in the three `pending*` decision maps. Used
   * as a backstop from `consume()` finally and `end()` — anywhere the
   * Session is about to stop processing input and we can't leave entries
   * waiting forever (their pending promises would never settle, AND
   * `getStatus()` would return `"running"` indefinitely, which silently
   * breaks both the tab-strip status dot and the `session_idle`
   * notification, since both are gated on `getStatus()` flipping to
   * `"idle"`). Existing abort handlers (lines ~613, ~648, ~675) clean
   * these up via the per-tool `ctx.signal` cascade in the normal case;
   * this is the safety net for when that cascade misses an entry.
   *
   * Caller is responsible for calling `broadcastTurnStatusIfChanged()`
   * afterwards — keeps the broadcast-on-status-flip invariant in one
   * place per call site rather than emitting from inside the drain.
   */
  private drainPendingDecisions(reason: string): void {
    if (
      this.pendingPermissions.size === 0 &&
      this.pendingAskQuestions.size === 0 &&
      this.pendingPlans.size === 0
    ) {
      return;
    }
    const denyResult: PermissionResult = { behavior: "deny", message: reason };
    for (const [id, p] of this.pendingPermissions) {
      this.pendingPermissions.delete(id);
      try {
        p.resolve(denyResult);
      } catch {
        // resolver already settled — fine, we just needed the map slot freed
      }
    }
    for (const [id, p] of this.pendingAskQuestions) {
      this.pendingAskQuestions.delete(id);
      try {
        p.resolve(denyResult);
      } catch {
        // ignore
      }
    }
    for (const [id, p] of this.pendingPlans) {
      this.pendingPlans.delete(id);
      try {
        p.resolve(denyResult);
      } catch {
        // ignore
      }
    }
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
      if (disk.length === 0) {
        if (sessLoadDebug()) {
           
          console.log("[sess-load] resyncFromDisk empty", {
            id: this.id,
            cwd: this.cwd,
            bufferLen: this.buffer.length,
          });
        }
        return { added: 0 };
      }
      const seen = new Set<string>();
      for (const ev of this.buffer) {
        if (ev.type !== "sdk") continue;
        const m = ev.message as { uuid?: string };
        if (m.uuid) seen.add(m.uuid);
      }
      // Carry-forward timestamp anchor — walk the full disk list (not just
      // the new tail) so assistants we're about to broadcast inherit their
      // turn's user timestamp even when the user record was already in the
      // buffer and we're only adding the assistants that follow it.
      let carriedAt: number | undefined;
      for (const m of disk) {
        const ts = (m as { timestamp?: string }).timestamp;
        const parsed = typeof ts === "string" ? Date.parse(ts) : NaN;
        if (Number.isFinite(parsed)) {
          carriedAt = parsed;
        } else if (typeof carriedAt === "number") {
          carriedAt = carriedAt + 1;
        }
        const uuid = (m as { uuid?: string }).uuid;
        if (!uuid || seen.has(uuid)) continue;
        // Preserve the original JSONL `timestamp` as `at` so the UI shows
        // the time the message was actually written, not "now". Without
        // this, `broadcast()` defaults `at` to Date.now() and a watcher-
        // driven resync (terminal `claude --resume`, external SDK writer)
        // makes historically-old messages appear as if they just arrived
        // — exactly the "old messages coming as new" symptom users hit
        // when they switched contexts. For assistants (no JSONL stamp),
        // ride on the carry-forward so they inherit their turn time
        // instead of falling through to Date.now() in `broadcast()`.
        const at = Number.isFinite(parsed) ? parsed : carriedAt;
        const sdk = m as unknown as SDKMessage;
        this.broadcast({ type: "sdk", message: sdk, at });
        // External writers (terminal `claude --resume`, another SDK client)
        // can arm or cancel loops on disk; replay them through the tracker
        // here too so the server-side store mirrors the client rail after
        // a resync. Pass `at` so `startedAt` reflects the JSONL timestamp
        // (original arming time) and not the resync moment.
        this.trackScheduledLoops(sdk, at ?? undefined);
        added++;
      }
      if (sessLoadDebug()) {
         
        console.log("[sess-load] resyncFromDisk done", {
          id: this.id,
          diskLen: disk.length,
          added,
          bufferLen: this.buffer.length,
        });
      }
    } catch (err) {
      if (sessLoadDebug()) {
         
        console.warn("[sess-load] resyncFromDisk FAILED", {
          id: this.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
      // non-fatal — the caller proceeds with whatever's already in the buffer
    } finally {
      this.jsonlResyncBusy = false;
    }
    return { added };
  }

  subscribe(fn: Subscriber, opts?: { tail?: number }): () => void {
    const replayWindow = computeReplayWindow(this.buffer, opts?.tail);
    const startIdx = replayWindow.startIdx;
    const hasMoreAbove = replayWindow.hasMoreAbove || this.bufferTrimmed;
    const sliced: ReadonlyArray<ServerEvent> =
      startIdx === 0 ? this.buffer : this.buffer.slice(startIdx);
    // Belt-and-suspenders chronological order for the replay window. The
    // buffer is APPENDED in broadcast order, and broadcast order is normally
    // chronological — but a `resyncFromDisk` race that finds disk lines the
    // live `consume()` loop hasn't pushed yet can append an older message
    // after a newer one. The client also sorts defensively, but doing it
    // here means even a session whose buffer drifted out of order
    // self-corrects on every reconnect. Sort only `sdk` events among
    // themselves and keep non-sdk events (ready / session_title / mode_changed
    // pills) anchored to their original buffer position so control-plane
    // ordering is preserved.
    const toReplay = orderSdkEventsChronologically(sliced);
    if (sessLoadDebug()) {
       
      console.log("[sess-load] subscribe", {
        id: this.id,
        tail: opts?.tail,
        bufferLen: this.buffer.length,
        startIdx,
        replayLen: toReplay.length,
        hasMoreAbove,
        priorSubscribers: this.subscribers.size,
      });
    }
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
        ev.type === "plan_approval_request" ||
        // A one-shot feedback nudge tied to a turn that already finished —
        // replaying it on reload would re-pop a stale survey.
        ev.type === "feedback_survey"
      )
        continue;
      fn(ev);
    }
    // Tell the client the replay window is over so it can anchor and arm
    // the "load older" sentinel.
    fn({ type: "replay_done", hasMoreAbove });
    // Rehydrate derived state that lives upstream of the tail window. A
    // session might have set its todos hundreds of turns ago, or — far
    // more commonly — its last user prompt is buried under a long tool
    // chain. Either way `replay_done` alone leaves the client without
    // the "what was I asking?" anchor. Both pieces of state ride on the
    // same snapshot event so reconnect paints them atomically.
    if (this.latestTodosSnapshot || this.latestUserPromptSnapshot) {
      fn({
        type: "session_snapshot",
        ...(this.latestTodosSnapshot ? { todos: this.latestTodosSnapshot } : {}),
        ...(this.latestUserPromptSnapshot
          ? { lastUserPrompt: this.latestUserPromptSnapshot }
          : {}),
      });
    }
    // Re-emit `ready` for tail-truncated sessions. `ready` is broadcast
    // exactly once at start() (sits at buffer index 0), so any session
    // with more turns than `tail` slices it off the replay window —
    // leaving the client stuck on the "starting" status indicator even
    // though the SDK Query is healthy. Same shape of bug the
    // `sendFreshTitle` path below works around for session_title.
    if (this.query) {
      fn({ type: "ready", sessionId: this.id, ...(this.agent ? { agent: this.agent } : {}) });
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
    // Re-emit the agent's effective working directory for the same
    // tail-truncation reason as `mode_changed`/`turn_status` above. The
    // `cwd_changed` event that moved the agent into a git worktree is
    // broadcast exactly once (deduped in `broadcastCwd`), so any session that
    // entered the worktree more than `tail` turns ago — or more than ~1000
    // events ago, past the buffer cap — slices it off the replay window and
    // the client never paints the "worktree" badge even though the agent is
    // still working outside the session root. `lastCwdBroadcast` is the
    // in-memory source of truth, so echo it here directly (no need to round
    // trip through `broadcastCwd`). Self-clearing still works: if the agent
    // has since returned to the root, `lastCwdBroadcast` equals the root and
    // the client's `worktreeBadge` renders nothing.
    if (this.lastCwdBroadcast) {
      fn({ type: "cwd_changed", cwd: this.lastCwdBroadcast });
    }
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
    // Rehydrate persisted subagent (Task) metadata + inner conversations.
    // These ride on transient SSE-only events absent from the JSONL, so a
    // session rebuilt from disk loses them; this repaints them from SQLite.
    void this.sendTaskSnapshot(fn);
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
   * True when the agent is blocked on an interactive prompt that only the
   * user can resolve — an AskUserQuestion form, a permission decision, or
   * a plan-mode approval. The idle reaper consults this so a session with
   * a pending prompt is never killed mid-question; reaping would resolve
   * the SDK's `canUseTool` promise as `{ behavior: "deny", message:
   * "Aborted" }`, writing an errored tool_result that — once on disk —
   * permanently hides the modal and the "Answer" pill from the user.
   *
   * Distinct from `getStatus()` because `turnInFlight` alone (a long-
   * running Bash, a slow tool) doesn't need a human in the loop; we
   * still want the reaper to clean those up so a runaway turn without a
   * watcher doesn't leak the SDK process forever.
   */
  hasPendingUserPrompts(): boolean {
    return (
      this.pendingPermissions.size > 0 ||
      this.pendingAskQuestions.size > 0 ||
      this.pendingPlans.size > 0
    );
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
    if (this.hasActiveSubagents()) return "running";
    return "idle";
  }

  /**
   * True if any tracked subagent (Task) is still doing work that the
   * session should be considered "busy" for. The SDK closes the parent
   * turn (`result` fires, `turnInFlight` flips to false) independently
   * of subagent activity — see the comment on the `result` handler in
   * `consume()` — so without this check a session with a live Explore /
   * subagent would read "Idle" in the StatusLine the instant the parent
   * agent's outer response completed, even though there's real work in
   * flight. Backgrounded Tasks (`run_in_background: true`) are excluded:
   * they're fire-and-forget by contract, and the parent has already
   * moved past them.
   */
  private hasActiveSubagents(): boolean {
    for (const meta of this.taskMetaById.values()) {
      if (meta.isBackgrounded) continue;
      if (meta.status === "running" || meta.status === "pending") return true;
    }
    return false;
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
      const info = local
        ? null
        : await getSessionInfo(this.id, { dir: this.cwd }).catch(() => null);
      // `resolveSessionTitle` returns ONLY trusted titles (DB local or
      // SDK customTitle). It never derives one from prompt text, so a
      // reload / late subscribe can no longer morph the title into the
      // last user message.
      const next = resolveSessionTitle({ local, info });
      if (next && next !== this.title) {
        // Title moved (e.g. TUI rename arrived after start()). Broadcast
        // to every subscriber and persist into the index.
        this.title = next;
        this.broadcast({ type: "session_title", title: next });
        upsertSession({
          id: this.id,
          cwd: this.cwd,
          model: this.model,
          title: next,
        }).catch(() => {});
      } else if (this.title) {
        // No movement, but the new subscriber may have missed the
        // original `session_title` broadcast (tail-pruned by the replay
        // window, or buffered before they connected). Echo the current
        // title just to them — `fn` is the subscriber callback the
        // caller handed us for this one connection, not the full
        // broadcast list.
        fn({ type: "session_title", title: this.title });
      }
      // else: no trusted title and no in-memory title — leave it alone,
      // the UI falls back to the id-prefix label.
    } catch {
      // non-fatal — banner stays empty, header still works
    }
  }

  /**
   * Last effective working directory broadcast to clients via `cwd_changed`.
   * Several independent signals can move it — the SDK's `CwdChanged` hook,
   * `WorktreeCreate`/`WorktreeRemove`, and the PreToolUse path heuristic — so
   * we dedupe against this single source of truth to avoid spamming the SSE
   * stream (and the replay buffer) with redundant events.
   */
  private lastCwdBroadcast: string | null = null;

  /**
   * Broadcast a `cwd_changed` only when the effective cwd actually moved.
   * Centralises the dedupe so every detector can call it freely; the client
   * paints the "worktree" badge whenever this differs from the session root
   * and self-clears when it returns to the root.
   */
  private broadcastCwd(cwd: string): void {
    if (!cwd || cwd === this.lastCwdBroadcast) return;
    this.lastCwdBroadcast = cwd;
    this.broadcast({ type: "cwd_changed", cwd });
  }

  private broadcast(event: ServerEvent): void {
    // Stamp SDK messages with an "observed at" time at this single funnel so
    // the value travels through the replay buffer — every late subscriber
    // (reload, tab-switch, second tab) sees the same time as the first one.
    // Disk-replay callers pre-set `at` from the JSONL `timestamp` field; live
    // sites leave it unset and we default to "now" here.
    if (event.type === "sdk" && event.at == null) {
      event = { ...event, at: Date.now() };
    }
    this.buffer.push(event);
    if (this.buffer.length > 1000) {
      this.bufferTrimmed = true;
      this.buffer.splice(0, this.buffer.length - 1000);
    }
    // Sniff for derived state we want to rehydrate on tab-switch / reload.
    // The tail-replay window can slice off the original tool_use that set
    // these, so we cache the latest payload server-side and replay it via
    // session_snapshot in subscribe().
    this.captureSnapshotState(event);
    // Sniff transient subagent (Task) state — token/tool/duration counters and
    // the inner conversation — and persist it on completion so it survives a
    // disk-rebuild of this session. See captureTaskState() + session-tasks-db.
    this.captureTaskState(event);
    for (const sub of this.subscribers) {
      try {
        sub(event);
      } catch {
        // ignore subscriber errors
      }
    }
    // Feed the workspace notification inbox. The bus filters/dedups internally
    // (subagent skip, kind whitelist, per-session mute, background-session
    // suppression) and swallows errors — failures here must never disrupt
    // the session flow.
    //
    // `hasSubscribers` tells the bus whether this session currently has any
    // live SSE client. When it doesn't (the user switched to another tab),
    // the bus drops session_idle / session_error notifications — they're
    // noise for a session the user isn't looking at. Actionable kinds still
    // ring regardless because the agent is blocked on them.
    void notificationBus.recordSessionEvent(this.cwd, this.id, event, {
      hasSubscribers: this.subscribers.size > 0,
      // Mirror `tabLabelFor`'s fallback so an untitled session still shows a
      // recognisable id-prefix instead of the raw cwd in the inbox.
      sessionTitle: this.title?.trim() || this.id.slice(0, 8),
    });
  }

  /**
   * Latest `todos` payload from a TodoWrite tool_use. Stored as raw
   * `unknown[]` because the client already knows how to coerce that shape;
   * keeping it untouched here means the snapshot is byte-identical with
   * what would be re-synthesised from the buffer.
   */
  private latestTodosSnapshot: unknown[] | null = null;
  private latestTodosSnapshotAt = -Infinity;
  /** Pending TaskCreate tool_use blocks awaiting their tool_result. */
  private pendingTaskCreates = new Map<string, { content: string; activeForm?: string }>();

  /**
   * Latest top-level user prompt (the real one the user typed, not a
   * tool_result wrapper). Tracked separately from the buffer so we can
   * replay it on attach even when a long trailing assistant/tool chain
   * has pushed the original event outside the requested tail window —
   * `subscribe()` emits it inside the `session_snapshot` event after
   * `replay_done`. Same shape of rehydration as the todos snapshot.
   */
  private latestUserPromptSnapshot: { uuid: string; text: string; at?: number } | null = null;

  private captureSnapshotState(event: ServerEvent): void {
    if (event.type !== "sdk") return;
    const m = event.message as {
      type?: string;
      uuid?: string;
      message?: { content?: unknown };
    };
    const parent = (event.message as { parent_tool_use_id?: string | null }).parent_tool_use_id;
    if (parent) return;
    // Real user prompt → cache for the rehydration snapshot. Skip
    // SDK-synthetic tool_result wrappers (same distinction as
    // `isRealUserPrompt` used by computeReplayWindow).
    //
    // Prefer the envelope's `at` over wall-clock now: disk-replay callers
    // (`Session.start` resume path, `resyncFromDisk`) pre-set `at` from the
    // JSONL `timestamp`, so the snapshot reflects when the user actually
    // sent the prompt rather than when we happened to re-broadcast it.
    // For live broadcasts the funnel in `broadcast()` already stamps `at`
    // to Date.now(), so the fallback is just belt-and-suspenders.
    if (m.type === "user") {
      const text = extractUserPromptText(m.message?.content);
      if (text && m.uuid) {
        const at =
          typeof event.at === "number" && Number.isFinite(event.at)
            ? event.at
            : Date.now();
        const prevAt = this.latestUserPromptSnapshot?.at ?? -Infinity;
        if (at >= prevAt) {
          this.latestUserPromptSnapshot = {
            uuid: m.uuid,
            text,
            at,
          };
        }
      }
      // TaskCreate tool_result — promote pending entry to snapshot with real id.
      const userContent = m.message?.content;
      if (Array.isArray(userContent)) {
        for (const raw of userContent as Array<{ type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }>) {
          if (raw?.type !== "tool_result") continue;
          const toolUseId = raw.tool_use_id;
          if (!toolUseId) continue;
          const pending = this.pendingTaskCreates.get(toolUseId);
          if (!pending) continue;
          this.pendingTaskCreates.delete(toolUseId);
          if (raw.is_error) {
            // Remove the temp entry from the snapshot on error.
            if (this.latestTodosSnapshot) {
              this.latestTodosSnapshot = this.latestTodosSnapshot.filter(
                (t) => (t as Record<string, unknown>).id !== toolUseId,
              );
            }
            continue;
          }
          // Extract result text (string or [{type:"text",text:...}] array).
          let resultText = "";
          if (typeof raw.content === "string") {
            resultText = raw.content;
          } else if (Array.isArray(raw.content)) {
            for (const c of raw.content as Array<{ type?: string; text?: string }>) {
              if (c?.type === "text" && c.text) resultText += c.text;
            }
          }
          try {
            const payload = JSON.parse(resultText) as { task?: { id?: string } };
            const realId = payload?.task?.id;
            if (realId && this.latestTodosSnapshot) {
              this.latestTodosSnapshot = this.latestTodosSnapshot.map((t) =>
                (t as Record<string, unknown>).id === toolUseId
                  ? { ...(t as Record<string, unknown>), id: realId }
                  : t,
              );
            }
          } catch {
            // Parsing failed; leave temp-id entry in place.
          }
        }
      }
      return;
    }
    if (m.type !== "assistant") return;
    const content = m.message?.content;
    if (!Array.isArray(content)) return;
    const at =
      typeof event.at === "number" && Number.isFinite(event.at)
        ? event.at
        : Date.now();
    for (const block of content as Array<{ type?: string; id?: string; name?: string; input?: unknown }>) {
      if (block?.type !== "tool_use") continue;

      // Worktree detection that survives a disk rebuild. The live PreToolUse
      // hook (signal #2 in start()) flags the worktree as edits execute, but
      // that hook does NOT re-fire when a session is rebuilt from its JSONL on
      // a server restart — so a session still working inside a worktree would
      // silently lose its badge after a restart. The mutating-file tool_use
      // blocks ARE in the replayed transcript, and `captureSnapshotState` runs
      // from `broadcast()` on both the live and disk-replay paths, so re-run
      // the same `worktreeRootFromPath` heuristic here. Set-only by design,
      // mirroring the live hook: "agent returned to root" is detected by the
      // SDK's `CwdChanged` hook, which isn't replayed from disk. The value is
      // carried to late subscribers by the `lastCwdBroadcast` re-emit in
      // `subscribe()` (the buffered `cwd_changed` itself gets trimmed).
      if (
        block.name === "Edit" ||
        block.name === "Write" ||
        block.name === "MultiEdit" ||
        block.name === "NotebookEdit"
      ) {
        const inp =
          (block.input as { file_path?: unknown; notebook_path?: unknown } | null) ?? {};
        const target =
          typeof inp.file_path === "string"
            ? inp.file_path
            : typeof inp.notebook_path === "string"
            ? inp.notebook_path
            : null;
        if (target) {
          const wt = worktreeRootFromPath(target);
          if (wt) this.broadcastCwd(wt);
        }
        continue;
      }

      // TodoWrite — full snapshot replacement (legacy; kept for backward compat).
      if (block.name === "TodoWrite") {
        const raw = (block.input as { todos?: unknown } | null)?.todos;
        if (Array.isArray(raw)) {
          if (at >= this.latestTodosSnapshotAt) {
            this.latestTodosSnapshot = raw;
            this.latestTodosSnapshotAt = at;
          }
        }
        continue;
      }

      // TaskCreate — add pending entry to snapshot (keyed by tool_use_id);
      // real id arrives via the matching tool_result.
      if (block.name === "TaskCreate" && typeof block.id === "string") {
        if (this.pendingTaskCreates.has(block.id)) continue; // dedup on replay
        // Also skip if already promoted (replayed tool_use after tool_result).
        if (this.latestTodosSnapshot?.some((t) => (t as Record<string, unknown>).id === block.id)) continue;
        const inp = (block.input as { subject?: unknown; activeForm?: unknown }) ?? {};
        const content2 = typeof inp.subject === "string" ? inp.subject : "";
        this.pendingTaskCreates.set(block.id, {
          content: content2,
          activeForm: typeof inp.activeForm === "string" ? inp.activeForm : undefined,
        });
        if (!this.latestTodosSnapshot) this.latestTodosSnapshot = [];
        this.latestTodosSnapshot = [
          ...this.latestTodosSnapshot,
          {
            id: block.id,
            content: content2,
            status: "pending",
            activeForm: typeof inp.activeForm === "string" ? inp.activeForm : undefined,
          },
        ];
        if (at >= this.latestTodosSnapshotAt) this.latestTodosSnapshotAt = at;
        continue;
      }

      // TaskUpdate — apply status/subject changes in-place by taskId.
      if (block.name === "TaskUpdate" && this.latestTodosSnapshot) {
        const inp = (block.input as { taskId?: unknown; subject?: unknown; status?: unknown }) ?? {};
        const taskId = typeof inp.taskId === "string" ? inp.taskId : null;
        if (!taskId) continue;
        const status = typeof inp.status === "string" ? inp.status : null;
        if (status === "deleted") {
          this.latestTodosSnapshot = this.latestTodosSnapshot.filter(
            (t) => (t as Record<string, unknown>).id !== taskId,
          );
        } else {
          this.latestTodosSnapshot = this.latestTodosSnapshot.map((t) => {
            const entry = t as Record<string, unknown>;
            if (entry.id !== taskId) return t;
            const updated = { ...entry };
            if (status) updated.status = status;
            if (typeof inp.subject === "string" && inp.subject) updated.content = inp.subject;
            return updated;
          });
        }
        continue;
      }
    }
  }

  /**
   * In-memory accumulators for subagent (Task) state observed on the wire.
   * Task metadata is keyed by the SDK `task_id`; the inner conversation is
   * keyed by the parent Task `tool_use_id` (== the subagent messages'
   * `parent_tool_use_id`). Both are flushed to SQLite atomically on
   * `task_notification` (completion) by `persistTask`, then replayed via
   * `task_snapshot` in `subscribe()`. Purely live state — rebuilt from the
   * DB on the next session, never read back here.
   */
  private taskMetaById = new Map<string, TaskSnapshotEntry>();
  private subagentMsgsByToolUseId = new Map<string, Array<{ at?: number; message: unknown }>>();
  /** Cap inner-message retention per task so a marathon subagent can't bloat one row. */
  private static readonly MAX_INNER_MESSAGES = 500;
  /**
   * Throttle the live-persist path so a chatty subagent doesn't hammer SQLite.
   * Keyed by `taskId` → last persist timestamp; we only flush again when this
   * cadence has elapsed. Terminal events (`task_notification`) bypass the
   * throttle — they always persist the final state.
   */
  private taskPersistThrottleAt = new Map<string, number>();
  private static readonly TASK_PERSIST_THROTTLE_MS = 2_000;

  /**
   * Sniff subagent (Task) state out of the broadcast stream. Mirrors the
   * client reducer in `lib/client/use-session.ts` (task_started / task_progress
   * / task_updated / task_notification + `parent_tool_use_id` messages), but
   * its sole job is to persist that state on completion. Best-effort and
   * side-effect-free beyond the in-memory maps + the DB write it kicks off.
   */
  private captureTaskState(event: ServerEvent): void {
    if (event.type !== "sdk") return;
    const msg = event.message as {
      type?: string;
      subtype?: string;
      parent_tool_use_id?: string | null;
      task_id?: string;
      tool_use_id?: string;
      description?: string;
      task_type?: string;
      workflow_name?: string;
      summary?: string;
      status?: string;
      patch?: {
        status?: string;
        description?: string;
        error?: string;
        is_backgrounded?: boolean;
      };
      usage?: { total_tokens?: number; tool_uses?: number; duration_ms?: number };
    };

    // Subagent inner message — accumulate the raw envelope under its parent
    // tool_use id so we can replay the conversation faithfully.
    const parent = msg.parent_tool_use_id ?? null;
    if (parent) {
      const list = this.subagentMsgsByToolUseId.get(parent) ?? [];
      list.push({ at: event.at, message: event.message });
      if (list.length > Session.MAX_INNER_MESSAGES) {
        list.splice(0, list.length - Session.MAX_INNER_MESSAGES);
      }
      this.subagentMsgsByToolUseId.set(parent, list);
      // Flush partial inner-message state to SQLite (throttled). This is
      // what makes mid-run reloads survive a server restart / idle-reap:
      // the row gets the latest inner conversation snapshot every couple
      // of seconds while the subagent is alive, instead of only at
      // task_notification (completion).
      this.persistTaskForToolUse(parent, { throttle: true });
      return;
    }

    if (msg.type !== "system" || !msg.task_id) return;
    const taskId = msg.task_id;
    switch (msg.subtype) {
      case "task_started": {
        const meta: TaskSnapshotEntry = {
          taskId,
          toolUseId: msg.tool_use_id,
          description: msg.description,
          taskType: msg.task_type,
          workflowName: msg.workflow_name,
          status: "running",
          innerMessages: [],
        };
        this.taskMetaById.set(taskId, meta);
        // Persist the row immediately so a reload during the very first
        // few seconds of a subagent run still finds metadata in the DB
        // (description, tool_use_id, status="running") — without this the
        // task_snapshot would be empty until the first throttle window
        // elapsed for inner messages, or until the terminal
        // task_notification. Unthrottled so the row exists from t=0.
        this.persistTask(meta);
        // A fresh running subagent is part of `getStatus()` now — the
        // outer parent turn can close (`result` fires) while this Task
        // is still alive, so we have to re-evaluate. See
        // `hasActiveSubagents()`. Re-entry through `broadcast()` is safe
        // because `captureTaskState()` ignores non-`sdk` events (the
        // `turn_status` short-circuits on its `event.type !== "sdk"`
        // guard at the top of this method).
        this.broadcastTurnStatusIfChanged();
        break;
      }
      case "task_progress": {
        const meta = this.taskMetaById.get(taskId);
        if (!meta) break;
        if (msg.description) meta.description = msg.description;
        if (msg.summary) meta.summary = msg.summary;
        if (msg.usage?.total_tokens != null) meta.totalTokens = msg.usage.total_tokens;
        if (msg.usage?.tool_uses != null) meta.toolUses = msg.usage.tool_uses;
        if (msg.usage?.duration_ms != null) meta.durationMs = msg.usage.duration_ms;
        // Periodic AI summary / counter update — flush the updated meta
        // and the latest inner-message accumulator to SQLite. Throttled
        // so a chatty subagent doesn't generate a write per progress
        // tick; the terminal task_notification path is unthrottled and
        // always writes the final state.
        this.persistTask(meta, { throttle: true });
        break;
      }
      case "task_updated": {
        const meta = this.taskMetaById.get(taskId);
        if (!meta) break;
        if (msg.patch?.status) meta.status = msg.patch.status;
        if (msg.patch?.description) meta.description = msg.patch.description;
        if (msg.patch?.error) meta.error = msg.patch.error;
        // Backgrounded tasks must be excluded from `hasActiveSubagents()` —
        // their fire-and-forget contract means a Task can be alive while
        // the session is genuinely idle (the parent already moved on).
        // Same re-entry note as `task_started`.
        if (msg.patch?.is_backgrounded != null) meta.isBackgrounded = msg.patch.is_backgrounded;
        // Persist immediately on state changes — a backgrounded / failed
        // task may not get another touch before the user reloads.
        this.persistTask(meta);
        this.broadcastTurnStatusIfChanged();
        break;
      }
      case "task_notification": {
        const meta = this.taskMetaById.get(taskId) ?? {
          taskId,
          status: msg.status ?? "completed",
          innerMessages: [],
        };
        if (msg.status) meta.status = msg.status;
        if (msg.summary) meta.summary = msg.summary;
        if (msg.usage?.total_tokens != null) meta.totalTokens = msg.usage.total_tokens;
        if (msg.usage?.tool_uses != null) meta.toolUses = msg.usage.tool_uses;
        if (msg.usage?.duration_ms != null) meta.durationMs = msg.usage.duration_ms;
        this.taskMetaById.set(taskId, meta);
        this.persistTask(meta);
        // Terminal subagent event — if this was the last non-backgrounded
        // task running after the parent already closed, `getStatus()`
        // flips back to "idle" here. Without this broadcast the status
        // dot and StatusLine would stay stuck on "running".
        this.broadcastTurnStatusIfChanged();
        break;
      }
      default:
        break;
    }
  }

  /**
   * Snapshot the task (meta + captured inner conversation) into SQLite.
   *
   * `throttle: true` skips the write if `TASK_PERSIST_THROTTLE_MS` hasn't
   * elapsed since the last persist for this taskId — used on the hot path
   * (each inner subagent message, each `task_progress`) so we don't
   * generate one DB write per token. Unthrottled callers (`task_started`,
   * `task_updated`, `task_notification`) always write — those are state
   * transitions whose ordering matters more than write volume.
   */
  private persistTask(meta: TaskSnapshotEntry, opts?: { throttle?: boolean }): void {
    if (opts?.throttle) {
      const last = this.taskPersistThrottleAt.get(meta.taskId) ?? 0;
      const now = Date.now();
      if (now - last < Session.TASK_PERSIST_THROTTLE_MS) return;
      this.taskPersistThrottleAt.set(meta.taskId, now);
    } else {
      // Reset the throttle window on unthrottled writes too, so a flurry
      // of throttled calls right after a state transition doesn't
      // immediately fire a redundant second write.
      this.taskPersistThrottleAt.set(meta.taskId, Date.now());
    }
    const inner = meta.toolUseId
      ? this.subagentMsgsByToolUseId.get(meta.toolUseId) ?? []
      : [];
    const entry: TaskSnapshotEntry = { ...meta, innerMessages: inner };
    void saveSessionTask(this.cwd, this.id, entry).catch(() => {
      // best-effort — a failed persist just means this task won't survive a
      // disk-rebuild; never disrupt the session over it.
    });
  }

  /**
   * Sibling to `persistTask` keyed on the parent `tool_use_id` instead of
   * the SDK task id. Used from the subagent-inner-message hot path, where
   * we only have the `parent_tool_use_id` from the envelope. Resolves to
   * the matching `taskMetaById` entry and delegates; no-ops if we haven't
   * seen `task_started` yet for that tool_use (which would mean the
   * envelope ordering put inner messages before the task header — rare,
   * but the next inner message or `task_started` will catch up).
   */
  private persistTaskForToolUse(toolUseId: string, opts?: { throttle?: boolean }): void {
    for (const meta of this.taskMetaById.values()) {
      if (meta.toolUseId !== toolUseId) continue;
      this.persistTask(meta, opts);
      return;
    }
  }

  /**
   * Best-effort replay of persisted subagent (Task) state to a freshly
   * attached subscriber. Mirrors `sendFreshTitle` — fired async from
   * `subscribe()` so the synchronous buffer replay isn't blocked on a DB
   * read. The client merges idempotently and prefers anything already
   * restored from the buffer, so this only repaints sessions rebuilt from
   * disk (idle-reaped / server-restarted) where the live data was lost.
   */
  private async sendTaskSnapshot(fn: Subscriber): Promise<void> {
    try {
      const tasks = await listSessionTasks(this.cwd, this.id);
      if (tasks.length === 0) return;
      if (!this.subscribers.has(fn)) return; // unsubscribed during the await
      fn({ type: "task_snapshot", tasks });
    } catch {
      // non-fatal — task counters/transcripts simply stay blank on this load
    }
  }

  private async consume(): Promise<void> {
    if (!this.query) return;
    // Track whether the SDK ever emitted a `result` message during this
    // iterator's lifetime, and whether we already broadcast an `error`
    // from the catch. Both feed the synthetic-idle decision in `finally`:
    // we only want to invent a `session_idle` notification when the
    // iterator ended WITHOUT a real terminal event AND without us already
    // having surfaced an error (which would double-notify). See
    // docs/notifications.md §10.2.B.
    let sawResult = false;
    let sawError = false;
    try {
      for await (const message of this.query as AsyncIterable<SDKMessage>) {
        this.broadcast({ type: "sdk", message });
        // Auto-recover from the thinking-block replay 400. The SDK surfaces it
        // as a synthetic assistant "API Error: …" message (not a thrown
        // error), then ends the turn — leaving the poisoned turn as the
        // conversation tail so every future prompt re-fails. Detect it here
        // and schedule an in-place rewind+retry; the guard inside makes it
        // fire at most once per query lifetime.
        if (thinkingReplayErrorFrom(message)) {
          this.scheduleThinkingReplayRecovery();
        }
        // Side-effect: keep the per-session ScheduledLoops map in sync with
        // any cron/wake-up tool_use + tool_result blocks observed on the
        // wire. Mirror of the client-side reducer in `lib/client/use-session.ts` —
        // duplicated rather than shared because the client and server
        // observe different events (SSE vs raw SDK).
        this.trackScheduledLoops(message);
        // B2.3: track every file the model has Read this session, and re-seed
        // the SDK's readFileState cache after each `compact_boundary` so a
        // subsequent Edit doesn't fail "file not read yet" just because
        // compaction stripped the prior Read tool_use from the conversation.
        // Path extraction lives in `lib/shared/read-tool-paths.ts` (unit-tested);
        // the re-seed is fire-and-forget so it never blocks the iterator.
        for (const p of extractReadPaths(message)) this.recentReadPaths.add(p);
        const sysMsg = message as { type?: string; subtype?: string };
        if (sysMsg.type === "system" && sysMsg.subtype === "compact_boundary") {
          void this.reseedReadPathsAfterCompact();
        }
        // Bump the sessions index on each completed turn so list views can
        // sort newest-active first. `result` is the SDK's per-turn done
        // marker — independent of subagent activity.
        if ((message as { type?: string }).type === "result") {
          sawResult = true;
          this.turnInFlight = false;
          this.broadcastTurnStatusIfChanged();
          // A successful turn clears the consecutive thinking-replay recovery
          // budget, so a later, unrelated 400 can still auto-recover even after
          // earlier recoveries this session. Only `subtype: "success"` resets —
          // a poisoned turn never produces one — so a tight recover→re-poison
          // loop (no success between) still trips the cap. Dynamic import keeps
          // the session ⇄ session-manager cycle out of the static graph.
          if ((message as { subtype?: string }).subtype === "success") {
            void import("./session-manager").then(({ sessionManager }) =>
              sessionManager.noteThinkingRecoverySuccess(this.id),
            );
          }
          void touchSession(this.cwd, this.id).catch(() => {
            // index update is non-critical; never crash consume() over it
          });
          // Occasionally nudge for feedback (CLI-style survey). Fire-and-
          // forget so the settings read never blocks the turn loop.
          void this.maybeOfferFeedbackSurvey(message);
        }
      }
    } catch (err) {
      // Distinguish a reaper-initiated abort from any other failure. When
      // the SessionManager's idle reaper fires `session.end()`, it calls
      // `abortController.abort()`, which makes the SDK's iterator throw
      // "Claude Code process aborted by user" — but the user wasn't doing
      // anything; they were AWAY, that's why the reaper fired. Surfacing
      // that as a `session_error` notification gives the user a phantom
      // "something broke" alert when they come back. Skip the broadcast
      // entirely in that case so the bus never sees an error event.
      //
      // The user-initiated stop path goes through `query.interrupt()`
      // (not abortController), so `signal.aborted` stays false and the
      // broadcast still fires — picked up by the bus, then auto-read on
      // arrival by the NotificationsProvider gate (same-session-visible
      // mirrors `useNotifications.notify`'s OS-popup suppression).
      if (!this.abortController.signal.aborted) {
        const message = err instanceof Error ? err.message : String(err);
        this.broadcast({ type: "error", message });
        sawError = true;
      }
    } finally {
      this.done = true;
      // Defensive: if the SDK iterator returned without ever emitting a
      // `result` (crash / abort), the turn would otherwise look forever
      // "running" to the tabs strip. Drain pending agent-decision maps
      // BEFORE flipping `turnInFlight` so `getStatus()`'s pending-map
      // checks don't keep the session stuck in "running" even after the
      // iterator has clearly ended. Without this drain, a permission /
      // ask-user / plan-mode request whose abort listener didn't fire
      // (the per-tool `ctx.signal` cascade is owned by the SDK and isn't
      // guaranteed to propagate to every listener on every exit path)
      // would leave a phantom entry, getStatus() would still return
      // "running", broadcastTurnStatusIfChanged would dedupe-and-skip,
      // and the session would be silently stuck — exactly the failure
      // mode documented in docs/notifications.md §10.2.A.
      this.drainPendingDecisions("Aborted");
      this.turnInFlight = false;
      this.broadcastTurnStatusIfChanged();

      // Synthetic session_idle for the §10.2.B case: the SDK iterator ended
      // cleanly without ever emitting a terminal `result` message, the user
      // didn't stop or reap the session (signal not aborted), and we didn't
      // already broadcast an error (which would map to session_error). In
      // that gap, neither path fires a notification — the status flips, but
      // the user gets nothing. Route a synthetic `sdk` result event through
      // the bus's public API so it picks up every downstream gate (master
      // switch, kind enablement, per-session mute, background suppression,
      // and crucially the `lastUserInputAt` gate — which still suppresses
      // for resumed / replayed sessions where the user never typed in this
      // process). The event never reaches subscribers or the replay buffer:
      // calling the bus directly keeps disk/buffer parity intact.
      if (
        !sawResult &&
        !sawError &&
        !this.abortController.signal.aborted
      ) {
        void notificationBus.recordSessionEvent(
          this.cwd,
          this.id,
          {
            type: "sdk",
            message: { type: "result" } as unknown as SDKMessage,
          },
          {
            hasSubscribers: this.subscribers.size > 0,
            sessionTitle: this.title?.trim() || this.id.slice(0, 8),
          },
        );
      }
    }
  }
}
