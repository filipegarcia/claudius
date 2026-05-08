import { randomUUID } from "node:crypto";
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
import { AsyncQueue } from "./async-queue";
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
  private pendingPermissions = new Map<string, PendingPermission>();
  private pendingAskQuestions = new Map<string, PendingAskQuestion>();
  private done = false;

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

          ctx.signal.addEventListener("abort", () => {
            const p = this.pendingAskQuestions.get(requestId);
            if (!p) return;
            this.pendingAskQuestions.delete(requestId);
            p.resolve({ behavior: "deny", message: "Aborted" });
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

      ctx.signal.addEventListener("abort", () => {
        const pending = this.pendingPermissions.get(requestId);
        if (!pending) return;
        this.pendingPermissions.delete(requestId);
        pending.resolve({ behavior: "deny", message: "Aborted" });
      });
    });
  };

  resolvePermission(requestId: string, decision: PermissionDecision): boolean {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return false;
    this.pendingPermissions.delete(requestId);

    if (decision.kind === "deny") {
      pending.resolve({ behavior: "deny", message: decision.message ?? "User denied" });
      return true;
    }

    const result: PermissionResult = { behavior: "allow" };
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
    return true;
  }

  /**
   * Resolve a pending AskUserQuestion form. The SDK's tool-result protocol
   * for this tool eats `updatedInput.answers` from the canUseTool reply —
   * so by encoding the user's selections there we feed them straight into
   * what the model sees as the tool's output.
   *
   * Returns false if the requestId is unknown (e.g. duplicate submit, or
   * the agent already aborted).
   */
  submitAskAnswer(requestId: string, answers: AskAnswer[]): boolean {
    const pending = this.pendingAskQuestions.get(requestId);
    if (!pending) return false;
    this.pendingAskQuestions.delete(requestId);

    // Pad/truncate so we always send exactly one answer per question — the
    // SDK is stricter with structured input than free-form tool output.
    const padded: AskAnswer[] = pending.questions.map((_, i) => answers[i] ?? {});

    pending.resolve({
      behavior: "allow",
      updatedInput: { answers: padded },
    });
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
  }

  subscribe(fn: Subscriber, opts?: { tail?: number }): () => void {
    const tail = opts?.tail;
    let toReplay: ServerEvent[] = this.buffer;
    let hasMoreAbove = false;
    if (typeof tail === "number" && tail > 0) {
      // Find indexes of top-level (non-subagent) assistant/user messages.
      const turnIdx: number[] = [];
      for (let i = 0; i < this.buffer.length; i++) {
        const ev = this.buffer[i];
        if (ev.type !== "sdk") continue;
        const m = ev.message as { type?: string; parent_tool_use_id?: string | null };
        if (m.type !== "assistant" && m.type !== "user") continue;
        if (m.parent_tool_use_id) continue;
        turnIdx.push(i);
      }
      const skip = Math.max(0, turnIdx.length - tail);
      if (skip > 0) {
        toReplay = this.buffer.slice(turnIdx[skip]);
        hasMoreAbove = true;
      }
    }
    for (const ev of toReplay) fn(ev);
    // Tell the client the replay window is over so it can anchor and arm
    // the "load older" sentinel.
    fn({ type: "replay_done", hasMoreAbove });
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  private broadcast(event: ServerEvent): void {
    this.buffer.push(event);
    if (this.buffer.length > 1000) this.buffer.splice(0, this.buffer.length - 1000);
    for (const sub of this.subscribers) {
      try {
        sub(event);
      } catch {
        // ignore subscriber errors
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
