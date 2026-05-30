"use client";

import { useCallback, useEffect, useState } from "react";

// Redefined inline (NOT imported from lib/server/rules) — importing from a
// server module into client code pulls Node-only deps and breaks `next build`.
export type RuleFile = { name: string; path: string; size: number; modifiedMs: number };

export type RuleScope = "user" | "project";

/**
 * List the rule files for a scope, with plain-body CRUD helpers. Mirrors
 * `useAutoMemory` (refetchTrigger + AbortController + setState-in-callback) but
 * there is no type/frontmatter — a rule file's content is the raw body.
 *
 * For "user" scope `cwd` is ignored (the dir is ~/.claude/rules). For "project"
 * scope fetches are gated on a non-null `cwd`, like useAutoMemory.
 */
export function useRules(scope: RuleScope, cwd: string | null) {
  const [dir, setDir] = useState<string | null>(null);
  const [files, setFiles] = useState<RuleFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refetchTrigger, setRefetchTrigger] = useState(0);

  // Project scope needs a cwd; user scope does not.
  const ready = scope === "user" || !!cwd;

  const queryString = useCallback(() => {
    const params = new URLSearchParams({ scope });
    if (scope === "project" && cwd) params.set("cwd", cwd);
    return params.toString();
  }, [scope, cwd]);

  useEffect(() => {
    if (!ready) return;
    const controller = new AbortController();

    fetch(`/api/memory/rules?${queryString()}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as { dir: string; files: RuleFile[] };
      })
      .then((d) => {
        setDir(d.dir);
        setFiles(d.files);
        setError(null);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [ready, queryString, refetchTrigger]);

  const refresh = useCallback(() => {
    setLoading(true);
    setRefetchTrigger((n) => n + 1);
  }, []);

  const readFile = useCallback(
    async (name: string): Promise<string | null> => {
      if (!ready) return null;
      const params = new URLSearchParams({ scope, file: name });
      if (scope === "project" && cwd) params.set("cwd", cwd);
      const res = await fetch(`/api/memory/rules?${params.toString()}`);
      if (!res.ok) return null;
      const data = (await res.json()) as { name: string; content: string };
      return data.content;
    },
    [ready, scope, cwd],
  );

  const createRule = useCallback(
    async (input: {
      filename: string;
      body: string;
    }): Promise<{ ok: true; name: string } | { ok: false; status: number; error: string }> => {
      if (!ready) return { ok: false, status: 0, error: "not ready" };
      const res = await fetch(`/api/memory/rules?${queryString()}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        return { ok: false, status: res.status, error: err.error ?? `HTTP ${res.status}` };
      }
      const data = (await res.json()) as { name: string };
      refresh();
      return { ok: true, name: data.name };
    },
    [ready, queryString, refresh],
  );

  const updateRule = useCallback(
    async (
      filename: string,
      body: string,
    ): Promise<{ ok: true } | { ok: false; status: number; error: string }> => {
      if (!ready) return { ok: false, status: 0, error: "not ready" };
      const params = new URLSearchParams({ scope, filename });
      if (scope === "project" && cwd) params.set("cwd", cwd);
      const res = await fetch(`/api/memory/rules?${params.toString()}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        return { ok: false, status: res.status, error: err.error ?? `HTTP ${res.status}` };
      }
      refresh();
      return { ok: true };
    },
    [ready, scope, cwd, refresh],
  );

  const deleteRule = useCallback(
    async (filename: string): Promise<{ ok: true } | { ok: false; status: number; error: string }> => {
      if (!ready) return { ok: false, status: 0, error: "not ready" };
      const params = new URLSearchParams({ scope, filename });
      if (scope === "project" && cwd) params.set("cwd", cwd);
      const res = await fetch(`/api/memory/rules?${params.toString()}`, { method: "DELETE" });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        return { ok: false, status: res.status, error: err.error ?? `HTTP ${res.status}` };
      }
      refresh();
      return { ok: true };
    },
    [ready, scope, cwd, refresh],
  );

  return { dir, files, loading, error, refresh, readFile, createRule, updateRule, deleteRule };
}
