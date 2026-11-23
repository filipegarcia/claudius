/**
 * CC 2.1.323 parity — "Fixed a collapsed tool call looking as if it ran after
 * you rejected it with a reason: it now shows 'Not run · rejected'".
 *
 * The engine stamps each error tool_result on the wrapper `SDKUserMessage`
 * with an @internal `tool_result_meta: [{ id, non_execution_kind }]`. A
 * terminal rejection is `user-rejected`. A host's `canUseTool` deny, which is
 * how Claudius's permission card answers, arrives as a `permissionPromptTool`
 * decision, so the bundled 2.1.323 engine (`Yfe`) stamps it
 * `permission-rule`, the same kind as a settings deny rule. Only Claudius's
 * server knows which tool-use ids the *user* denied, so it re-stamps those
 * results `user-rejected` before broadcasting. The client then renders them
 * in the dim "not run" style (CC 2.1.296) labelled "Not run · rejected".
 */

/** The `non_execution_kind` the CLI renders as "Not run · rejected". */
export const USER_REJECTED_KIND = "user-rejected";

type MetaEntry = { id?: unknown; non_execution_kind?: unknown; [k: string]: unknown };

/**
 * Returns `message` with `tool_result_meta` marking every error tool_result
 * whose `tool_use_id` is in `rejectedIds` as `user-rejected`, and removes the
 * stamped ids from `rejectedIds`. Returns the same object when nothing
 * matches. Pure apart from that set mutation, and never mutates `message`.
 */
export function stampUserRejectedToolResults<T>(message: T, rejectedIds: Set<string>): T {
  if (rejectedIds.size === 0) return message;
  const m = message as { type?: unknown; message?: { content?: unknown }; tool_result_meta?: unknown };
  if (!m || m.type !== "user") return message;
  const content = m.message?.content;
  if (!Array.isArray(content)) return message;
  const hits: string[] = [];
  for (const block of content) {
    const b = block as { type?: unknown; tool_use_id?: unknown; is_error?: unknown };
    if (b?.type === "tool_result" && b.is_error === true && typeof b.tool_use_id === "string" && rejectedIds.has(b.tool_use_id)) {
      hits.push(b.tool_use_id);
    }
  }
  if (hits.length === 0) return message;
  const prior: MetaEntry[] = Array.isArray(m.tool_result_meta)
    ? (m.tool_result_meta as unknown[]).filter((e): e is MetaEntry => !!e && typeof e === "object")
    : [];
  const meta = prior.map((e) =>
    typeof e.id === "string" && hits.includes(e.id) ? { ...e, non_execution_kind: USER_REJECTED_KIND } : e,
  );
  for (const id of hits) {
    if (!meta.some((e) => e.id === id)) meta.push({ id, non_execution_kind: USER_REJECTED_KIND });
    rejectedIds.delete(id);
  }
  return { ...(message as object), tool_result_meta: meta } as T;
}

/**
 * The `non_execution_kind` the engine (or Claudius's re-stamp) gave the
 * result for `toolUseId`, or `undefined`. Read defensively — the field is
 * @internal.
 */
export function nonExecutionKindOf(toolResultMeta: unknown, toolUseId: string): string | undefined {
  if (!Array.isArray(toolResultMeta)) return undefined;
  for (const e of toolResultMeta) {
    if (!e || typeof e !== "object") continue;
    const entry = e as MetaEntry;
    if (entry.id === toolUseId && typeof entry.non_execution_kind === "string") return entry.non_execution_kind;
  }
  return undefined;
}
