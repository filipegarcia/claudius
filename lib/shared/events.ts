// Event envelope sent from server -> browser over SSE.
// Mirrors SDK message types but adds a few synthetic events the UI needs
// (permission_request, error, ready).

import type { SDKMessage, PermissionMode } from "@anthropic-ai/claude-agent-sdk";

export type PermissionRequestEvent = {
  type: "permission_request";
  requestId: string;
  toolName: string;
  toolUseId: string;
  input: Record<string, unknown>;
  title?: string;
  description?: string;
  displayName?: string;
};

export type SessionReadyEvent = {
  type: "ready";
  sessionId: string;
};

export type SessionErrorEvent = {
  type: "error";
  message: string;
};

export type ModeChangedEvent = {
  type: "mode_changed";
  mode: PermissionMode;
};

export type ModelChangedEvent = {
  type: "model_changed";
  model?: string;
};

export type ReplayDoneEvent = {
  type: "replay_done";
  hasMoreAbove: boolean;
};

export type SessionTitleEvent = {
  type: "session_title";
  title?: string;
};

/**
 * Per-option choice in an AskUserQuestion form.
 * Mirrors the SDK's AskUserQuestionInput option shape; `preview` is HTML
 * because we set toolConfig.askUserQuestion.previewFormat = 'html'.
 */
export type AskQuestionOption = {
  label: string;
  description: string;
  /** HTML string the model emits to compare options. May be empty/unset. */
  preview?: string;
};

export type AskQuestion = {
  question: string;
  /** Short chip label (≤ 12 chars). */
  header: string;
  options: AskQuestionOption[];
  multiSelect: boolean;
};

/**
 * The agent invoked the built-in AskUserQuestion tool. The browser should
 * render a form, collect the user's choices, and POST them to the
 * `ask-answer` endpoint with the requestId echoed.
 */
export type AskUserQuestionEvent = {
  type: "ask_user_question";
  requestId: string;
  toolUseId: string;
  questions: AskQuestion[];
};

/**
 * The agent invoked ExitPlanMode to surface a plan for the user to approve.
 * Routed through canUseTool, so the browser must POST a decision back to the
 * `plan` endpoint to unblock the SDK — accepting it also flips the session
 * out of plan mode.
 */
export type PlanApprovalRequestEvent = {
  type: "plan_approval_request";
  requestId: string;
  toolUseId: string;
  plan: string;
  raw?: Record<string, unknown>;
};

export type PlanDecision =
  | { kind: "accept" }
  | { kind: "reject"; message?: string };

export type PlanDecisionSubmission = {
  requestId: string;
  decision: PlanDecision;
};

/** One answer per question, in the same order as `questions`. */
export type AskAnswer = {
  /** For single-select: the chosen option label, or null when picking "Other". */
  label?: string | null;
  /** For multi-select: the chosen option labels. */
  selected?: string[];
  /** Free-text "Other" — the form's escape hatch. */
  custom?: string;
};

export type AskAnswerSubmission = {
  requestId: string;
  answers: AskAnswer[];
};

export type ServerEvent =
  | { type: "sdk"; message: SDKMessage }
  | PermissionRequestEvent
  | SessionReadyEvent
  | SessionErrorEvent
  | ModeChangedEvent
  | ModelChangedEvent
  | ReplayDoneEvent
  | SessionTitleEvent
  | AskUserQuestionEvent
  | PlanApprovalRequestEvent;

export type PermissionDecision =
  | { kind: "allow_once" }
  | { kind: "allow_always_session" }
  | { kind: "allow_always_save"; destination: "userSettings" | "projectSettings" | "localSettings" }
  | { kind: "deny"; message?: string };

export type CreateSessionRequest = {
  cwd?: string;
  model?: string;
  permissionMode?: PermissionMode;
  /** If set, resume an existing session by id. */
  resume?: string;
  /** When resuming, only replay messages up to and including this message uuid. */
  resumeSessionAt?: string;
};

export type AttachedImage = {
  /** base64 (no data: prefix). */
  data: string;
  /** e.g. "image/png" */
  mediaType: string;
  /**
   * Per-prompt ordinal that matches the `[Image #N]` token in the text. Required
   * for the server to interleave the right image at the right token position.
   */
  ordinal?: number;
};

export type SendInputRequest = {
  text: string;
  images?: AttachedImage[];
  /**
   * Client-minted uuid for this user message. Pinning it from the client lets
   * us:
   *   1. Broadcast the message into the session's SSE buffer with a stable id
   *      so other tabs (and reload-of-this-tab) see user history alongside
   *      assistant replies. The SDK doesn't echo user inputs back through its
   *      iterator, so without this the buffer would only ever contain
   *      assistant/result events.
   *   2. Forward the same id into the SDK's inputQueue, so the JSONL on disk
   *      uses it too — keeping `loadOlder`'s `?before=<uuid>` cursor in sync
   *      with the in-memory buffer.
   *   3. Dedupe against the optimistic local add (which already mints a uuid
   *      via crypto.randomUUID()) when the broadcast echoes back over SSE.
   */
  uuid?: string;
};
