"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Download, Edit2, FileJson, GitBranch, Play, Trash2 } from "lucide-react";
import type { SDKSessionInfo, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { SideNav } from "@/components/nav/SideNav";
import { TranscriptViewer } from "@/components/sessions/TranscriptViewer";
import { useSessionsHistory } from "@/lib/client/useSessionsHistory";
import { cn } from "@/lib/utils/cn";

export default function SessionDetailPage() {
  const params = useParams<{ id: string }>();
  const search = useSearchParams();
  const router = useRouter();
  const id = params?.id ?? "";
  const dir = search?.get("dir") || undefined;

  const { rename, fork, remove } = useSessionsHistory();

  const [info, setInfo] = useState<SDKSessionInfo | null>(null);
  const [messages, setMessages] = useState<SessionMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [rewinding, setRewinding] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = dir ? `?dir=${encodeURIComponent(dir)}` : "";
      const [infoRes, txRes] = await Promise.all([
        fetch(`/api/sessions/info/${id}${qs}`),
        fetch(`/api/sessions/transcript/${id}${qs}`),
      ]);
      if (!infoRes.ok) throw new Error(`info: ${infoRes.status}`);
      if (!txRes.ok) throw new Error(`transcript: ${txRes.status}`);
      const meta = (await infoRes.json()) as SDKSessionInfo;
      const tx = (await txRes.json()) as { messages: SessionMessage[] };
      setInfo(meta);
      setMessages(tx.messages ?? []);
      // Pre-fill from a trusted title source only — `claudiusTitle`
      // wins (set on every Claudius-side rename even when the SDK's
      // JSONL header write was deferred); `customTitle` is the SDK's
      // copy. `summary`/`firstPrompt` would put prompt text in the
      // rename input and tempt the user to "Save" it as the title.
      setTitleDraft(
        (meta as { claudiusTitle?: string }).claudiusTitle
          ?? meta.customTitle
          ?? "",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [id, dir]);

  useEffect(() => {
    if (id) void load();
  }, [id, load]);

  const onRename = async () => {
    if (!titleDraft.trim()) return;
    const ok = await rename(id, titleDraft.trim(), dir);
    if (ok) {
      setRenaming(false);
      void load();
    }
  };

  const onRewind = async (messageUuid: string) => {
    setRewinding(messageUuid);
    try {
      const newId = await fork(id, { upToMessageId: messageUuid, dir });
      if (newId) {
        router.push(`/?session=${newId}`);
      } else {
        setError("Fork failed");
      }
    } finally {
      setRewinding(null);
    }
  };

  const onResume = () => {
    router.push(`/?session=${id}`);
  };

  const onForkFull = async () => {
    const newId = await fork(id, { dir });
    if (newId) {
      router.push(`/sessions/${newId}${dir ? `?dir=${encodeURIComponent(dir)}` : ""}`);
    }
  };

  const onDelete = async () => {
    if (!confirm("Delete this session permanently?")) return;
    if (await remove(id, dir)) router.push("/sessions");
  };

  return (
    <div className="flex h-full">
      <SideNav running={false} />
      <main className="flex h-full flex-1 flex-col overflow-hidden">
        <header className="flex h-9 shrink-0 items-center gap-3 border-b border-[var(--border)] bg-[var(--panel)] px-4 text-xs">
          <Link href="/sessions" className="flex items-center gap-1 text-[var(--muted)] hover:text-[var(--foreground)]">
            <ArrowLeft className="h-3.5 w-3.5" /> Sessions
          </Link>
          <span className="opacity-50">·</span>
          {!renaming ? (
            <>
              {/*
                Title precedence — see `app/sessions/page.tsx`:
                  1. claudiusTitle (our DB)
                  2. customTitle  (SDK JSONL)
                  3. "(untitled)"
                Never `summary`/`firstPrompt` — they're prompt text.
              */}
              <span className="truncate font-medium">
                {(info as { claudiusTitle?: string } | null)?.claudiusTitle
                  || info?.customTitle
                  || "(untitled)"}
              </span>
              <button
                onClick={() => setRenaming(true)}
                title="Rename"
                className="rounded p-0.5 text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)]"
              >
                <Edit2 className="h-3 w-3" />
              </button>
            </>
          ) : (
            <>
              <input
                autoFocus
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void onRename();
                  if (e.key === "Escape") setRenaming(false);
                }}
                className="rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-0.5 text-xs focus:border-[var(--accent)]/60 focus:outline-none"
              />
              <button onClick={onRename} className="text-[var(--accent)] hover:underline">
                Save
              </button>
              <button onClick={() => setRenaming(false)} className="text-[var(--muted)] hover:underline">
                Cancel
              </button>
            </>
          )}
          <span className="font-mono text-[10px] text-[var(--muted)]">{id.slice(0, 8)}</span>
          {error && <span className="text-red-400">{error}</span>}
          {loading && <span className="text-[var(--muted)]">loading…</span>}
          <div className="ml-auto flex items-center gap-1">
            <button
              onClick={onResume}
              className={cn(
                "flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--accent)]/10 px-2 py-0.5 text-[var(--accent)]",
                "hover:bg-[var(--accent)]/20",
              )}
            >
              <Play className="h-3 w-3" /> Resume
            </button>
            <button
              onClick={onForkFull}
              className="flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-0.5 hover:bg-[var(--panel)]"
            >
              <GitBranch className="h-3 w-3" /> Fork
            </button>
            <a
              href={`/api/sessions/export/${id}${dir ? `?dir=${encodeURIComponent(dir)}` : ""}`}
              className="flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-0.5 hover:bg-[var(--panel)]"
            >
              <Download className="h-3 w-3" /> Export
            </a>
            <button
              onClick={() => setShowRaw((s) => !s)}
              className={cn(
                "flex items-center gap-1 rounded-md border border-[var(--border)] px-2 py-0.5 hover:bg-[var(--panel)]",
                showRaw ? "bg-[var(--panel)]" : "bg-[var(--panel-2)]",
              )}
            >
              <FileJson className="h-3 w-3" /> {showRaw ? "Pretty" : "Raw"}
            </button>
            <button
              onClick={onDelete}
              className="flex items-center gap-1 rounded-md border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-red-300 hover:bg-red-500/20"
            >
              <Trash2 className="h-3 w-3" /> Delete
            </button>
          </div>
        </header>

        {info && (
          <div className="flex flex-wrap items-center gap-3 border-b border-[var(--border)] bg-[var(--panel)]/40 px-4 py-2 text-[11px] text-[var(--muted)]">
            {info.cwd && <span className="font-mono">{info.cwd}</span>}
            {info.gitBranch && <span className="font-mono">branch: {info.gitBranch}</span>}
            {info.createdAt && <span>created {new Date(info.createdAt).toLocaleString()}</span>}
            <span>updated {new Date(info.lastModified).toLocaleString()}</span>
            <span>{messages.length} messages</span>
          </div>
        )}

        <div className="flex-1 overflow-y-auto scroll-thin">
          {showRaw ? (
            <pre className="mx-auto w-full max-w-4xl px-4 py-6 font-mono text-[10.5px] leading-4 text-[var(--muted)] whitespace-pre">
              {messages.map((m) => JSON.stringify(m)).join("\n")}
            </pre>
          ) : (
            <TranscriptViewer messages={messages} onRewind={onRewind} rewinding={rewinding} />
          )}
        </div>
      </main>
    </div>
  );
}
