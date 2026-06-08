"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { SideNav } from "@/components/nav/SideNav";
import { StatusLine } from "@/components/chat/StatusLine";
import { LoadingBar } from "@/components/chat/LoadingBar";
import { MessageList } from "@/components/chat/MessageList";
import { TodosBanner } from "@/components/chat/TodosBanner";
import { TodosAutoClearedToast } from "@/components/chat/TodosAutoClearedToast";
import { GoalBanner } from "@/components/chat/GoalBanner";
import { useGoalBannerHidden } from "@/lib/client/useGoalBannerHidden";
import { RecapBanner } from "@/components/chat/RecapBanner";
import { OpusLaunchTipBanner } from "@/components/chat/OpusLaunchTipBanner";
import { FeedbackBanner } from "@/components/chat/FeedbackBanner";
import { SessionRecapBanner } from "@/components/chat/SessionRecapBanner";
import { useAwayRecap } from "@/lib/client/useAwayRecap";
import {
  OpusOverloadNudgePanel,
  OPUS_OVERLOAD_NUDGE_SONNET_TARGET,
} from "@/components/chat/OpusOverloadNudgePanel";
import { LongContextCreditsPanel } from "@/components/chat/LongContextCreditsPanel";
import { FastModeNoticePanel } from "@/components/chat/FastModeNoticePanel";
import { ModelSwitchNoticePanel } from "@/components/chat/ModelSwitchNoticePanel";
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
import type { AttachedImage, SessionInfo } from "@/lib/client/types";
import { useSession } from "@/lib/client/use-session";
import { useClaudius, useElectronSubscription } from "@/lib/client/useElectron";
import { parseAskQuestions, type AskAnswer, type AskQuestion } from "@/lib/shared/events";
import { useLimits } from "@/lib/client/useLimits";
import { CapBreachBanner } from "@/components/chat/CapBreachBanner";
import { TranscriptSearch, type SearchHit } from "@/components/chat/TranscriptSearch";
import { SessionTabs, activeTabStatus, reorderArray, tabLabelFor, type TabStatus } from "@/components/chat/SessionTabs";
import { TabClaimBanner } from "@/components/chat/TabClaimBanner";
import { useTabClaim } from "@/lib/client/useTabClaim";
import { BashViewer } from "@/components/panels/BashViewer";
import { ClaudiusMark } from "@/components/brand/ClaudiusMark";
import type { BackgroundBash } from "@/lib/client/types";

function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Render a resurrected AskUserQuestion submission as a single follow-up
 * prompt. The SDK's permission stream for the original tool_use already
 * closed (typically with `Aborted`), so we can't deliver the answer back
 * through `submitAskAnswer` — instead we frame it as a user message that
 * quotes each question + the user's pick. Keeping the question text inline
 * gives the model the same context it had at the time of the ask.
 */
function formatAskAsPrompt(questions: AskQuestion[], answers: AskAnswer[]): string {
  const lines: string[] = [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]!;
    const a = answers[i] ?? {};
    const picks: string[] = [];
    if (a.selected && a.selected.length > 0) picks.push(...a.selected);
    else if (a.label != null && a.label !== "") picks.push(a.label);
    if (a.custom && a.custom.trim()) picks.push(`Other: ${a.custom.trim()}`);
    const answerText = picks.length > 0 ? picks.join(", ") : "(declined)";
    lines.push(`> ${q.question}`);
    lines.push(answerText);
    if (i < questions.length - 1) lines.push("");
  }
  return lines.join("\n");
}
import { useContextWatcher, type ContextSummary } from "@/lib/client/useContextWatcher";
import {
  shouldShowContextWarning,
  useContextWarningPct,
} from "@/lib/client/useContextWarning";
import { ContextWarningBanner } from "@/components/chat/ContextWarningBanner";
import { useNotificationsContext } from "@/components/notifications/NotificationsProvider";
import { findSlashCommand } from "@/lib/shared/slash-commands";
import { DEFAULT_TIPS, selectClientTips } from "@/lib/shared/tips";
import { useWorkspaces } from "@/lib/client/useWorkspaces";
import { useVerbose } from "@/lib/client/useVerbose";
import { useStartupCount } from "@/lib/client/useStartupCount";

type OverlayKind = "help" | "skills" | "cost" | "status" | "rename" | "context" | "worktrees" | null;

/**
 * Per-command toast for slash commands the registry classifies as `external`
 * — i.e. they're advertised in the picker but belong to the terminal CLI,
 * the hosted claude.ai surface, or another app entirely. The picker shows
 * them so users discover the feature exists; this map explains *why* hitting
 * them here doesn't do anything. Fallback below is generic.
 *
 * `/tui` is the most explicit because it's the one users instinctively reach
 * for when they want a "different UI" — the irony is that Claudius IS the
 * UI; there's no other renderer to switch to.
 *
 * NB: this map intentionally shrunk. Most of the 17 originally-external
 * commands flipped to native handlers (see `slash-commands.ts` and the cases
 * in `runNative` below) — `/voice` and `/tui` are the only survivors. Don't
 * re-add an entry here when promoting a command to native, or you'll create
 * dead-code that disagrees with the dispatcher.
 */
const EXTERNAL_SLASH_MESSAGE: Record<string, string> = {
  tui: "Claudius IS the UI — /tui switches between renderers in the terminal and has nowhere to switch to here",
  voice: "/voice is the terminal CLI's voice dictation mode",
};

/**
 * Canonical URLs used by the platform / integration slash commands. Centralised
 * so a future rename is a single-touch update. Each URL was probed live before
 * being added; the comment notes provenance so a future maintainer can re-verify.
 *
 *  - `claudiusReleases`:  download link reused from `components/chrome/WebDesktopBanner.tsx`
 *  - `upgradePlan`:       `UPGRADE_PLAN_URL` in `components/chat/RateLimitHitPanel.tsx`
 *  - `claudeCodeIssues`:  `FALLBACK_URL` in `components/chat/FeedbackBanner.tsx`
 *  - `githubApp`:         confirmed live — the Claude GitHub App install page
 *  - `slackApp`:          confirmed live — the "Claude for Slack" install page
 *  - `mobileApp`:         confirmed live (the older `claude.ai/download` 301s here)
 *  - `stickers`:          the canonical Claude Code merch store on Sticker Mule.
 *                         The terminal CLI's /stickers is an interactive shipping
 *                         form which we can't render in chat, so we link the store.
 *  - `webSetupDocs`:      the documented entry for Claude Code on the web. The
 *                         CLI's /web-setup is an interactive OAuth dance with no
 *                         static landing page, so we send users to the docs that
 *                         walk through the setup.
 *
 * NB: `/passes` is NOT in this map — it generates per-account codes server-side
 * (MAX-plan feature) and is SDK-forwarded. See `slash-commands.ts`.
 */
const SLASH_LINKS = {
  claudiusReleases: "https://github.com/filipegarcia/claudius/releases",
  upgradePlan: "https://claude.ai/upgrade/max",
  claudeCodeIssues: "https://github.com/anthropics/claude-code/issues",
  githubApp: "https://github.com/apps/claude",
  slackApp: "https://claude.com/slack",
  mobileApp: "https://claude.com/download",
  stickers: "https://www.stickermule.com/claudecode",
  webSetupDocs: "https://code.claude.com/docs/en/claude-code-on-the-web",
} as const;

/** Open a URL in a new tab. Works in both the browser and Electron — the
 * Electron main process registers a `window.open` handler that routes
 * external URLs to `shell.openExternal`, so the same call site is correct
 * in both runtimes. `noopener,noreferrer` matches the rest of the codebase.
 */
function openExternalUrl(url: string): void {
  if (typeof window !== "undefined") window.open(url, "_blank", "noopener,noreferrer");
}

export default function Home() {
  const session = useSession();
  const router = useRouter();
  const [rewindingUuid, setRewindingUuid] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<OverlayKind>(null);
  const [toast, setToast] = useState<string | null>(null);
  // Tracks when the user has hidden the AskUserQuestion modal without
  // answering — keyed by requestId so a fresh question pops up again.
  // The modal renders only when there is a pendingAsk AND its requestId
  // is not the one we just minimized.
  const [askMinimizedFor, setAskMinimizedFor] = useState<string | null>(null);
  // "Resurrected" ask — the user clicked the Reopen pill on a historic /
  // errored AskUserQuestion row whose permission stream had already closed
  // server-side. We can't route an answer back through the SDK (it received
  // a deny tool_result and moved on), so submitting here sends the choices
  // as a regular follow-up user message via `handleSend`.
  const [resurrectedAsk, setResurrectedAsk] = useState<
    | {
        /** Synthetic requestId — used only by the modal's local state. */
        requestId: string;
        toolUseId: string;
        questions: AskQuestion[];
      }
    | null
  >(null);
  // Context-window warning banner. The threshold is a browser-local pref
  // (mirrors useRateLimitWarning); when the active session's context usage
  // crosses it we surface a warning + one-click Compact above the composer.
  const { value: contextWarningPct } = useContextWarningPct();
  // Bumped after a manual compaction so the watcher re-polls promptly instead
  // of re-showing a stale, still-high percentage until the next idle poll.
  const [ctxRefreshSignal, setCtxRefreshSignal] = useState(0);
  const ctxSummary = useContextWatcher(session.sessionId, session.pending, ctxRefreshSignal);

  // "Where were we?" auto-recap — fires when the user returns to this tab
  // after a long blur (≥5 min). The settings gate and multi-tab dedupe live
  // on the server; this hook only signals the *intent*. Disabled when no
  // session is bound (a recap against nothing would just no-op anyway, but
  // skipping the listener is cheaper) and when there's typed-but-unsent
  // text in the composer (we never interrupt the user mid-sentence).
  useAwayRecap({
    enabled: !!session.sessionId,
    requestRecap: session.requestRecap,
    getHasDraft: () => {
      // Read the composer textarea live — the PromptInput uses a stable
      // testid that the focus helper in RecapBanner already relies on, so
      // we can lean on it here too. A null/whitespace-only value counts as
      // "no draft" so a freshly-cleared composer doesn't suppress the recap.
      if (typeof document === "undefined") return false;
      const el = document.querySelector<HTMLTextAreaElement>(
        '[data-testid="prompt-input"]',
      );
      return !!el?.value?.trim();
    },
  });
  // True while a /compact fired from the banner (or the StatusLine button) is
  // running; drives the banner's "Compacting…" indicator (elapsed timer +
  // animated bar). The SDK exposes no compaction-progress fraction, so we show
  // honest elapsed time rather than a fabricated percentage.
  const [compacting, setCompacting] = useState(false);
  // Suppresses the banner during the brief window between compaction finishing
  // and the watcher re-polling the now-lower percentage, so it doesn't flash
  // back as "still N% full" right after a successful compact.
  const [ctxSettling, setCtxSettling] = useState(false);
  // Chat verbosity — per-workspace default, persisted via PATCH on the
  // active workspace. The hook initialises from a localStorage cache so the
  // chat renders at the right level on first paint, then reconciles with
  // the server. Selector lives in the StatusLine (chat header).
  const { items: workspaceItems } = useWorkspaces();
  // The page is mounted under `/[workspaceId]/...`, so the URL is the
  // authoritative source for "which workspace is active on THIS page" —
  // synchronous, never stale. We deliberately don't use `useWorkspaces`'s
  // cookie-derived `activeId` here: it can lag the URL (e.g. right after
  // `create()` sets activeId optimistically while the cookie still points at
  // the previous workspace, or during the brief gap before the proxy syncs
  // the cookie on a fresh deeplink). The lag used to leak foreign sessions
  // into the picker — see the strict `pickerSessions` filter below for the
  // counterpart invariant. Mirrors the URL-over-cookie rule the sessions
  // list page already uses (`app/[workspaceId]/sessions/page.tsx`).
  const routeParams = useParams<{ workspaceId: string }>();
  const activeWorkspaceId = routeParams?.workspaceId ?? null;
  const activeWorkspace =
    workspaceItems.find((w) => w.id === activeWorkspaceId) ?? null;
  // Within-session latch for the "make Plan Mode sticky" spinner-tip nudge —
  // the client-side analog of the Claude Code TUI's `H.lastPlanModeUse`. Once
  // we observe `permissionMode === "plan"`, the flag stays true for the rest
  // of this session so the nudge keeps surfacing even after the user has
  // already left Plan Mode (which is the moment the nudge is most useful).
  // Resets when the session id changes. Uses the "adjusting state during
  // rendering" pattern from the React docs rather than a setState-in-effect
  // so the latch flips synchronously with the observed mode change.
  const [planModeUsed, setPlanModeUsed] = useState(false);
  const [planModeLatchSessionId, setPlanModeLatchSessionId] = useState(session.sessionId);
  if (planModeLatchSessionId !== session.sessionId) {
    setPlanModeLatchSessionId(session.sessionId);
    setPlanModeUsed(session.permissionMode === "plan");
  } else if (session.permissionMode === "plan" && !planModeUsed) {
    setPlanModeUsed(true);
  }
  const verbose = useVerbose(activeWorkspaceId);
  // Per-browser launch counter for first-run tip gating. `< 10` mirrors the
  // Claude Code TUI's `numStartups < 10` first-run gate on the `/powerup`
  // onboarding nudge — bumped once per chat-page load (see useStartupCount).
  const startupCount = useStartupCount();
  const [draftInjection, setDraftInjection] = useState<
    {
      token: number;
      text: string;
      images?: AttachedImage[];
      mode?: "replace" | "append";
    } | undefined
  >(undefined);
  const draftTokenRef = useRef(0);
  const tabClaim = useTabClaim(session.sessionId);

  const limits = useLimits(session.cwd);

  // Compute breach state. The override is keyed by `session:<id>:<today>` so
  // it lifts the cap only for the current calendar day, per the spec.
  const sessionCapUsd = limits.state?.limits.sessionUsd ?? 0;
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

  // Electron right-click → "Start New Chat With Selection": main pushes
  // the selection text over `chat:new-with-text`; we react by spawning a
  // new session and seeding its composer with the text (NOT auto-sending).
  // The page-level subscription is fine for the common case (user
  // right-clicks on a message in the chat pane). For right-clicks on
  // non-chat pages the IPC arrives but no handler is registered — V1
  // scope; can lift the listener to the global handler later if needed.
  // See `electron/ipc/context-menu.ts`.
  const claudiusBridge = useClaudius();
  const createNewSessionWithDraftAction = session.createNewSessionWithDraft;
  useElectronSubscription<string>(
    claudiusBridge?.chat.onNewWithText,
    useCallback(
      (text: string) => {
        if (typeof text !== "string" || text.length === 0) return;
        void createNewSessionWithDraftAction(text);
      },
      [createNewSessionWithDraftAction],
    ),
  );

  // Electron right-click → "Append Selection to Current Chat": append the
  // selection onto the existing composer via the draftInjection contract.
  // No session creation — stays on the active tab. PromptInput honours
  // `mode: "append"` to join onto whatever the user already typed instead
  // of clobbering it.
  useElectronSubscription<string>(
    claudiusBridge?.chat.onAppendToComposer,
    useCallback((text: string) => {
      if (typeof text !== "string" || text.length === 0) return;
      draftTokenRef.current += 1;
      setDraftInjection({
        token: draftTokenRef.current,
        text,
        mode: "append",
      });
    }, []),
  );

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

  // Reactive ?session= watcher. Same problem as ?new=1: when an in-app link
  // (e.g. the notifications drawer's "jump to session" or the OS-toast
  // click) does `router.push("/?session=B")` while we're already on `/`,
  // the page doesn't remount and useSession's boot effect doesn't re-run,
  // so the URL ends up pointing at session B while we're still wired to
  // session A. Watch the param reactively and call switchSession when it
  // drifts away from the active id. Guard against the boot-time race where
  // sessionId is still null — useSession's boot effect will pick the right
  // session up via the initial URL read.
  //
  // IMPORTANT: `activeSessionId` is read via a ref so it is NOT a dep of the
  // effect. Otherwise tab clicks (which call `session.switchSession(B)` →
  // `bindToSession` → `window.history.replaceState`) update the state but
  // NOT Next.js's searchParams (replaceState is invisible to useSearchParams).
  // The effect would then re-fire when `activeSessionId` advances to B, see
  // `sessionParam` still at the stale "A", and immediately switch back to A
  // — i.e. silently revert the user's tab click. Reacting only to URL
  // changes preserves the original "URL push from notifications" use case
  // without fighting the in-app tab switcher.
  const sessionParam = searchParams?.get("session");
  const switchSessionAction = session.switchSession;
  const activeSessionIdRef = useRef<string | null>(null);
  // Keep the ref in lock-step with the active session id, in an effect so React
  // doesn't flag a render-time ref mutation. The ref-read inside the watcher
  // effect below sees the latest value because effects run after this one.
  useEffect(() => {
    activeSessionIdRef.current = session.sessionId;
  }, [session.sessionId]);
  useEffect(() => {
    if (!sessionParam) return;
    if (!activeSessionIdRef.current) return; // boot effect handles the initial value
    if (sessionParam === activeSessionIdRef.current) return;
    switchSessionAction(sessionParam);
  }, [sessionParam, switchSessionAction]);

  // In-app "jump to session" from the notifications drawer / OS toast.
  // NotificationsProvider dispatches this CustomEvent instead of doing a
  // `router.push("/?session=B")` because the App Router's soft navigation
  // for same-pathname query-only changes doesn't reliably re-render
  // `useSearchParams` here — the URL would update but the watcher above
  // wouldn't see it and the session would never switch. Calling
  // `switchSession` directly bypasses the router entirely; its internal
  // `replaceState` keeps the URL in sync so a refresh still resumes the
  // right session.
  useEffect(() => {
    function onJump(e: Event) {
      const detail = (e as CustomEvent<{ sessionId?: string }>).detail;
      const id = detail?.sessionId;
      if (!id) return;
      if (id === activeSessionIdRef.current) return;
      switchSessionAction(id);
    }
    window.addEventListener("claudius:jump-to-session", onJump);
    return () => window.removeEventListener("claudius:jump-to-session", onJump);
  }, [switchSessionAction]);

  // ?prefill=<text> | ?prefill=1 → drop a draft into the prompt input on
  // mount. Used by Customize → "Auto-fix conflicts" so the user lands in
  // chat with the composed prompt ready to send. `=1` means "look in
  // sessionStorage under claudius.autofix-draft" (avoids ballooning the
  // URL for long prompts). Anything else is the literal prefill text.
  const prefillParam = searchParams?.get("prefill");
  const consumedPrefillRef = useRef(false);
  useEffect(() => {
    if (!prefillParam) {
      consumedPrefillRef.current = false;
      return;
    }
    if (consumedPrefillRef.current) return;
    consumedPrefillRef.current = true;

    let text: string | null = null;
    if (prefillParam === "1") {
      try {
        text = sessionStorage.getItem("claudius.autofix-draft");
        sessionStorage.removeItem("claudius.autofix-draft");
      } catch {
        text = null;
      }
    } else {
      text = prefillParam;
    }

    const url = new URL(window.location.href);
    url.searchParams.delete("prefill");
    window.history.replaceState(null, "", url.toString());

    if (text && text.trim()) {
      draftTokenRef.current += 1;
      setDraftInjection({ token: draftTokenRef.current, text });
    }
  }, [prefillParam]);

  // Session tabs (IntelliJ-style) ─────────────────────────────────────────
  // Open tabs persist in the per-cwd `.claudius.db` (via /api/sessions/open-tabs)
  // so closing the browser and coming back later restores the same strip —
  // labels resolve through the existing `sessions` table, which already holds
  // custom titles. The active tab is whichever sessionId useSession is bound to.
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  // Gate persistence until the initial fetch has resolved — otherwise the
  // first render's empty array would PUT-and-clobber the saved list before
  // the GET comes back. See the hydration-race note in the migration file.
  const [tabsHydrated, setTabsHydrated] = useState(false);
  // Persisted max-width applied to every tab label. Hydrated alongside the
  // tab list. `null` until the first fetch resolves so SessionTabs uses its
  // built-in default rather than flashing 0.
  const [tabLabelMaxWidth, setTabLabelMaxWidth] = useState<number | null>(null);
  // Server-resolved titles for the persisted tabs, hydrated alongside
  // `openTabs`. Used as a fallback in `tabLabelFor` for tabs that aren't
  // (yet, or anymore) present in `session.sessions` — the freshest source
  // remains `session.sessions` once `refreshSessions` resolves, so renames
  // flow through normally. This patches two gaps:
  //   1. The mount-race window where `session.sessions === []` before the
  //      first `refreshSessions` call returns.
  //   2. The "out-of-recency-slice" gap: `refreshSessions` sorts the disk
  //      listing by recency and locally slices to the top 20, then only
  //      re-adds *live* sessions. A disk-only tab older than the top 20
  //      falls out of the merge and would otherwise show its id prefix
  //      until the user clicks it (and SSE delivers `session_title`).
  const [openTabTitles, setOpenTabTitles] = useState<Record<string, string>>({});
  // Hydrate once on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/sessions/open-tabs");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as {
          tabs?: unknown;
          labelMaxWidth?: unknown;
          titles?: unknown;
        };
        if (cancelled) return;
        const saved = Array.isArray(data.tabs)
          ? (data.tabs.filter((x) => typeof x === "string") as string[])
          : [];
        // Merge: server list first, then anything the auto-add effect below
        // already pushed in (e.g. the boot session id) before the fetch
        // resolved, so we don't drop the active tab.
        setOpenTabs((prev) => {
          const merged = [...saved];
          for (const id of prev) if (!merged.includes(id)) merged.push(id);
          return merged;
        });
        if (typeof data.labelMaxWidth === "number" && Number.isFinite(data.labelMaxWidth)) {
          setTabLabelMaxWidth(data.labelMaxWidth);
        }
        if (data.titles && typeof data.titles === "object" && !Array.isArray(data.titles)) {
          const raw = data.titles as Record<string, unknown>;
          const cleaned: Record<string, string> = {};
          for (const [id, t] of Object.entries(raw)) {
            if (typeof t === "string" && t.trim()) cleaned[id] = t;
          }
          setOpenTabTitles(cleaned);
        }
      } catch {
        // Network/parse failure — fall through with whatever the auto-add
        // effect put in place. Persistence stays gated until we mark
        // hydrated so we don't overwrite the server with a stale empty.
      } finally {
        if (!cancelled) setTabsHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onTabLabelWidthChange = useCallback((width: number) => {
    setTabLabelMaxWidth(width);
    void fetch("/api/sessions/open-tabs", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ labelMaxWidth: width }),
    }).catch(() => {
      // Best-effort — next reload falls back to default if the save failed.
    });
  }, []);
  // Persist on change. Skip until hydrated so the boot-time empty state
  // can't clobber the saved list before we've read it.
  //
  // Foreign-session-leak protection lives HERE (not in the auto-add
  // below) — we filter tabs to ones whose live `session.cwd` matches
  // this workspace's `rootPath` before PUT, so a `?session=<foreignId>`
  // deeplink can't write its id into the persistent strip. Tabs we have
  // no `session.sessions` row for yet (brand-new sessions whose `init`
  // hasn't arrived; faked sessions in e2e) are kept — dropping them
  // would clobber the active-tab marker on first render. The old
  // approach (cwd-strict auto-add) blocked the *visible* tab during
  // boot whenever cwd hadn't landed yet, which left tests hanging on
  // an empty strip; filtering at persist time fixes that without
  // re-introducing the leak.
  useEffect(() => {
    if (!tabsHydrated) return;
    const root = activeWorkspace?.rootPath;
    const persistTabs = root
      ? openTabs.filter((id) => {
          const sess = session.sessions.find((s) => s.id === id);
          // Keep unknown sessions (no row yet) so the brand-new active
          // tab isn't dropped before its `init` event lands.
          return !sess || sess.cwd === root;
        })
      : openTabs;
    // The active marker is what the next page load resumes. Only treat
    // session.sessionId as "active" when it's actually in the persisted
    // strip — otherwise (e.g., closed-last-tab leaves sessionId
    // lingering, or the foreign-filter just removed it) we'd resume a
    // tab the user explicitly closed / shouldn't be opening here.
    const activeId =
      session.sessionId && persistTabs.includes(session.sessionId)
        ? session.sessionId
        : null;
    void fetch("/api/sessions/open-tabs", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tabs: persistTabs, activeId }),
    }).catch(() => {
      // Best-effort — a failed save just means the next reload sees the
      // last successfully persisted strip.
    });
  }, [
    openTabs,
    tabsHydrated,
    session.sessionId,
    session.sessions,
    activeWorkspace?.rootPath,
  ]);
  // Auto-add the active session id to the strip the moment it changes.
  // No cwd check here on purpose — the foreign-leak protection moved
  // up to the persist effect above. Doing the check at add-time used
  // to leave the strip empty during the brief window between
  // `bindToSession` setting `sessionId` and the SDK `init` event
  // landing `cwd`, which (a) flickered to "No session open" in
  // production and (b) hung tests whose faked EventSource never emits
  // an `init` with a cwd at all.
  //
  // Render-time "store previous props" pattern (same shape as the
  // latched permission-mode flag above) — not a useEffect — because
  // `react-hooks/set-state-in-effect` rejects setState inside effects.
  const [lastAddedKey, setLastAddedKey] = useState<string | null>(null);
  if (session.sessionId && lastAddedKey !== session.sessionId) {
    setLastAddedKey(session.sessionId);
    const sid = session.sessionId;
    setOpenTabs((prev) => (prev.includes(sid) ? prev : [...prev, sid]));
  }

  // Phase 3 of docs/electron-conversion/PLAN.md — closed-tab undo stack so
  // Cmd+Shift+T can restore the most recently closed tab. We only push when
  // closeTab actually removes a known id; reopen pops + reinserts at the
  // same index (clamped to the current length). The stack is in-memory only:
  // it doesn't survive a workspace switch or full reload, matching the
  // typical browser "reopen closed tab" UX.
  const closedTabsRef = useRef<{ id: string; index: number }[]>([]);

  const closeTab = useCallback(
    (id: string) => {
      setOpenTabs((prev) => {
        const idx = prev.indexOf(id);
        if (idx === -1) return prev;
        const next = prev.filter((x) => x !== id);
        closedTabsRef.current.push({ id, index: idx });
        // Cap the stack so a runaway loop can't OOM us.
        if (closedTabsRef.current.length > 64) closedTabsRef.current.shift();
        // If we just closed the active tab, switch to a neighbor — pick the
        // tab to the left of the closed one, falling back to the first tab.
        if (id === session.sessionId) {
          const target = next[Math.max(0, idx - 1)] ?? next[0] ?? null;
          if (target) {
            session.switchSession(target);
          }
          // If no tabs remain, leave the strip empty. session.sessionId
          // lingers at the just-closed id (harmless since nothing renders
          // against it while openTabs is empty); the next + click or
          // sidebar pick will create/select a session and re-populate.
        }
        return next;
      });
    },
    [session],
  );

  const reopenClosedTab = useCallback(() => {
    const last = closedTabsRef.current.pop();
    if (!last) return;
    setOpenTabs((prev) => {
      if (prev.includes(last.id)) return prev; // already back
      const clamped = Math.min(Math.max(last.index, 0), prev.length);
      const next = [...prev.slice(0, clamped), last.id, ...prev.slice(clamped)];
      return next;
    });
    // Focus the restored session immediately so reopen is one-step.
    session.switchSession(last.id);
  }, [session]);

  // Returns the ids that were actually closed so callers can react (e.g.
  // mark each session's unread notifications read). Empty array means the
  // user cancelled the confirm or there was nothing to close — either way
  // no state change happened, so no follow-up side effects should fire.
  const closeAllTabs = useCallback((): string[] => {
    if (openTabs.length === 0) return [];
    if (!confirm(`Close all ${openTabs.length} tabs? Sessions remain on disk.`)) return [];
    const closed = openTabs.slice();
    setOpenTabs([]);
    return closed;
  }, [openTabs]);

  // Drag-reorder: SessionTabs hands us splice-compatible indices and the
  // pure `reorderArray` helper handles the splice + bounds checks. The
  // persistence effect above will PUT the new order to /api/sessions/open-tabs
  // automatically — no extra wiring needed.
  const reorderTab = useCallback((fromIdx: number, toIdx: number) => {
    setOpenTabs((prev) => reorderArray(prev, fromIdx, toIdx));
  }, []);

  // Bash live-tail viewer ─────────────────────────────────────────────────
  const [openBash, setOpenBash] = useState<BackgroundBash | null>(null);
  // Re-pull the latest entry from state so the viewer reflects new tool_results
  // (status/killed updates) without remounting.
  const liveOpenBash = openBash
    ? session.backgroundBashes[openBash.toolUseId] ?? openBash
    : null;

  // Todos banner ──────────────────────────────────────────────────────────
  // The Clear button on the banner is wired to `session.clearTodos`, which
  // hits the durable server-side endpoint — so the cleared state survives
  // a reload and a server restart, not just a client-side banner hide. The
  // old local-only `todosBannerHidden` toggle (and its fingerprint-based
  // re-show) is gone now; the server's `latestTodosSnapshot` is the single
  // source of truth for whether the banner is visible.

  // Bumped by `/goal` with no args to open the GoalBanner's inline editor
  // (even before a goal exists). GoalBanner watches the value, not equality,
  // so each bump re-opens the editor.
  const [goalEditNonce, setGoalEditNonce] = useState(0);

  // Per-browser pref: whether the empty "Set a session goal" prompt is hidden.
  // Only suppresses the empty state (an active goal still shows); restored from
  // the collapsed title row's hover affordance or from Settings.
  const { hidden: goalBannerHidden, setHidden: setGoalBannerHidden } = useGoalBannerHidden();

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
      // Search hits carry the JSONL wrapper uuid; jumpToUuid resolves it to
      // the bubble's primary uuid (Anthropic message.id), which is what the
      // `data-message-uuid` attribute and highlight comparison key on.
      const resolved = await session.jumpToUuid(hit.messageUuid);
      if (!resolved) return;
      setHighlightUuid(resolved);
      setTimeout(() => setHighlightUuid((prev) => (prev === resolved ? null : prev)), 1500);
    },
    [session],
  );

  // "+" button in the Activity rail's To-dos section asks the agent to
  // append new TodoWrite items, preserving existing ones. Goes through
  // session.send so an in-flight turn just queues the request.
  const onAddTodos = useCallback(
    async (texts: string[]) => {
      const cleaned = texts.map((t) => t.trim()).filter(Boolean);
      if (cleaned.length === 0) return;
      const bullets = cleaned.map((t) => `- ${t}`).join("\n");
      const prompt = [
        "Use the TodoWrite tool to APPEND these item(s) to your current todo list.",
        "Preserve every existing item unchanged. New items have status `pending`.",
        "Do not run any other tool and do not write any text in your reply.",
        "",
        "Items to add:",
        bullets,
      ].join("\n");
      await session.send(prompt);
    },
    [session],
  );

  // "X" button on a scheduled-loop chip. The browser can't call CronDelete
  // directly (the tool only exists inside the agent runtime, not as a
  // Claudius API), so we send a short prompt asking the agent to do it.
  // The agent re-runs the loop reducer when it issues the CronDelete tool
  // call, so the chip flips to "cancelled" naturally — but we don't wait
  // for that here; the user clicked X expecting immediate feedback.
  const onCancelScheduledLoop = useCallback(
    async (loop: { id: string; kind: "cron" | "wakeup" }) => {
      if (loop.kind !== "cron") return;
      await session.send(
        `Please cancel the scheduled loop with id \`${loop.id}\` by calling \`CronDelete\` on it. Reply with one short line confirming it's cancelled — don't run any other tools.`,
      );
    },
    [session],
  );

  const liftQueued = useCallback(
    async (id: string) => {
      // `editQueued` round-trips to the server (DELETE-and-return), so it's
      // async now — await before pre-filling the composer.
      const item = await session.editQueued(id);
      if (item == null) return;
      draftTokenRef.current += 1;
      setDraftInjection({ token: draftTokenRef.current, text: item.text, images: item.images });
    },
    [session],
  );
  // Notification dispatch (permission_request, finished-a-turn, errors,
  // scheduled-run-finished, etc.) now flows server-side through the
  // NotificationBus → SSE → NotificationsProvider, which calls
  // useNotifications.notify() for us. The ad-hoc effects that used to live
  // here are intentionally gone — keeping them would double-fire OS
  // notifications. The provider still honours the per-workspace prefs
  // and the per-session block/snooze, so we get richer behaviour for free.
  const notifications = useNotificationsContext();

  // Clear the active session's unread notifications whenever the bound id
  // changes — covers boot/resume, tab clicks, notification jumps, and the
  // /clear-driven new-session path. The action is a no-op when there's
  // nothing unread for that session, so the cost is just a closure call.
  const markSessionReadAction = notifications.markSessionRead;
  useEffect(() => {
    if (!session.sessionId) return;
    void markSessionReadAction(session.sessionId);
  }, [session.sessionId, markSessionReadAction]);

  // Repaint non-active session tab status dots whenever the notification
  // state ticks. A non-active session has no per-tab SSE feeding `pending`
  // back into useSession, so its dot would otherwise stay stuck at whatever
  // /api/sessions returned on last refresh — usually "running" if the user
  // switched away mid-turn. Every state event the bus emits is a strong
  // signal that *something* happened on some session in this workspace
  // (turn finished → session_idle row, error → session_error row, etc.),
  // which is exactly when we want a fresh status snapshot. The refresh is
  // a cheap in-memory read on the server (no SDK round-trip). Skip the
  // initial 0 → 0 boot tick.
  const stateVersion = notifications.stateVersion;
  const refreshSessionsAction = session.refreshSessions;
  useEffect(() => {
    if (stateVersion === 0) return;
    void refreshSessionsAction();
  }, [stateVersion, refreshSessionsAction]);

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
        case "goal": {
          if (!session.sessionId) {
            showToast("No active session");
            return true;
          }
          const text = args.trim();
          if (text) {
            // `/goal <text>` sets the objective AND starts Claude on it (same
            // as submitting the header goal input) — a goal should "start
            // working" like the CLI, not sit passively.
            void session.setGoal(text).then((r) => {
              if (!r.ok) {
                showToast(`Goal failed: ${r.error}`);
                return;
              }
              void session.send(text, undefined, { fromGoal: true });
              showToast("Goal set — starting Claude");
            });
          } else {
            // No args — open the banner's inline editor (prefilled with the
            // current goal, if any).
            setGoalEditNonce((n) => n + 1);
          }
          return true;
        }
        case "exit": {
          router.push("/sessions");
          return true;
        }
        case "advisor": {
          // The SDK doesn't expose `/advisor` (typing it raw would return
          // "isn't available in this environment."), so we intercept it
          // here and open the SessionCard's model picker — which hosts the
          // verbatim "Advisor (experimental)" UI shared with the global
          // Settings page. A window CustomEvent is the lightest-weight
          // way to reach the SessionCard without lifting its `pickerOpen`
          // state to the page component. Matches the `claudius:session-
          // bound` event pattern used elsewhere in this codebase.
          if (typeof window !== "undefined") {
            try {
              window.dispatchEvent(new CustomEvent("claudius:open-advisor-picker"));
            } catch {
              // ignore — non-fatal
            }
          }
          return true;
        }
        case "recap": {
          // Manual recap trigger — the same path the away-blur watcher uses,
          // just with `"manual"` origin. The SDK's own `/recap` is a no-op
          // (it's a TUI-only feature), so without this dispatch typing
          // `/recap` would do nothing visible. Args are ignored on purpose:
          // the recap shape is a single one-liner; any args text would just
          // confuse the model.
          if (!session.sessionId) {
            showToast("No active session");
            return true;
          }
          void session.requestRecap("manual");
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
          // There's no dedicated statusline editor route in Claudius — the
          // few statusline knobs live inside the general settings page, so
          // the toast tells the user where to actually look.
          showToast("Statusline lives under Settings");
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
        // The four auth/provider commands all land on the Usage page (the
        // single screen that owns the API-key + Bedrock + Vertex switches).
        // Per-command toast so the user knows what action to take once they
        // arrive — generic "/login goes to /usage" would feel disconnected.
        case "login":
          showToast("Sign in to Anthropic on the Usage page");
          router.push("/usage");
          return true;
        case "logout":
          showToast("Sign out from the Usage page");
          router.push("/usage");
          return true;
        case "setup-bedrock":
          showToast("Configure Amazon Bedrock under Usage → Provider");
          router.push("/usage");
          return true;
        case "setup-vertex":
          showToast("Configure Google Vertex AI under Usage → Provider");
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
        // /heapdump is now SDK-forwarded so the user sees the rich agent
        // subprocess diagnostic (.heapsnapshot + breakdown + native-memory
        // hints) instead of a single server-side process-report path. The
        // server-side variant is still reachable at `POST /api/heapdump`
        // when we need to introspect the Next process itself; it's just
        // not bound to a slash command anymore.

        // ─── Integration / install commands ─────────────────────────────
        // Each opens its install or settings page in the user's browser.
        // These used to be `external` toasts ("install from the terminal CLI")
        // which was meaningless guidance — the install URL is the install URL
        // whether you're in a terminal, a browser, or Electron.
        case "install-github-app":
          openExternalUrl(SLASH_LINKS.githubApp);
          showToast("Opening the Claude GitHub App install page");
          return true;
        case "install-slack-app":
          openExternalUrl(SLASH_LINKS.slackApp);
          showToast("Opening the Claude Slack app install page");
          return true;
        case "chrome":
          // Premise doesn't apply: the CLI's /chrome lets a terminal drive a
          // browser. Claudius already runs *in* Chromium (Electron) and has
          // its own DOM. No URL — just say so.
          showToast("Claudius runs in Chromium already — no separate Chrome integration to configure");
          return true;
        case "ide":
          // CLI's /ide bridges a terminal to an editor. Claudius IS the
          // editor for the active workspace, so the Files page is the
          // closest analog. Same shape as the /powerup → /release-notes
          // remapping a few cases below.
          showToast("Claudius is the IDE — opening the Files browser");
          router.push("/files");
          return true;
        case "web-setup":
          // The terminal CLI's /web-setup is an interactive OAuth flow
          // (GitHub authorize → callback → token). No static landing page
          // exists — the docs are the closest stable destination and walk
          // the user through what /web-setup would have done.
          openExternalUrl(SLASH_LINKS.webSetupDocs);
          showToast("Opening the Claude Code on the web docs");
          return true;

        // ─── Platform / hosted ──────────────────────────────────────────
        case "desktop":
          // Branch on isElectron via the bridge we already capture above.
          // In Electron: small joke — the user IS the desktop user.
          // In the browser: nudge them at the GitHub Releases page (same
          // destination as the existing WebDesktopBanner — single source of
          // truth for the download URL).
          if (claudiusBridge?.isElectron) {
            showToast("You're already in the desktop app — /desktop is for CLI Claude trying to escape 🖥️");
          } else {
            openExternalUrl(SLASH_LINKS.claudiusReleases);
            showToast("Grab the Claudius desktop app from GitHub Releases");
          }
          return true;
        case "mobile":
          openExternalUrl(SLASH_LINKS.mobileApp);
          showToast("Opening the Claude mobile app download page");
          return true;
        case "passes":
          // CLI-only feature — the SDK does NOT advertise `/passes` in its
          // `supportedCommands()` response (verified by probing the live
          // SDK with a `query()` + `supportedCommands()` call). There's
          // also no public landing page to deep-link to; codes are minted
          // by the terminal-CLI flow against the user's MAX-plan account.
          // Honest toast beats a fake URL or a dead SDK forward.
          showToast("/passes mints guest passes from the terminal CLI — not exposed by the SDK or claude.ai");
          return true;
        case "stickers":
          // The CLI's /stickers shows an interactive shipping form which
          // Claudius can't render — but the Sticker Mule store is the
          // canonical Claude Code merch destination either way.
          openExternalUrl(SLASH_LINKS.stickers);
          showToast("Opening the Claude Code store on Sticker Mule");
          return true;
        case "upgrade":
          openExternalUrl(SLASH_LINKS.upgradePlan);
          showToast("Opening the Claude plan upgrade page");
          return true;

        // These three exist in the CLI but have no Claudius counterpart yet.
        // Toast instead of opening a URL so we don't dump the user on a
        // claude.ai page that won't recognise their local context.
        case "teleport":
          showToast("Teleport pulls a claude.ai session into the terminal CLI — Claudius doesn't import hosted sessions yet");
          return true;
        case "remote-control":
          showToast("Remote control lets claude.ai drive a terminal Claude Code session — not exposed by Claudius");
          return true;
        case "remote-env":
          showToast("Remote environments are configured on claude.ai");
          return true;

        // ─── Info / meta ────────────────────────────────────────────────
        case "feedback":
          // Same destination FeedbackBanner falls back to. /feedback is about
          // the agent experience, so it lands on claude-code's issues, not
          // Claudius's repo. (If a future user wants to file a Claudius bug,
          // they can use the picker / `/help`.)
          openExternalUrl(SLASH_LINKS.claudeCodeIssues);
          showToast("Opening the Claude Code issues page");
          return true;
        case "powerup":
          // No animated tour in Claudius. The Release notes page is the
          // closest analog — it's where "what's new in this version" lives.
          showToast("Feature tour lives on the Release notes page");
          router.push("/release-notes");
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
    // `claudiusBridge` identity is stable for the lifetime of the renderer
    // (see lib/client/useElectron.ts), so listing it doesn't churn the
    // callback — but eslint-rule-of-hooks wants it spelled out so a future
    // bridge-identity change doesn't silently break the /desktop branch.
    [router, session, showToast, claudiusBridge],
  );

  const handleSend = useCallback(
    (
      text: string,
      images?: Array<{ id?: string; ordinal?: number; data: string; mediaType: string }>,
      opts?: { fromSuggestion?: boolean },
    ) => {
      const trimmed = text.trim();
      // Slash dispatch only when there are no images attached.
      if (trimmed.startsWith("/") && !images?.length) {
        const head = trimmed.slice(1).split(/\s+/, 1)[0] ?? "";
        const args = trimmed.slice(1 + head.length).trim();
        const cmd = findSlashCommand(head);
        if (cmd?.handler === "native") {
          if (runNative(cmd.id, args)) return;
          // Registry classifies as `native` but `runNative` returned false
          // (the `default:` arm — a registry entry whose case got removed
          // without delisting the command). Don't let it fall through to
          // the "unknown command" toast, which would misclassify a known
          // command as a typo. Surface the real condition.
          showToast(`/${cmd.name} isn't wired up yet`);
          return;
        }
        if (cmd?.handler === "external") {
          // Per-command explanation when we have one; generic fallback
          // otherwise. The toast is the *only* feedback for these, since
          // the registry classifies them as "advertise but don't run."
          showToast(EXTERNAL_SLASH_MESSAGE[cmd.id] ?? `/${cmd.name} is terminal/hosted only`);
          return;
        }
        if (cmd?.handler === "sdk") {
          // SDK-interpreted slash command (e.g. /compact, /init).
          // BEFORE forwarding, validate against the live SDK list: probing
          // `supportedCommands()` against a real session revealed that
          // several static registry entries (`/sandbox`, `/effort`,
          // `/fast`, `/color`, `/diff`, `/focus`, `/btw`, `/extra-usage`,
          // `/ultraplan`, `/ultrareview`, `/autofix-pr`, `/advisor`)
          // aren't reported by the SDK on the version we ship. Forwarding
          // them silently let the model see a literal `/foo` and reply
          // with confused prose. With the live check, the user gets a
          // clear toast instead — and the picker still surfaces the
          // command, so the discoverability is intact.
          //
          // Live-known commands (curated registry + skills + plugin-bundled
          // ones) flow through unchanged.
          if (session.slashCommands.includes(head)) {
            // Route through the no-echo path so the chat shows a "Running
            // /compact…" pill instead of a user message whose text is the
            // literal slash command. The SDK still receives the text and
            // interprets it as a slash; its eventual reply
            // (compact_boundary, init system message, etc.) lands as its
            // own event.
            void session.send(text, undefined, { asSlashCommand: true });
            return;
          }
          showToast(`/${cmd.name} isn't recognised by the Claude Code SDK on this version`);
          return;
        }
        // Not in the curated registry. Two possibilities:
        //
        //  1. It's a plugin / SDK-supplied command the registry doesn't
        //     hardcode but the live SDK reports via system:init
        //     (`session.slashCommands`) — those should still flow through as
        //     SDK slash commands so plugin-installed commands keep working.
        //
        //  2. It's a typo or a command that doesn't exist anywhere — silently
        //     sending `/lkjasdf` to the model is the wrong default (it
        //     confuses the model AND eats the user's input). Toast and stop.
        if (session.slashCommands.includes(head)) {
          void session.send(text, undefined, { asSlashCommand: true });
          return;
        }
        showToast(`Unknown command: /${head} — type / to see what's available`);
        return;
      }
      void session.send(text, images, opts?.fromSuggestion ? { fromSuggestion: true } : undefined);
    },
    [runNative, session, showToast],
  );

  // Goal submit — set the tracked objective AND kick off Claude with the same
  // text as the opening prompt (so a goal "starts working" like the CLI rather
  // than sitting passively). `setGoal` is awaited first so the server arms the
  // goal (and its one-shot reminder, which carries the report_goal_achieved
  // instruction) before the input turn is queued. The goal text is sent
  // verbatim — no slash dispatch — since the goal input disables commands.
  const handleGoalSubmit = useCallback(
    async (text: string, images?: AttachedImage[]) => {
      const trimmed = text.trim();
      if (!trimmed && !(images && images.length > 0)) return;
      await session.setGoal(trimmed);
      void session.send(trimmed, images, { fromGoal: true });
    },
    [session],
  );

  // ── Prompt history (shell-style recall) ─────────────────────────────────
  // The previously sent user prompts, oldest → newest, for the composer's
  // Cmd/Ctrl+↑/↓ recall. We flatten each user message's text blocks, strip
  // the `[Image #N]` attachment tokens (the images themselves aren't recalled,
  // so leaving the tokens would send dangling references), drop empties, and
  // collapse consecutive duplicates so repeated re-runs don't pad the history.
  const promptHistory = useMemo(() => {
    const out: string[] = [];
    for (const m of session.messages) {
      if (m.role !== "user") continue;
      const text = m.blocks
        .map((b) => (b.kind === "text" ? b.text : ""))
        .join("")
        .replace(/\[Image #\d+\]/g, "")
        .replace(/ {2,}/g, " ")
        .trim();
      if (!text) continue;
      if (out.length > 0 && out[out.length - 1] === text) continue;
      out.push(text);
    }
    return out;
  }, [session.messages]);

  // ── Context-warning Compact action ──────────────────────────────────────
  // Count of compaction dividers in the transcript. A successful /compact
  // (manual or summary-derived) increments this; we use the edge as the
  // "compaction finished" signal rather than `pending` alone, since /compact
  // is fired as a slash command and the boundary is the event we care about.
  const compactBoundaryCount = session.systemEntries.filter(
    (e) => e.kind === "compact_boundary",
  ).length;
  const compactStartCountRef = useRef(0);
  const compactSawPendingRef = useRef(false);
  // Latest context reading, mirrored into a ref so the completion effect can
  // snapshot it without taking ctxSummary as a dep (which would re-run it on
  // every poll).
  const ctxSummaryRef = useRef<ContextSummary | null>(ctxSummary);
  useEffect(() => {
    ctxSummaryRef.current = ctxSummary;
  }, [ctxSummary]);
  // The context reading at the moment compaction finished — settle ends as
  // soon as a *different* reading (a fresh poll) replaces it.
  const ctxSettleBaselineRef = useRef<ContextSummary | null>(null);

  // Kick off a tracked /compact. Shared by both the warning banner's button
  // and the StatusLine header button — `setCompacting(true)` makes the
  // ContextWarningBanner render its "Compacting…" indicator for the duration
  // regardless of whether the warning threshold was crossed, so compacting
  // from the header surfaces the same feedback as compacting from the banner.
  const startCompaction = useCallback(() => {
    // Guard: send() queues behind a running turn, so don't kick off a
    // compaction we can't track. Both buttons are also disabled in this
    // state, but guard here too in case it's invoked another way.
    if (compacting || session.pending) return;
    compactStartCountRef.current = compactBoundaryCount;
    compactSawPendingRef.current = false;
    setCompacting(true);
    handleSend("/compact");
  }, [compacting, session.pending, compactBoundaryCount, handleSend]);

  // Resolve the compacting state. Done when a new compact_boundary lands;
  // fall back to a pending true→false edge (compaction errored / no-op) so the
  // indicator never sticks.
  useEffect(() => {
    if (!compacting) return;
    if (session.pending) compactSawPendingRef.current = true;
    const finishedWithBoundary = compactBoundaryCount > compactStartCountRef.current;
    const finishedWithoutBoundary = compactSawPendingRef.current && !session.pending;
    if (finishedWithBoundary || finishedWithoutBoundary) {
      setCompacting(false);
      // Re-poll context now and hide the banner until that fresh reading lands.
      ctxSettleBaselineRef.current = ctxSummaryRef.current;
      setCtxSettling(true);
      setCtxRefreshSignal((n) => n + 1);
    }
  }, [compacting, session.pending, compactBoundaryCount]);

  // Safety net: never leave the progress bar spinning forever.
  useEffect(() => {
    if (!compacting) return;
    const id = window.setTimeout(() => setCompacting(false), 120_000);
    return () => window.clearTimeout(id);
  }, [compacting]);

  // End the post-compact settle window as soon as a fresh context reading
  // lands (ctxSummary is a new object per poll), or after a short safety cap.
  useEffect(() => {
    if (!ctxSettling) return;
    if (ctxSummary !== ctxSettleBaselineRef.current) {
      setCtxSettling(false);
      return;
    }
    const id = window.setTimeout(() => setCtxSettling(false), 4_000);
    return () => window.clearTimeout(id);
  }, [ctxSettling, ctxSummary]);

  const showContextWarning =
    !ctxSettling && shouldShowContextWarning(ctxSummary?.percentage, contextWarningPct);

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

  // Scope the session-picker dropdown to the active workspace. A session
  // belongs to this workspace when its cwd equals the workspace rootPath —
  // the same exact-match rule the server uses for `/api/sessions?workspaceId`.
  // The currently-bound `session.sessionId` is always kept so the picker
  // label has a matching row to highlight even when that session belongs to
  // another workspace (e.g. a stale `?session=` URL); the auto-add effect
  // below makes sure that escape-hatch session does NOT get persisted into
  // this workspace's openTabs strip — which used to be the leak that put
  // foreign sessions in the dropdown permanently.
  //
  // While the workspace list / URL param is still resolving (`root` null),
  // return [] rather than the unfiltered `session.sessions`. A briefly
  // empty dropdown is the correct UX; the previous fallback was responsible
  // for "new workspace opens with many sessions" because `session.sessions`
  // is server-fetched cross-workspace and only client-side filtering keeps
  // it scoped.
  const pickerSessions = useMemo(() => {
    const root = activeWorkspace?.rootPath;
    if (!root) return [];
    const activeId = session.sessionId;
    return session.sessions.filter((s) => s.cwd === root || s.id === activeId);
  }, [session.sessions, session.sessionId, activeWorkspace?.rootPath]);

  // Build the SessionInfo list used by `tabLabelFor` below. We patch
  // synthetic `{ id, title }` rows for any open tab that isn't (yet)
  // present in `session.sessions` but has a title in the persisted
  // `openTabTitles` map. Live entries always win — so renames flowing
  // through `refreshSessions` keep priority, and the fallback only fires
  // for the gaps described where `openTabTitles` is declared.
  const sessionsForTabs = useMemo<SessionInfo[]>(() => {
    const known = new Set(session.sessions.map((s) => s.id));
    const extras: SessionInfo[] = [];
    for (const id of openTabs) {
      if (known.has(id)) continue;
      const title = openTabTitles[id];
      if (title) extras.push({ id, title });
    }
    return extras.length === 0 ? session.sessions : [...session.sessions, ...extras];
  }, [session.sessions, openTabs, openTabTitles]);

  return (
    <div className="flex h-full">
      <SideNav running={session.pending} />
      <main data-pane-name="chat-area" className="relative flex h-full min-w-0 flex-1 flex-col">
        <SessionTabs
          tabs={openTabs.map((id) => {
            // Status resolution for the dot on each tab:
            //   - active tab → derive from local useSession state (freshest;
            //     pending flips before the next server poll lands).
            //   - non-active but in `session.sessions` → use the server's
            //     in-memory status. Refreshed on the active session's
            //     `result` event and on visibilitychange, so the dots track
            //     real state without a dedicated SSE per tab.
            //   - reaped (id missing from the live list) → "background". The
            //     SDK process is gone; clicking the tab will resume from
            //     disk via /api/sessions/:id/stream.
            let status: TabStatus;
            if (id === session.sessionId) {
              status = activeTabStatus({
                ready: session.ready,
                pending: session.pending,
                hasError: session.errors.length > 0,
              });
            } else {
              const live = session.sessions.find((s) => s.id === id);
              status = live?.status ?? "background";
            }
            return {
              id,
              label:
                id === session.sessionId
                  ? tabLabelFor(id, sessionsForTabs, session.sessionTitle)
                  : tabLabelFor(id, sessionsForTabs),
              status,
              unread: notifications.unreadBySession[id],
            };
          })}
          activeId={session.sessionId}
          onSelect={(id) => {
            if (id !== session.sessionId) session.switchSession(id);
            // "Selecting" a tab implies "I'm looking at this session now" —
            // clear its unread badge AND its contribution to the bell-tile
            // total. Re-selecting the current tab is harmless: the action
            // exits early when the per-session count is already 0.
            void notifications.markSessionRead(id);
          }}
          onClose={(id) => {
            // Closing a tab implies "I'm done with this session". Clear the
            // session's unread notifications so they don't linger as ghosts
            // on the workspace badge — orphaned counts were the symptom that
            // surfaced this code path. markSessionRead exits cheaply when the
            // per-session count is already 0, so the order doesn't matter.
            void notifications.markSessionRead(id);
            closeTab(id);
          }}
          onCloseAll={() => {
            // Same contract as onClose, but across every currently-open tab.
            // closeAllTabs returns the ids it actually closed (empty when the
            // user cancels its confirm), so we only mark notifications read
            // for tabs that really went away.
            const closed = closeAllTabs();
            for (const id of closed) void notifications.markSessionRead(id);
          }}
          onNew={() => void session.createNewSession()}
          onReopen={reopenClosedTab}
          onReorder={reorderTab}
          labelMaxWidth={tabLabelMaxWidth ?? undefined}
          onLabelWidthChange={onTabLabelWidthChange}
        />
        {openTabs.length === 0 ? (
          <div className="flex flex-1 items-center justify-center text-center">
            <div className="flex max-w-sm flex-col items-center px-6 py-12">
              <ClaudiusMark color="var(--foreground)" size={120} className="mb-5 opacity-90" />
              <h1 className="mb-2 text-3xl font-semibold tracking-tight">Claudius</h1>
              <p className="mb-6 text-sm text-[var(--muted)]">No session open.</p>
              <button
                type="button"
                onClick={() => void session.createNewSession()}
                className="rounded-md border border-[var(--border)] bg-[var(--panel)] px-4 py-2 text-sm hover:bg-[var(--panel-2)]"
              >
                + New session
              </button>
            </div>
          </div>
        ) : (
        <>
        <StatusLine
          workspace={activeWorkspace}
          sessionId={session.sessionId}
          ready={session.ready}
          pending={session.pending}
          permissionMode={session.permissionMode}
          model={session.model}
          mainAgent={session.mainAgent}
          sessionRoot={session.cwd}
          agentCwd={session.agentCwd}
          onPickAgent={session.setAgent}
          onModeChange={session.setPermissionMode}
          sessions={pickerSessions}
          onSwitchSession={(id) => {
            // Re-add to strip in case the user closed all tabs and is
            // re-picking the same session that's still bound internally —
            // switchSession is a no-op when ids match, so the auto-add
            // effect would never fire.
            setOpenTabs((prev) => (prev.includes(id) ? prev : [...prev, id]));
            session.switchSession(id);
          }}
          onCreateNewSession={session.createNewSession}
          onRefreshSessions={session.refreshSessions}
          contextPercent={ctxSummary?.percentage}
          onOpenContext={() => setOverlay("context")}
          fastModeState={session.fastModeState}
          totalCostUsd={session.usage?.totalCostUsd}
          outputTokens={session.usage?.outputTokens}
          onOpenCost={() => setOverlay("cost")}
          notificationsEnabled={notifications.workspaceEnabled}
          notificationsState={notifications.permissionState}
          onToggleNotifications={() => void notifications.toggleWorkspaceEnabled()}
          verbose={verbose.verbose}
          onChangeVerbose={verbose.setVerbose}
          // Route the header Compact button through the same handler as the
          // warning banner's button so it surfaces the ContextWarningBanner
          // (with its progress bar) for the duration of the compaction — even
          // when context is below the warning threshold and the banner wasn't
          // already showing.
          onCompact={startCompaction}
          onClear={() => {
            if (
              session.messages.length === 0 ||
              confirm("Start a new session? The current conversation is preserved on disk.")
            ) {
              // Clear === reset: spin up a new session AND close the current
              // tab so the user lands on the fresh one with nothing left over.
              // Without the filter, the auto-add effect just appends the new
              // session next to the old one and the user has two tabs open.
              // We skip closeTab() because it would switchSession to a
              // neighbor when the active tab is the one being closed — we
              // already want the new session to take focus.
              const oldId = session.sessionId;
              void session.createNewSession();
              if (oldId) {
                void notifications.markSessionRead(oldId);
                setOpenTabs((prev) => prev.filter((x) => x !== oldId));
              }
            }
          }}
        />
        <LoadingBar
          ready={session.ready}
          pending={session.pending}
          replaying={session.replaying}
        />
        <PlanModeBanner
          mode={session.permissionMode}
          onExit={() => void session.setPermissionMode("default")}
        />
        {/* One-shot launch announcement, pinned above the session header so
            it sits at the very top of the feed. Mirrors the Claude Code TUI's
            `tengu-top-of-feed-tip`; per-browser localStorage dismiss. */}
        <OpusLaunchTipBanner sessionId={session.sessionId} />
        {/* Session header — title and goal share one panel (two rows, one
            border) since both are session-level metadata. */}
        {session.sessionId && (
          <div
            data-testid="session-header"
            className="border-b border-[var(--border)] bg-[var(--panel-2)]/40"
          >
            <RecapBanner
              embedded
              goalRowBelow={Boolean(session.goal) || !goalBannerHidden}
              onShowGoal={
                !session.goal && goalBannerHidden
                  ? () => {
                      // Un-hide AND open the inline editor straight away (same
                      // nonce bump as `/goal`), so the click lands the user in
                      // the composer rather than back on the empty prompt. If
                      // they Esc out, the now-unhidden prompt remains.
                      setGoalBannerHidden(false);
                      setGoalEditNonce((n) => n + 1);
                    }
                  : undefined
              }
              sessionId={session.sessionId}
              title={session.sessionTitle}
              onRename={session.renameTitle}
            />
            <GoalBanner
              embedded
              goal={session.goal}
              onClear={session.clearGoal}
              onSubmitGoal={handleGoalSubmit}
              openEditNonce={goalEditNonce}
              hidden={goalBannerHidden}
              onHide={() => setGoalBannerHidden(true)}
              composer={{
                ready: session.ready,
                pending: session.pending,
                cwd: session.cwd,
                onInterrupt: session.interrupt,
              }}
            />
          </div>
        )}
        <TodosAutoClearedToast
          payload={session.todosAutoCleared}
          onDismiss={session.dismissTodosAutoCleared}
        />
        <TodosBanner
          todos={session.latestTodos}
          onDismiss={() => {
            // Durable clear: the server nulls its snapshot, persists the
            // marker so a JSONL-rebuild can't resurrect the list, and
            // broadcasts an empty `session_snapshot` that the client
            // reducer folds into `latestTodos = []`. No client-only hide
            // state — the server is authoritative for visibility now.
            void session.clearTodos();
          }}
          onUpdateItem={(itemId, action) => {
            // Targeted per-item edit: status flip or delete. Server
            // mutates the snapshot, persists a `manualTodoOverrides`
            // entry for restart durability, and broadcasts the new
            // snapshot. The SSE round-trip drives the UI update — no
            // optimistic state here.
            void session.updateTodoItem(itemId, action);
          }}
        />
        <FeedbackBanner
          survey={session.feedbackSurvey}
          onSubmit={session.submitFeedback}
          onDismiss={session.dismissFeedback}
        />
        <OpusOverloadNudgePanel
          nudge={session.opusOverloadNudge}
          onSwitchToSonnet={async () => {
            // One-click switch to the canonical Sonnet id used elsewhere in the
            // codebase. Dismiss BEFORE the await so the banner clears optimistically
            // even if the model API round-trip is slow.
            session.dismissOpusOverloadNudge();
            await session.setModel(OPUS_OVERLOAD_NUDGE_SONNET_TARGET);
          }}
          onDismiss={session.dismissOpusOverloadNudge}
        />
        <LongContextCreditsPanel
          nudge={session.longContextCreditsNudge}
          onOpenModelPicker={() => {
            // Prefill the composer with `/model ` so the existing slash-command
            // autocomplete renders the model picker — same affordance as
            // typing `/model` in the CLI, no hardcoded fallback target since
            // "standard-context" covers any non-1M Sonnet/Opus the user prefers.
            // Dismiss optimistically; the prefill lands on the next tick.
            session.dismissLongContextCreditsNudge();
            draftTokenRef.current += 1;
            setDraftInjection({
              token: draftTokenRef.current,
              text: "/model ",
            });
          }}
          onDismiss={session.dismissLongContextCreditsNudge}
        />
        <FastModeNoticePanel
          notice={session.fastModeNotice}
          onDismiss={session.dismissFastModeNotice}
        />
        <ModelSwitchNoticePanel
          notice={session.modelSwitchNotice}
          onDismiss={session.dismissModelSwitchNotice}
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
            sessionId={session.sessionId ?? undefined}
            tasks={session.tasks}
            subagentMessages={session.subagentMessages}
            replaying={session.replaying}
            hasMoreAbove={session.hasMoreAbove}
            loadingOlder={session.loadingOlder}
            onLoadOlder={session.loadOlder}
            highlightUuid={highlightUuid}
            onPickExample={handleSend}
            onRunCommand={handleSend}
            // Filter conditional tips (e.g. multi-Claude color/rename nudge,
            // gated on 2+ open tabs; the post-Plan-Mode "make it sticky"
            // nudge, gated on `planModeUsed && !defaults.permissionMode`;
            // the /powerup onboarding nudge, gated on `startupCount < 10`)
            // before they hit the rotation. Falling back to DEFAULT_TIPS
            // *before* filtering closes the pre-SSE window where SpinnerTip
            // would otherwise use its own unfiltered fallback and surface
            // the threshold tip with one session open.
            tips={selectClientTips(
              session.tips.length > 0 ? session.tips : DEFAULT_TIPS,
              openTabs.length,
              {
                planModeNudgeEligible:
                  planModeUsed && !activeWorkspace?.defaults?.permissionMode,
                newUser: startupCount < 10,
              },
            )}
            suggestedUuids={session.suggestedUuids}
            goalUuids={session.goalUuids}
            verbose={verbose.verbose}
            pendingAskToolUseId={session.pendingAsk?.toolUseId ?? null}
            // Two paths depending on which row was clicked:
            //   - Live: tool_use id matches `pendingAsk` — clear the
            //     "minimized" flag and let the existing modal render
            //     condition fall through.
            //   - Historic: any other ask row. The SDK has already received
            //     a tool_result for this question (often an error from the
            //     permission stream closing). We can't answer it back to
            //     the agent, so we resurrect the modal locally and treat
            //     its submit as a fresh user prompt.
            onReopenAsk={({ toolUseId, input }) => {
              if (session.pendingAsk?.toolUseId === toolUseId) {
                setAskMinimizedFor(null);
                return;
              }
              const questions = parseAskQuestions(input);
              if (questions.length === 0) {
                showToast("Couldn't recover the question — input shape unknown");
                return;
              }
              setResurrectedAsk({
                requestId: `resurrected:${toolUseId}`,
                toolUseId,
                questions,
              });
            }}
            // Approaching-limit remediation levers. The `allowed_warning`
            // branch of the inline RateLimitPill renders model-aware and
            // effort-aware chips that reuse the same setModel/setEffort
            // plumbing as the picker — gated on Opus / high-effort sessions
            // so the chip never offers a no-op.
            systemPillLevers={{
              model: session.model,
              effort: session.effort,
              onSwitchToSonnet: () =>
                session.setModel(OPUS_OVERLOAD_NUDGE_SONNET_TARGET),
              onStepEffortDown: () => session.setEffort("medium"),
            }}
          />
          {session.errors.length > 0 && (
            <div className="mx-auto w-full max-w-[var(--chat-col)] px-4 pb-2">
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
            onPick={(s) => handleSend(s, undefined, { fromSuggestion: true })}
          />
          <QueueIndicator
            queue={session.queue}
            onCancel={session.cancelQueued}
            onEdit={liftQueued}
            onReorder={session.reorderQueued}
            onSendNow={session.sendQueuedNow}
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
          {(showContextWarning || compacting) && (
            <ContextWarningBanner
              percentage={ctxSummary?.percentage ?? 0}
              compacting={compacting}
              pending={session.pending}
              onCompact={startCompaction}
            />
          )}
          {session.pendingAsk && askMinimizedFor === session.pendingAsk.requestId && (
            <div className="mx-auto flex w-full max-w-[var(--chat-col)] items-center gap-2 px-4 pb-2">
              <button
                type="button"
                onClick={() => setAskMinimizedFor(null)}
                className="flex w-full items-center gap-2 rounded-md border border-[var(--accent)]/40 bg-[var(--accent)]/10 px-3 py-2 text-left text-xs text-[var(--foreground)] hover:bg-[var(--accent)]/15"
              >
                <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[var(--accent)]" />
                <span className="font-medium">Question pending</span>
                <span className="truncate text-[var(--muted)]">
                  {session.pendingAsk.questions[0]?.question ?? "Awaiting your answer"}
                </span>
                <span className="ml-auto shrink-0 rounded border border-[var(--border)] bg-[var(--panel-2)] px-1.5 py-0.5 text-[10px] text-[var(--muted)]">
                  Click to answer
                </span>
              </button>
            </div>
          )}
          <SessionRecapBanner
            recap={session.sessionRecap}
            onDismiss={session.dismissRecap}
          />
          <div data-pane-name="composer">
            <PromptInput
              ready={session.ready}
              pending={session.pending}
              slashCommands={session.slashCommands}
              skills={session.skills}
              cwd={session.cwd}
              sessionId={session.sessionId}
              onSend={handleSend}
              onInterrupt={session.interrupt}
              draftInjection={draftInjection}
              promptHistory={promptHistory}
              sendDisabled={capBreached || tabClaim.readOnly}
              queuedCount={session.queue.length}
              // Capture file drops across the whole chat-area pane (message
              // list, banners, tabs, gutters) — not just the composer row.
              // GoalBanner's PromptInput intentionally leaves this off so the
              // two instances don't race for the same drop.
              wideDropTarget
            />
          </div>
        </div>
        </>
        )}
      </main>
      <BackgroundTasksPanel
        progress={session.toolProgress}
        tasks={session.tasks}
        sessionId={session.sessionId}
        model={session.model}
        effort={session.effort}
        permissionMode={session.permissionMode}
        cwd={session.cwd}
        usage={session.usage}
        historicalTurnCount={session.messages.filter((m) => m.role === "assistant").length}
        ready={session.ready}
        pending={session.pending}
        pendingPermission={session.pendingPermission}
        latestTodos={session.latestTodos}
        recentEdits={session.recentEdits}
        backgroundBashes={session.backgroundBashes}
        scheduledLoops={session.scheduledLoops}
        toolHistory={session.toolHistory}
        onOpenBash={setOpenBash}
        onCancelScheduledLoop={onCancelScheduledLoop}
        onAddTodos={onAddTodos}
        onClearTodos={session.clearTodos}
        onUpdateTodoItem={(itemId, action) => {
          // Per-item edit from the rail's To-dos widget — mirror of the
          // banner wiring above. Routes to `session.updateTodoItem` which
          // persists a manual override and broadcasts the new snapshot.
          void session.updateTodoItem(itemId, action);
        }}
        onChangeModel={session.setModel}
        onChangeEffort={session.setEffort}
        ultracode={session.ultracode}
        onChangeUltracode={session.setUltracode}
        fastMode={session.fastMode}
        onChangeFast={session.setFast}
        advisorModel={session.advisorModel}
        onChangeAdvisorModel={session.setAdvisorModel}
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
          sessionId={session.sessionId}
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
          onClose={() => {
            // Closing without an explicit accept/reject is a soft reject —
            // we still have to resolve the SDK's canUseTool promise or the
            // agent hangs. Send a generic "user dismissed" deny.
            void session.resolvePlan({ kind: "reject", message: "User dismissed the plan." });
            showToast("Plan dismissed — still in plan mode");
          }}
          onAccept={(editedPlan) => {
            void session.resolvePlan({ kind: "accept", editedPlan });
            showToast(
              editedPlan
                ? "Edited plan accepted — switched to acceptEdits"
                : "Plan accepted — switched to acceptEdits",
            );
          }}
          onReject={() => {
            void session.resolvePlan({ kind: "reject" });
            showToast("Plan rejected — keep iterating");
          }}
        />
      )}

      {session.pendingPermission && (
        <PermissionPrompt
          request={session.pendingPermission}
          onResolve={(d) => session.resolvePermission(session.pendingPermission!.requestId, d)}
        />
      )}

      {session.pendingAsk && askMinimizedFor !== session.pendingAsk.requestId && (
        <AskUserQuestionPrompt
          request={session.pendingAsk}
          sessionLabel={
            session.sessionId
              ? tabLabelFor(session.sessionId, session.sessions, session.sessionTitle)
              : null
          }
          onSubmit={(answers) =>
            session.submitAskAnswer(session.pendingAsk!.requestId, answers)
          }
          onCancel={() =>
            // Cancel = decline-but-graceful: send empty answers so the SDK
            // doesn't hang. The model treats this as the user declining.
            session.submitAskAnswer(session.pendingAsk!.requestId, [])
          }
          onMinimize={() => setAskMinimizedFor(session.pendingAsk!.requestId)}
        />
      )}

      {/* Resurrected modal — only renders when there's NO live ask in flight
          so the two can never stack. Submitting feeds the answers as a fresh
          user prompt instead of through `submitAskAnswer` (the SDK has no
          matching pending requestId on the server side anymore). */}
      {!session.pendingAsk && resurrectedAsk && (
        <AskUserQuestionPrompt
          request={{
            type: "ask_user_question",
            requestId: resurrectedAsk.requestId,
            toolUseId: resurrectedAsk.toolUseId,
            questions: resurrectedAsk.questions,
          }}
          sessionLabel={
            session.sessionId
              ? tabLabelFor(session.sessionId, session.sessions, session.sessionTitle)
              : null
          }
          onSubmit={(answers) => {
            const text = formatAskAsPrompt(resurrectedAsk.questions, answers);
            setResurrectedAsk(null);
            handleSend(text);
          }}
          onCancel={() => setResurrectedAsk(null)}
          onMinimize={() => setResurrectedAsk(null)}
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
