"use client";

import { useCallback, useEffect, useState } from "react";

export type AutoMemoryFile = { name: string; path: string; size: number; modifiedMs: number };

/**
 * List the auto-memory files for `cwd`, with CRUD helpers. Pattern matches
 * `useCost` (refetchTrigger + AbortController + setState-in-callback).
 */
export function useAutoMemory(cwd: string | null) {
  const [dir, setDir] = useState<string | null>(null);
  const [files, setFiles] = useState<AutoMemoryFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refetchTrigger, setRefetchTrigger] = useState(0);

  useEffect(() => {
    if (!cwd) return;
    const controller = new AbortController();

    fetch(`/api/memory/auto?cwd=${encodeURIComponent(cwd)}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as { dir: string; files: AutoMemoryFile[] };
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
  }, [cwd, refetchTrigger]);

  const refresh = useCallback(() => {
    setLoading(true);
    setRefetchTrigger((n) => n + 1);
  }, []);

  const readFile = useCallback(
    async (name: string): Promise<string | null> => {
      if (!cwd) return null;
      const res = await fetch(
        `/api/memory/auto?cwd=${encodeURIComponent(cwd)}&file=${encodeURIComponent(name)}`,
      );
      if (!res.ok) return null;
      const data = (await res.json()) as { name: string; content: string };
      return data.content;
    },
    [cwd],
  );

  const createMemory = useCallback(
    async (input: {
      filename: string;
      type: "user" | "feedback" | "project" | "reference";
      name: string;
      description: string;
      body: string;
    }): Promise<{ ok: true; name: string } | { ok: false; status: number; error: string }> => {
      if (!cwd) return { ok: false, status: 0, error: "no cwd" };
      const res = await fetch(`/api/memory/auto?cwd=${encodeURIComponent(cwd)}`, {
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
    [cwd, refresh],
  );

  const updateMemory = useCallback(
    async (
      filename: string,
      input: { description?: string; type?: "user" | "feedback" | "project" | "reference"; body?: string },
    ): Promise<{ ok: true } | { ok: false; status: number; error: string }> => {
      if (!cwd) return { ok: false, status: 0, error: "no cwd" };
      const res = await fetch(
        `/api/memory/auto?cwd=${encodeURIComponent(cwd)}&filename=${encodeURIComponent(filename)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        },
      );
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        return { ok: false, status: res.status, error: err.error ?? `HTTP ${res.status}` };
      }
      refresh();
      return { ok: true };
    },
    [cwd, refresh],
  );

  const deleteMemory = useCallback(
    async (filename: string): Promise<{ ok: true } | { ok: false; status: number; error: string }> => {
      if (!cwd) return { ok: false, status: 0, error: "no cwd" };
      const res = await fetch(
        `/api/memory/auto?cwd=${encodeURIComponent(cwd)}&filename=${encodeURIComponent(filename)}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        return { ok: false, status: res.status, error: err.error ?? `HTTP ${res.status}` };
      }
      refresh();
      return { ok: true };
    },
    [cwd, refresh],
  );

  return { dir, files, loading, error, refresh, readFile, createMemory, updateMemory, deleteMemory };
}
