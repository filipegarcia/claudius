/**
 * Pure (React-free) logic behind the `@`-mention picker. Kept in a plain `.ts`
 * so the node-only vitest suite can import the real symbols without dragging in
 * React / lucide-react. The `.tsx` shell owns fetching + rendering; the
 * token/parse/filter contracts that the SDK `@agent-name` syntax depends on
 * live here and are unit-tested.
 */

/** SDK-loaded agent, as returned by `/api/sessions/[id]/agents` (`d.agents`). */
export type Agent = { name: string; description?: string; model?: string };

/**
 * Unified picker row. Files keep their relative path; agents carry the bare
 * name (the `@agent-` prefix lives in the inserted token, not the model).
 */
export type PickerItem =
  | { kind: "file"; relPath: string; type: "file" | "dir" }
  | { kind: "agent"; name: string; description?: string; model?: string };

export const AGENT_PREFIX = "agent-";

/** Max rows the picker ever shows for either source. */
export const PICKER_LIMIT = 30;

/**
 * Split the active `@`-token (the `@` is already stripped upstream by
 * PromptInput's `refreshPickerState`) into a file-vs-agent decision plus the
 * substring filter. A bare `agent-` is still agent mode with an empty filter;
 * `agent` (no hyphen) and any other text stay in file mode.
 */
export function parseAtMentionQuery(query: string): { agentMode: boolean; filter: string } {
  const agentMode = query.startsWith(AGENT_PREFIX);
  return { agentMode, filter: agentMode ? query.slice(AGENT_PREFIX.length) : "" };
}

/**
 * The token body passed to `onSelect` (no leading `@`): files keep their
 * relative path; agents become `agent-<name>` so the parent's `insertAtMention`
 * wraps them to `@agent-<name> ` unchanged — matching the SDK `@agent-name`
 * directed-delegation syntax.
 */
export function itemToken(item: PickerItem): string {
  return item.kind === "agent" ? `${AGENT_PREFIX}${item.name}` : item.relPath;
}

/**
 * Case-insensitive substring match over name OR description, sorted by name,
 * capped at {@link PICKER_LIMIT}. Client-side filtering (the agents list is
 * fetched once per session) so this runs per keystroke.
 */
export function filterAgents(agents: Agent[], filter: string): PickerItem[] {
  const needle = filter.toLowerCase();
  return agents
    .filter(
      (a) =>
        a.name.toLowerCase().includes(needle) ||
        (a.description?.toLowerCase().includes(needle) ?? false),
    )
    .sort((a, b) => a.name.localeCompare(b.name))
    .map<PickerItem>((a) => ({
      kind: "agent",
      name: a.name,
      description: a.description,
      model: a.model,
    }))
    .slice(0, PICKER_LIMIT);
}
