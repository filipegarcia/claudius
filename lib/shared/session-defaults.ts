import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";

/**
 * The session-config fields a workspace can provide a default for and a
 * create-session request can override. Kept narrow — `cwd`/`resume` have their
 * own (more involved) resolution in the route and aren't part of this merge.
 */
export type SessionDefaults = {
  model?: string;
  agent?: string;
  maxBudgetUsd?: number;
  taskBudgetTokens?: number;
  maxTurns?: number;
  fallbackModel?: string;
  sandboxEnabled?: boolean;
  sandboxFilesystemDisabled?: boolean;
  enable1mContext?: boolean;
  persistSession?: boolean;
  additionalDirectories?: string[];
  systemPromptAppend?: string;
  planModeInstructions?: string;
  permissionMode?: PermissionMode;
};

/**
 * Merge per-workspace defaults with an explicit create-session request.
 *
 * Spec rule (mirrors the route comment): `effective = { ...defaults, ...request }`
 * — i.e. an explicit field in the request always wins, and the workspace
 * default only fills the gap. Implemented as `request.x ?? defaults.x` so an
 * absent (`undefined`) request field falls through to the default while an
 * explicit value (including an intentional empty string) is preserved.
 *
 * Note: `agent` carries a semantic side-effect downstream — when the SDK
 * applies `Options.agent`, the agent's own model overrides `model`. This merge
 * doesn't try to reconcile that; it just resolves which agent/model were
 * requested. The precedence lives in the SDK.
 */
export function mergeSessionDefaults(
  request: SessionDefaults,
  defaults: SessionDefaults,
): SessionDefaults {
  return {
    model: request.model ?? defaults.model,
    agent: request.agent ?? defaults.agent,
    maxBudgetUsd: request.maxBudgetUsd ?? defaults.maxBudgetUsd,
    taskBudgetTokens: request.taskBudgetTokens ?? defaults.taskBudgetTokens,
    maxTurns: request.maxTurns ?? defaults.maxTurns,
    fallbackModel: request.fallbackModel ?? defaults.fallbackModel,
    sandboxEnabled: request.sandboxEnabled ?? defaults.sandboxEnabled,
    sandboxFilesystemDisabled:
      request.sandboxFilesystemDisabled ?? defaults.sandboxFilesystemDisabled,
    enable1mContext: request.enable1mContext ?? defaults.enable1mContext,
    persistSession: request.persistSession ?? defaults.persistSession,
    additionalDirectories: request.additionalDirectories ?? defaults.additionalDirectories,
    systemPromptAppend: request.systemPromptAppend ?? defaults.systemPromptAppend,
    planModeInstructions: request.planModeInstructions ?? defaults.planModeInstructions,
    permissionMode: request.permissionMode ?? defaults.permissionMode,
  };
}
