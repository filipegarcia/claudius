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
  fallbackModel?: string;
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
    fallbackModel: request.fallbackModel ?? defaults.fallbackModel,
    permissionMode: request.permissionMode ?? defaults.permissionMode,
  };
}
