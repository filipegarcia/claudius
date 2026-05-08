"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { SideNav } from "@/components/nav/SideNav";
import { StatusLine } from "@/components/chat/StatusLine";
import { MessageList } from "@/components/chat/MessageList";
import { TodosBanner } from "@/components/chat/TodosBanner";
import { PromptInput } from "@/components/chat/PromptInput";
import { PermissionPrompt } from "@/components/chat/PermissionPrompt";
import { AskUserQuestionPrompt } from "@/components/chat/AskUserQuestionPrompt";
import { QueueIndicator } from "@/components/chat/QueueIndicator";
import { PromptSuggestions } from "@/components/chat/PromptSuggestions";
import { BackgroundTasksPanel } from "@/components/panels/BackgroundTasksPanel";
import { nextPermissionMode } from "@/components/chat/ModeSelector";
import { HelpOverlay } from "@/components/overlays/HelpOverlay";
import { SkillsOverlay } from "@/components/overlays/SkillsOverlay";
import { CostOverlay } from "@/components/overlays/CostOverlay";
import { StatusOverlay } from "@/components/overlays/StatusOverlay";
import { RenameOverlay } from "@/components/overlays/RenameOverlay";
import { ContextOverlay } from "@/components/overlays/ContextOverlay";
import { PlanModeBanner } from "@/components/chat/PlanModeBanner";
import { PlanOverlay } from "@/components/overlays/PlanOverlay";
import { WorktreesOverlay } from "@/components/overlays/WorktreesOverlay";
import type { AttachedImage } from "@/lib/client/types";
import { useSession } from "@/lib/client/use-session";
import { useLimits } from "@/lib/client/useLimits";
import { CapBreachBanner } from "@/components/chat/CapBreachBanner";
import { TranscriptSearch, type SearchHit } from "@/components/chat/TranscriptSearch";
import { SessionTabs, activeTabStatus, tabLabelFor } from "@/components/chat/SessionTabs";
import { TabClaimBanner } from "@/components/chat/TabClaimBanner";
import { useTabClaim } from "@/lib/client/useTabClaim";
import { BashViewer } from "@/components/panels/BashViewer";
import type { BackgroundBash } from "@/lib/client/types";

function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function todosFingerprint(todos: { id: string; status: string }[]): string {
  return todos.map((t) => `${t.id}:${t.status}`).join("|");
}
import { useContextWatcher } from "@/lib/client/useContextWatcher";
import { useNotifications } from "@/lib/client/useNotifications";
import { findSlashCommand } from "@/lib/shared/slash-commands";

type OverlayKind = "help" | "skills" | "cost" | "status" | "rename" | "context" | "worktrees" | null;

export default function Home() {
  const session = useSession();
  const router = useRouter();
  const [rewindingUuid, setRewindingUuid] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<OverlayKind>(null);
  const [toast, setToast] = useState<string | null>(null);
  const ctxSummary = useContextWatcher(session.sessionId, session.pending);
  const [draftInjection, setDraftInjection] = useState<
    { token: number; text: string; images?: AttachedImage[] } | undefined
  >(undefined);
  const draftTokenRef = useRef(0);
  const tabClaim = useTabClaim(session.sessionId);

  const limits = useLimits(session.cwd);

  // Compute breach state. The override is keyed by `session:<id>:<today>` so
  // it lifts the cap only for the current calendar day, per the spec.
  const sessionCapUsd = limits.state?.limits.sessionUsd ?? 0;
  const projectCapUsd = limits.state?.limits.projectDailyUsd ?? 0;
  const sessionSpentUsd = session.usage?.totalCostUsd ?? 0;
  const overrideKey = session.sessionId
    ? `session:${session.sessionId}:${todayKey()}`
    : null;
  const sessionOverridden = !!(overrideKey && limits.state?.overrides[overrideKey]);
  const capBreached =
    sessionCapUsd > 0 && sessionSpentUsd >= sessionCapUsd && !sessionOverridden;

  // One-shot audit log when the cap first trips.
  const auditedSessionRef = useRef<string | null>(null);
  useEffect(() => {
    if (!capBreached || !session.sessionId) return;
    if (auditedSessionRef.current === session.sessionId) return;
    auditedSessionRef.current = session.sessionId;
    void limits.audit({
      ts: new Date().toISOString(),
      kind: "breach",
      scope: "session",
      target: session.sessionId,
      capUsd: sessionCapUsd,
      spentUsd: sessionSpentUsd,
    });
  }, [capBreached, session.sessionId, sessionCapUsd, sessionSpentUsd, limits]);

  const onOverride = useCallback(async () => {
    if (!session.sessionId) return;
    await limits.setOverride(session.sessionId, true);
    void limits.audit({
      ts: new Date().toISOString(),
      kind: "override",
      scope: "session",
      target: session.sessionId,
      capUsd: sessionCapUsd,
      spentUsd: sessionSpentUsd,
      overrideDay: todayKey(),
    });
  }, [session.sessionId, sessionCapUsd, sessionSpentUsd, limits]);

  // ?new=1 on the URL means "the user clicked Chat — give me a new session."
  // The boot effect in useSession handles this on initial mount, but a click
  // from the chat page to itself is a same-route navigation and won't remount,
  // so we also watch the URL reactively here.
  const searchParams = useSearchParams();
  const newParam = searchParams?.get("new");
  const consumedNewRef = useRef(false);
  const createNewSessionAction = session.createNewSession;
  useEffect(() => {
    if (newParam !== "1") {
      consumedNewRef.current = false;
      return;
    }
    if (consumedNewRef.current) return;
    consumedNewRef.current = true;
    // Strip ?new and the stale ?session= so refresh doesn't loop.
    const url = new URL(window.location.href);
    url.searchParams.delete("new");
    url.searchParams.delete("session");
    url.searchParams.delete("at");
    window.history.replaceState(null, "", url.toString());
    void createNewSessionAction();
  }, [newParam, createNewSessionAction]);

  // Session tabs (IntelliJ-style) ─────────────────────────────────────────
  // Open tabs persist within a tab via sessionStorage so refresh keeps them.
  // The active tab is whichever sessionId useSession is bound to.
  const TABS_KEY = "claudius.openTabs";
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  // Hydrate once on mount.
  useEffect(() => {
    try {
      const raw = window.sessionStorage.getItem(TABS_KEY);
      if (raw) {
        const arr = JSON.parse(raw) as unknown;
        if (Array.isArray(arr) && arr.every((x) => typeof x === "string")) {
          setOpenTabs(arr);
        }
      }
    } catch {
      // ignore
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Persist on change.
  useEffect(() => {
    try {
      window.sessionStorage.setItem(TABS_KEY, JSON.stringify(openTabs));
    } catch {
      // ignore
    }
  }, [openTabs]);
  // Auto-add the active session id whenever it appears.
  useEffect(() => {
    if (!session.sessionId) return;
    setOpenTabs((prev) => (prev.includes(session.sessionId!) ? prev : [...prev, session.sessionId!]));
  }, [session.sessionId]);

  const closeTab = useCallback(
    (id: string) => {
      setOpenTabs((prev) => {
        const next = prev.filter((x) => x !== id);
        // If we just closed the active tab, switch to a neighbor — pick the
        // tab to the left of the closed one, falling back to the first tab.
        if (id === session.sessionId) {
          const idx = prev.indexOf(id);
          const target = next[Math.max(0, idx - 1)] ?? next[0] ?? null;
          if (target) {
            session.switchSession(target);
          } else {
            // No tabs left — start a fresh session, which the active-bind
            // effect above will then add back to the strip.
            void session.createNewSession();
          }
        }
        return next;
      });
    },
    [session],
  );

  // Bash live-tail viewer ─────────────────────────────────────────────────
  const [openBash, setOpenBash] = useState<BackgroundBash | null>(null);
  // Re-pull the latest entry from state so the viewer reflects new tool_results
  // (status/killed updates) without remounting.
  const liveOpenBash = openBash
    ? session.backgroundBashes[openBash.toolUseId] ?? openBash
    : null;

  // Todos banner ──────────────────────────────────────────────────────────
  // Hidden state survives until the agent next *changes* its todo list.
  // Fingerprint = id+status of every todo, joined; any modification re-shows.
  const [todosBannerHidden, setTodosBannerHidden] = useState(false);
  const todosBannerHiddenFingerprintRef = useRef<string>("");
  useEffect(() => {
    const fp = todosFingerprint(session.latestTodos);
    if (todosBannerHidden && fp !== todosBannerHiddenFingerprintRef.current) {
      setTodosBannerHidden(false);
    }
  }, [session.latestTodos, todosBannerHidden]);

  // Transcript search ─────────────────────────────────────────────────────
  const [searchOpen, setSearchOpen] = useState(false);
  const [highlightUuid, setHighlightUuid] = useState<string | null>(null);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        setSearchOpen(true);
      }
      if (e.key === "Escape" && searchOpen) {
        setSearchOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [searchOpen]);
  const onPickHit = useCallback(
    async (hit: SearchHit) => {
      setSearchOpen(false);
      const ok = await session.jumpToUuid(hit.messageUuid);
      if (!ok) return;
      setHighlightUuid(hit.messageUuid);
      setTimeout(() => setHighlightUuid((prev) => (prev === hit.messageUuid ? null : prev)), 1500);
    },
    [session],
  );

  const liftQueued = useCallback(
    (id: string) => {
      const item = session.editQueued(id);
      if (item == null) return;
      draftTokenRef.current += 1;
      setDraftInjection({ token: draftTokenRef.current, text: item.text, images: item.images });
    },
    [session],
  );
  const notifications = useNotifications();
  const wasPendingRef = useRef(false);
  const lastPermissionRef = useRef<string | null>(null);
  useEffect(() => {
    // Permission request just opened.
    const cur = session.pendingPermission?.requestId ?? null;
    if (cur && cur !== lastPermissionRef.current) {
      notifications.notify("Claude needs permission", session.pendingPermission?.title ?? "");
    }
    lastPermissionRef.current = cur;
  }, [session.pendingPermission, notifications]);
  useEffect(() => {
    // Pending edge: true → false means the assistant finished a turn.
    if (wasPendingRef.current && !session.pending) {
      notifications.notify("Claude finished a turn", session.cwd ?? "");
    }
    wasPendingRef.current = session.pending;
  }, [session.pending, session.cwd, notifications]);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2200);
  }, []);

  const onRewind = useCallback(
    async (messageUuid: string) => {
      const id = session.sessionId;
      if (!id) return;
      setRewindingUuid(messageUuid);
      try {
        const res = await fetch("/api/sessions/fork", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: id, upToMessageId: messageUuid }),
        });
        if (!res.ok) throw new Error(`fork failed: ${res.status}`);
        const data = (await res.json()) as { sessionId?: string };
        if (data.sessionId) router.push(`/?session=${data.sessionId}`);
      } catch (err) {
        console.error("rewind failed", err);
      } finally {
        setRewindingUuid(null);
      }
    },
    [session.sessionId, router],
  );

  // Shift+Tab cycles permission mode (mirrors Claude Code).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Tab" && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const target = e.target as HTMLElement | null;
        if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) {
          const v = (target as HTMLInputElement | HTMLTextAreaElement).value;
          if (v && v.length > 0) return;
        }
        e.preventDefault();
        void session.setPermissionMode(nextPermissionMode(session.permissionMode));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [session]);

  // Native slash dispatcher. Returns true if the command was handled.
  const runNative = useCallback(
    (id: string, args: string): boolean => {
      switch (id) {
        case "clear": {
          void session.createNewSession();
          showToast("New session");
          return true;
        }
        case "resume": {
          if (args) router.push(`/?session=${args.trim()}`);
          else router.push("/sessions");
          return true;
        }
        case "fork": {
          const sid = session.sessionId;
          if (!sid) return true;
          fetch("/api/sessions/fork", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId: sid, title: args || undefined }),
          })
            .then((r) => r.json())
            .then((d: { sessionId?: string }) => {
              if (d.sessionId) router.push(`/?session=${d.sessionId}`);
            })
            .catch(() => showToast("Fork failed"));
          return true;
        }
        case "rename": {
          if (args.trim()) {
            const sid = session.sessionId;
            if (!sid) return true;
            void fetch("/api/sessions/rename", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ sessionId: sid, title: args.trim() }),
            }).then(() => showToast("Renamed"));
          } else {
            setOverlay("rename");
          }
          return true;
        }
        case "export": {
          const sid = session.sessionId;
          if (!sid) return true;
          const url = `/api/sessions/export/${sid}`;
          window.open(url, "_blank");
          return true;
        }
        case "exit": {
          router.push("/sessions");
          return true;
        }
        case "permissions":
          router.push("/permissions");
          return true;
        case "mcp":
          router.push("/mcp");
          return true;
        case "hooks":
          router.push("/hooks");
          return true;
        case "agents":
          router.push("/agents");
          return true;
        case "plugin":
          router.push("/plugins");
          return true;
        case "reload-plugins": {
          const sid = session.sessionId;
          if (!sid) {
            showToast("No active session");
            return true;
          }
          fetch(`/api/plugins/reload?sessionId=${encodeURIComponent(sid)}`, { method: "POST" })
            .then((r) => showToast(r.ok ? "Plugins reloaded" : `Reload failed: ${r.status}`))
            .catch(() => showToast("Reload failed"));
          return true;
        }
        case "settings":
          router.push("/settings");
          return true;
        case "keybindings":
          router.push("/keybindings");
          return true;
        case "statusline":
          router.push("/settings");
          return true;
        case "theme": {
          const valid = ["dark", "light", "midnight", "paper"] as const;
          const candidate = args.trim().toLowerCase();
          if ((valid as readonly string[]).includes(candidate) && typeof window !== "undefined") {
            window.localStorage.setItem("claudius.theme", candidate);
            document.documentElement.dataset.theme = candidate;
            showToast(`Theme → ${candidate}`);
          } else {
            router.push("/settings");
          }
          return true;
        }
        case "plan": {
          void session.setPermissionMode("plan");
          showToast("Plan mode — Claude will produce a plan before executing");
          if (args.trim()) void session.send(args.trim());
          return true;
        }
        case "worktrees":
          setOverlay("worktrees");
          return true;
        case "files":
          router.push("/files");
          return true;
        case "add-dir": {
          const dir = args.trim();
          if (!dir) {
            showToast("Usage: /add-dir <absolute path>");
            return true;
          }
          fetch("/api/settings/additional-dirs", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ scope: "project", cwd: session.cwd, add: [dir] }),
          })
            .then((r) => {
              if (r.ok) showToast(`Added ${dir} (project) — restart session to apply`);
              else showToast(`add-dir failed: ${r.status}`);
            })
            .catch(() => showToast("add-dir failed"));
          return true;
        }
        case "tasks":
          showToast("Background tasks panel is on the right rail");
          return true;
        case "skills":
          setOverlay("skills");
          return true;
        case "memory":
          router.push("/memory");
          return true;
        case "context":
          setOverlay("context");
          return true;
        case "cost":
          setOverlay("cost");
          return true;
        case "usage":
          router.push("/usage");
          return true;
        case "login":
        case "logout":
        case "setup-bedrock":
        case "setup-vertex":
          router.push("/usage");
          return true;
        case "status":
          setOverlay("status");
          return true;
        case "help":
          setOverlay("help");
          return true;
        case "release-notes":
          router.push("/release-notes");
          return true;
        case "doctor":
          router.push("/doctor");
          return true;
        case "loop":
        case "schedule":
          router.push("/schedule");
          return true;
        case "heapdump":
          fetch("/api/heapdump", { method: "POST" })
            .then(async (r) => {
              const d = (await r.json().catch(() => ({}))) as { ok?: boolean; path?: string; error?: string };
              if (d.ok && d.path) showToast(`Heap report → ${d.path}`);
              else showToast(`Heapdump failed: ${d.error ?? r.status}`);
            })
            .catch(() => showToast("Heapdump failed"));
          return true;
        case "model": {
          if (args.trim()) {
            void session.setModel(args.trim());
            showToast(`Model → ${args.trim()}`);
          } else {
            showToast("Pass a model id, e.g. /model claude-sonnet-4-6");
          }
          return true;
        }
        case "copy": {
          const last = [...session.messages].reverse().find((m) => m.role === "assistant");
          if (!last) {
            showToast("Nothing to copy");
            return true;
          }
          const text = last.blocks
            .filter((b) => b.kind === "text")
            .map((b) => (b as { text: string }).text)
            .join("\n");
          navigator.clipboard
            .writeText(text)
            .then(() => showToast("Copied last response"))
            .catch(() => showToast("Copy failed"));
          return true;
        }
        case "rewind":
          showToast("Hover any user message and click ↺ Rewind here");
          return true;
        default:
          return false;
      }
    },
    [router, session, showToast],
  );

  const handleSend = useCallback(
    (
      text: string,
      images?: Array<{ id?: string; ordinal?: number; data: string; mediaType: string }>,
    ) => {
      const trimmed = text.trim();
      // Slash dispatch only when there are no images attached.
      if (trimmed.startsWith("/") && !images?.length) {
        const head = trimmed.slice(1).split(/\s+/, 1)[0] ?? "";
        const args = trimmed.slice(1 + head.length).trim();
        const cmd = findSlashCommand(head);
        if (cmd?.handler === "native") {
          if (runNative(cmd.id, args)) return;
        }
        if (cmd?.handler === "external") {
          showToast(`/${cmd.name} is terminal/hosted only`);
          return;
        }
      }
      void session.send(text, images);
    },
    [runNative, session, showToast],
  );

  const onRenameSubmit = useCallback(
    async (title: string) => {
      const sid = session.sessionId;
      if (!sid) return;
      await fetch("/api/sessions/rename", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: sid, title }),
      });
      setOverlay(null);
      showToast("Renamed");
    },
    [session.sessionId, showToast],
  );

  return (
    <div className="flex h-full">
      <SideNav running={session.pending} />
      <main className="flex h-full flex-1 flex-col">
        <SessionTabs
          tabs={openTabs.map((id) => ({
            id,
            label: id === session.sessionId
              ? tabLabelFor(id, session.sessions, session.sessionTitle)
              : tabLabelFor(id, session.sessions),
            status:
              id === session.sessionId
                ? activeTabStatus({
                    ready: session.ready,
                    pending: session.pending,
                    hasError: session.errors.length > 0,
                  })
                : "background",
          }))}
          activeId={session.sessionId}
          onSelect={(id) => {
            if (id !== session.sessionId) session.switchSession(id);
          }}
          onClose={closeTab}
          onNew={() => void session.createNewSession()}
        />
        <StatusLine
          sessionId={session.sessionId}
          sessionTitle={session.sessionTitle}
          onRenameSession={session.renameTitle}
          ready={session.ready}
          pending={session.pending}
          permissionMode={session.permissionMode}
          model={session.model}
          onModeChange={session.setPermissionMode}
          sessions={session.sessions}
          onSwitchSession={session.switchSession}
          onCreateNewSession={session.createNewSession}
          onRefreshSessions={session.refreshSessions}
          contextPercent={ctxSummary?.percentage}
          onOpenContext={() => setOverlay("context")}
          fastModeState={session.fastModeState}
          totalCostUsd={session.usage?.totalCostUsd}
          outputTokens={session.usage?.outputTokens}
          onOpenCost={() => setOverlay("cost")}
          notificationsEnabled={notifications.enabled}
          notificationsState={notifications.state}
          onToggleNotifications={() => void notifications.setEnabled(!notifications.enabled)}
          onCompact={() => handleSend("/compact")}
          onClear={() => {
            if (
              session.messages.length === 0 ||
              confirm("Start a new session? The current conversation is preserved on disk.")
            ) {
              void session.createNewSession();
            }
          }}
        />
        <PlanModeBanner
          mode={session.permissionMode}
          onExit={() => void session.setPermissionMode("default")}
        />
        <TodosBanner
          todos={session.latestTodos}
          hidden={todosBannerHidden}
          onDismiss={() => {
            // Hide until the agent next updates its todo list — fingerprint
            // the current list so a real update re-shows the banner.
            todosBannerHiddenFingerprintRef.current = todosFingerprint(session.latestTodos);
            setTodosBannerHidden(true);
          }}
        />
        <div className="flex flex-1 flex-col overflow-hidden">
          {searchOpen && (
            <TranscriptSearch
              sessionId={session.sessionId}
              onClose={() => setSearchOpen(false)}
              onPick={onPickHit}
            />
          )}
          <MessageList
            messages={session.messages}
            systemEntries={session.systemEntries}
            pending={session.pending}
            onRewind={onRewind}
            rewindingUuid={rewindingUuid}
            tasks={session.tasks}
            subagentMessages={session.subagentMessages}
            replaying={session.replaying}
            hasMoreAbove={session.hasMoreAbove}
            loadingOlder={session.loadingOlder}
            onLoadOlder={session.loadOlder}
            highlightUuid={highlightUuid}
          />
          {session.errors.length > 0 && (
            <div className="mx-auto w-full max-w-3xl px-4 pb-2">
              {session.errors.map((e, i) => (
                <div
                  key={i}
                  className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300"
                >
                  {e}
                </div>
              ))}
            </div>
          )}
          <PromptSuggestions
            suggestions={session.promptSuggestions}
            onPick={(s) => handleSend(s)}
          />
          <QueueIndicator
            queue={session.queue}
            onCancel={session.cancelQueued}
            onEdit={liftQueued}
            onReorder={session.reorderQueued}
          />
          {tabClaim.readOnly && (
            <TabClaimBanner
              onTakeOver={tabClaim.takeOver}
              onOpenNew={() => void session.createNewSession()}
            />
          )}
          {capBreached && (
            <CapBreachBanner
              capUsd={sessionCapUsd}
              spentUsd={sessionSpentUsd}
              onOverride={onOverride}
            />
          )}
          <PromptInput
            ready={session.ready}
            pending={session.pending}
            slashCommands={session.slashCommands}
            skills={session.skills}
            cwd={session.cwd}
            onSend={handleSend}
            onInterrupt={session.interrupt}
            draftInjection={draftInjection}
            sendDisabled={capBreached || tabClaim.readOnly}
          />
        </div>
      </main>
      <BackgroundTasksPanel
        progress={session.toolProgress}
        tasks={session.tasks}
        sessionId={session.sessionId}
        model={session.model}
        permissionMode={session.permissionMode}
        cwd={session.cwd}
        usage={session.usage}
        pending={session.pending}
        pendingPermission={session.pendingPermission}
        latestTodos={session.latestTodos}
        recentEdits={session.recentEdits}
        backgroundBashes={session.backgroundBashes}
        toolHistory={session.toolHistory}
        onOpenBash={setOpenBash}
      />

      {liveOpenBash && (
        <BashViewer
          bash={liveOpenBash}
          messages={session.messages}
          onClose={() => setOpenBash(null)}
        />
      )}

      {overlay === "help" && (
        <HelpOverlay
          sdkSlashCommands={session.slashCommands}
          sdkSkills={session.skills}
          onClose={() => setOverlay(null)}
        />
      )}
      {overlay === "skills" && (
        <SkillsOverlay
          agents={session.agents}
          skills={session.skills}
          slashCommands={session.slashCommands}
          onClose={() => setOverlay(null)}
        />
      )}
      {overlay === "cost" && (
        <CostOverlay usage={session.usage} model={session.model} onClose={() => setOverlay(null)} />
      )}
      {overlay === "status" && (
        <StatusOverlay
          sessionId={session.sessionId}
          cwd={session.cwd}
          model={session.model}
          permissionMode={session.permissionMode}
          ready={session.ready}
          pending={session.pending}
          toolCount={0}
          agentCount={session.agents.length}
          skillCount={session.skills.length}
          slashCount={session.slashCommands.length}
          onClose={() => setOverlay(null)}
        />
      )}
      {overlay === "rename" && (
        <RenameOverlay onSubmit={onRenameSubmit} onClose={() => setOverlay(null)} />
      )}
      {overlay === "context" && (
        <ContextOverlay sessionId={session.sessionId} onClose={() => setOverlay(null)} />
      )}
      {overlay === "worktrees" && (
        <WorktreesOverlay
          cwd={session.cwd}
          onClose={() => setOverlay(null)}
          onOpen={(path) => {
            setOverlay(null);
            void session.createSessionAt(path);
            showToast(`New session in ${path}`);
          }}
        />
      )}

      {session.pendingPlan && (
        <PlanOverlay
          plan={session.pendingPlan}
          onClose={() => session.dismissPlan()}
          onAccept={() => {
            void session.setPermissionMode("acceptEdits");
            session.dismissPlan();
            showToast("Plan accepted — switched to acceptEdits");
          }}
          onReject={() => {
            session.dismissPlan();
            showToast("Plan rejected — still in plan mode");
          }}
        />
      )}

      {session.pendingPermission && (
        <PermissionPrompt
          request={session.pendingPermission}
          onResolve={(d) => session.resolvePermission(session.pendingPermission!.requestId, d)}
        />
      )}

      {session.pendingAsk && (
        <AskUserQuestionPrompt
          request={session.pendingAsk}
          onSubmit={(answers) =>
            session.submitAskAnswer(session.pendingAsk!.requestId, answers)
          }
          onCancel={() =>
            // Cancel = decline-but-graceful: send empty answers so the SDK
            // doesn't hang. The model treats this as the user declining.
            session.submitAskAnswer(session.pendingAsk!.requestId, [])
          }
        />
      )}

      {toast && (
        <div className="pointer-events-none fixed bottom-24 left-1/2 z-50 -translate-x-1/2 rounded-md border border-[var(--border)] bg-[var(--panel)] px-3 py-1.5 text-xs shadow-2xl">
          {toast}
        </div>
      )}
    </div>
  );
}
