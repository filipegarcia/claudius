"use client";

import { useCallback, useEffect, useState } from "react";

export type AutoMemoryFile = { name: string; path: string; size: number; modifiedMs: number };

export function useAutoMemory(cwd: string | null) {
  const [dir, setDir] = useState<string | null>(null);
  const [files, setFiles] = useState<AutoMemoryFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!cwd) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/memory/auto?cwd=${encodeURIComponent(cwd)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { dir: string; files: AutoMemoryFile[] };
      setDir(data.dir);
      setFiles(data.files);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
      await refresh();
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
      await refresh();
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
      await refresh();
      return { ok: true };
    },
    [cwd, refresh],
  );

  return { dir, files, loading, error, refresh, readFile, createMemory, updateMemory, deleteMemory };
}
