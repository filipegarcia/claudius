/**
 * Claudius registers one in-process (SDK) MCP server, `claudius_goal`, in the
 * `mcpServers` option at spawn. Since SDK 0.3.323 `Query.setMcpServers()` is
 * documented to replace "all in-process SDK servers (including any passed in
 * the `mcpServers` option)" with the payload — so a dynamic-servers call that
 * doesn't name `claudius_goal` would silently drop the goal tool. These pure
 * helpers keep it in every payload and out of the user-facing add/remove delta.
 */
export const GOAL_MCP_SERVER_NAME = "claudius_goal";

/** `servers` plus the in-process goal server (ours wins on a name clash). */
export function withGoalMcpServer<T>(servers: Record<string, T>, goal: T): Record<string, T> {
  return { ...servers, [GOAL_MCP_SERVER_NAME]: goal };
}

/** Drop the goal server from an `added` / `removed` list — it's plumbing, not a user server. */
export function withoutGoalMcpServer(names: string[]): string[] {
  return names.filter((n) => n !== GOAL_MCP_SERVER_NAME);
}
