"use client";

import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { ArrowUp, Hourglass, Image as ImageIcon, Mic, MicOff, Paperclip, Sparkles, Square, X } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { SlashCommandPicker } from "./SlashCommandPicker";
import { AtMentionPicker } from "./AtMentionPicker";
import { ImageLightbox } from "./ImageLightbox";
import { useVoice } from "@/lib/client/useVoice";
import { useSdkCommands } from "@/lib/client/useSdkCommands";
import { commandNeedsSudo, sendBash } from "@/lib/client/sendBash";
import { readBridgeOnClient } from "@/lib/client/useElectron";
import { resolveDroppedPath } from "@/lib/client/file-paths";
import type { AttachedImage } from "@/lib/client/types";
import {
  BULLET_GLYPH,
  bulletsToMarkdown,
  computeListContinuation,
  isListLine,
} from "@/lib/shared/markdown-list";

type Props = {
  pending: boolean;
  ready: boolean;
  slashCommands: string[];
  skills: string[];
  cwd: string | null;
  /**
   * Identifies the current chat. Drives the per-session draft store: when this
   * changes we fetch the saved draft for the new session (so switching tabs
   * doesn't carry the textarea over) and persist edits keyed to the same id.
   * `null` while a fresh session is being created — the composer behaves as
   * a transient ephemeral input until the id resolves.
   */
  sessionId: string | null;
  onSend: (text: string, images?: AttachedImage[]) => void;
  onInterrupt: () => void;
  /**
   * Set by the parent to inject text into the input (e.g. when the user lifts
   * a queued message back into the prompt). Bumping this token applies the
   * value once. May also carry images that were attached to the queued message.
   *
   * `mode` defaults to `"replace"` — the historical behaviour. `"append"`
   * concatenates the injected text onto whatever the user currently has in
   * the textarea (joined with a space when non-empty), used by the Electron
   * right-click "Append Selection to Current Chat" path so a series of
   * right-clicks can stitch quotes into one prompt.
   */
  draftInjection?: {
    token: number;
    text: string;
    images?: AttachedImage[];
    mode?: "replace" | "append";
  };
  /**
   * Previously sent user prompts for the current session, oldest → newest.
   * Drives shell-style history recall: Cmd/Ctrl+↑ walks back through these,
   * Cmd/Ctrl+↓ walks forward and finally restores the in-progress draft.
   */
  promptHistory?: string[];
  /** When true, Send is force-disabled (e.g. session spending cap reached). */
  sendDisabled?: boolean;
  /**
   * Suppress the slash-command picker entirely. Used when the composer is
   * reused outside the chat (e.g. the goal input), where `/` should be plain
   * text rather than a command trigger.
   */
  disableSlash?: boolean;
  /** Override the textarea placeholder (defaults to the chat-composer copy). */
  placeholder?: string;
  /**
   * Prefix for the component's `data-testid`s (default "prompt", yielding
   * "prompt-input", "prompt-send", …). Override when more than one composer is
   * mounted at once (e.g. the goal input) so each instance is addressable.
   */
  testIdPrefix?: string;
  /**
   * Number of messages currently queued for the next turn (drives a footer
   * nudge while `pending` so the user is reminded the visible queue panel is
   * editable — Claudius's parity to the TUI's "Press up to edit queued
   * messages" hint, pointed at the queue panel instead of a keybinding).
   */
  queuedCount?: number;
  /**
   * When true, drag-and-drop is captured across the entire ancestor
   * `[data-pane-name="chat-area"]` container (not just the composer's input
   * row), and a portal'd overlay highlights the whole chat as a drop target
   * while a file drag is in progress. Opt-in because PromptInput is also
   * reused inside the goal banner — only the main chat composer wants the
   * wider drop zone; otherwise both instances would race for the same drop.
   */
  wideDropTarget?: boolean;
};

const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20MB

const TOKEN_RE = /\[Image #(\d+)\]/g;

/** Pull every ordinal currently referenced in the text. */
function extractOrdinals(text: string): Set<number> {
  const out = new Set<number>();
  for (const m of text.matchAll(TOKEN_RE)) out.add(Number(m[1]));
  return out;
}

/** Remove `[Image #N]` and one neighbouring space (trailing preferred). */
function stripImageToken(text: string, ordinal: number): string {
  const re = new RegExp(`\\[Image #${ordinal}\\]\\s?`, "g");
  const stripped = text.replace(re, "");
  return stripped === text ? text.replace(new RegExp(`\\s?\\[Image #${ordinal}\\]`, "g"), "") : stripped;
}

// Markdown list helpers — see `lib/shared/markdown-list.ts`. Kept in shared
// so the vitest suite under `tests/unit/` can exercise them in a node-only
// environment without instantiating React.

/**
 * Composer keyword hints — Claudius's take on Claude Code's "Dynamic workflow
 * requested for this turn · meta+w to ignore". When the draft contains a
 * trigger word, we surface a dismissible hint in the composer footer pointing
 * at the related feature. Dismissal is by click (a browser can't intercept
 * ⌘W — it closes the tab) and resets once the draft is cleared/sent. Add a
 * row here to teach the composer a new keyword.
 *
 * `ignoredLabel` opts a hint into the TUI's two-state pill: after `· ignore`
 * the row stays put with this label and a `· undo` affordance, matching
 * Claude Code's `workflow-keyword-ignored` → "Workflow keyword ignored for
 * this prompt" restore flow. Hints without it just vanish on dismiss.
 */
const KEYWORD_HINTS: { id: string; pattern: RegExp; label: string; ignoredLabel?: string }[] = [
  {
    id: "workflow",
    pattern: /\bworkflows?\b/i,
    label: "Dynamic workflow requested for this turn",
    ignoredLabel: "Workflow keyword ignored for this prompt",
  },
  {
    id: "goal",
    pattern: /\bgoals?\b/i,
    label: "Goal mentioned — set it as the session objective with /goal",
  },
  {
    id: "ultraplan",
    // Matches the bare word anywhere in the draft but NOT the leading-slash
    // form `/ultraplan …` (the slash picker / handler already owns that path).
    // Negative lookbehind keeps `ultraplanning` etc. out as well.
    pattern: /(?<![/\w])ultraplan\b/i,
    label: "ultraplan-active — run with /ultraplan to launch a browser planning session",
  },
];

export function PromptInput({
  pending,
  ready,
  slashCommands,
  skills,
  cwd,
  sessionId,
  onSend,
  onInterrupt,
  draftInjection,
  promptHistory,
  sendDisabled = false,
  disableSlash = false,
  placeholder,
  testIdPrefix = "prompt",
  queuedCount = 0,
  wideDropTarget = false,
}: Props) {
  const [value, setValue] = useState("");
  // Keyword hints (see KEYWORD_HINTS) the user has dismissed for the current
  // draft. Reset on send (below) so the next draft starts fresh.
  const [dismissedHints, setDismissedHints] = useState<Set<string>>(() => new Set());
  // Rich SDK command metadata (descriptions + arg hints) for the slash picker.
  // Falls back to the curated registry + init names when unavailable, so the
  // picker works even before/without this fetch.
  const sdkRichCommands = useSdkCommands(sessionId);
  // Picker visibility + active @-mention token live alongside `value`.
  // Updated imperatively from event handlers via `refreshPickerState`
  // below; we used to derive them in a `useEffect([value])` but that
  // tripped react-hooks/set-state-in-effect, and pure-render derivation
  // would have to read `taRef.current?.selectionStart` during render
  // (allowed but flagged by react-hooks/refs). The "update at the same
  // site that changes value" model is unambiguous and stays in sync with
  // the DOM caret on every write path.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [atQuery, setAtQuery] = useState<string | null>(null);
  // Hydration marker — `mounted` reads true on the client, false during SSR
  // (or the very first paint). Sourced from `useSyncExternalStore` rather
  // than a `useEffect(setMounted(true))` so we don't trip the
  // react-hooks/set-state-in-effect rule. The subscribe is a no-op because
  // the value never changes after hydration; `getServerSnapshot` returns
  // false so the SSR markup matches the pre-hydration client paint.
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  const [images, setImages] = useState<AttachedImage[]>([]);
  const [dragOver, setDragOver] = useState(false);
  /** When set, opens the lightbox over the composer for click-to-zoom. */
  const [lightbox, setLightbox] = useState<AttachedImage | null>(null);
  // `!`-mode bash (Claude Code parity). When the textarea starts with `!`,
  // Enter routes to /api/sessions/:id/bash instead of the model. The sudo
  // prompt opens a one-shot password modal when the command starts with
  // `sudo` — the password is never persisted (no draft save, no log) and
  // is dropped from memory the moment the request resolves. `bashRunning`
  // disables the textarea while a `!` request is in flight so a second
  // Enter doesn't fire a stale command.
  const [sudoPrompt, setSudoPrompt] = useState<{ command: string } | null>(null);
  const [bashRunning, setBashRunning] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  /** Per-prompt monotonic counter — increments on each insert, never decrements. */
  const ordinalCounterRef = useRef(0);
  /** True while IME composition is active — diff-based deletion is suppressed. */
  const composingRef = useRef(false);

  // ── Shell-style prompt history recall (Cmd/Ctrl + ↑/↓) ───────────────────
  // `histIdxRef` is the cursor into `promptHistory` (null = editing the live
  // draft, not browsing). Kept in a ref rather than state because every move
  // already drives a `setValue`, so the cursor never needs to trigger its own
  // render — and a ref sidesteps the set-state-in-effect rule when we reset on
  // session change below. `stashedDraftRef` holds whatever was in the composer
  // when browsing began so Cmd/Ctrl+↓ past the newest entry restores it.
  const histIdxRef = useRef<number | null>(null);
  const stashedDraftRef = useRef("");

  // ── User-resizable composer ─────────────────────────────────────────
  // Default cap (px) when the user hasn't dragged the handle. Matches the
  // historical autosize bound — prompts longer than this scroll inside
  // the textarea.
  const DEFAULT_MAX_PX = 320;
  // Floor matches the autosize-empty height of the textarea (~one line
  // + a sliver of padding). Lower than this and the resize feels fenced
  // in; this also lets a drag-all-the-way-down land on the original
  // single-line size.
  const MIN_MAX_PX = 28;
  // Dragging below this threshold on release clears the override and
  // returns the composer to content-driven autosize. Gives the user a
  // discoverable "drag to reset" gesture in addition to double-click.
  const RESET_THRESHOLD_PX = 36;
  // Max-of-max — keep some chat visible above the composer.
  const HARD_CAP_VH = 0.7;
  const STORAGE_KEY = "claudius.prompt.maxHeight";
  // Lazy init from localStorage — one-shot read on first render. The
  // preference doesn't change cross-tab in this UI (each tab owns its
  // composer height), so we don't need useSyncExternalStore. SSR returns
  // null and the post-mount re-pin effect below applies the value once
  // the textarea ref attaches.
  const [userMaxPx, setUserMaxPx] = useState<number | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw == null) return null;
      const n = Number(raw);
      if (Number.isFinite(n) && n >= MIN_MAX_PX) return n;
    } catch {
      // ignore — quota / privacy mode
    }
    return null;
  });
  // Mirror to a ref so autosize's plain function can read the latest value
  // without re-binding through deps.
  const userMaxPxRef = useRef<number | null>(null);
  userMaxPxRef.current = userMaxPx;

  // Re-pin the textarea height whenever the user-set override changes —
  // covers both hydration (mount → localStorage value applied) and the
  // double-click reset (override cleared → fall back to autosize).
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    if (userMaxPx != null) {
      ta.style.height = userMaxPx + "px";
    } else {
      // Reset to content-driven sizing.
      ta.style.height = "auto";
      ta.style.height = Math.min(ta.scrollHeight, DEFAULT_MAX_PX) + "px";
    }
  }, [userMaxPx]);

  const inputDisabled = mounted && !ready;

  // ── Auto-focus on session switch / become-ready ─────────────────────────
  // The composer should be hot the moment the user opens a new session or
  // jumps to another tab — no need to click into the textarea before typing.
  // We refuse to steal focus when the user is already in another text field
  // (search palette, title rename, modal, etc.) so a background SSE-driven
  // session change can't yank the caret mid-edit.
  useEffect(() => {
    if (!ready) return;
    if (!sessionId) return;
    const ae = document.activeElement as HTMLElement | null;
    const inOtherEditor =
      ae &&
      ae !== document.body &&
      ae !== taRef.current &&
      (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable);
    if (inOtherEditor) return;
    const handle = requestAnimationFrame(() => taRef.current?.focus());
    return () => cancelAnimationFrame(handle);
  }, [sessionId, ready]);

  // ── Electron: re-focus the composer when the window regains focus ───────
  // After the user Cmd-Tabs back into Claudius we want the caret already
  // sitting in the chat input so they can start typing — no extra click.
  // The web build doesn't do this (a browser tab regaining focus shouldn't
  // yank focus into a textarea unprompted), so the listener is gated on the
  // Electron preload bridge.
  //
  // Race note: Chromium restores focus to the previously-focused element
  // around the same time `window.focus` fires, and the ordering between
  // those two isn't guaranteed. We defer the "are we in another editor"
  // check into the rAF so it reads the *settled* activeElement — otherwise
  // a transient body-focused snapshot at handler time would let us steal
  // focus from e.g. an open search palette or the goal composer.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!readBridgeOnClient()) return;
    let handle: number | null = null;
    const onWindowFocus = () => {
      if (handle != null) cancelAnimationFrame(handle);
      handle = requestAnimationFrame(() => {
        handle = null;
        if (!taRef.current) return;
        const ae = document.activeElement as HTMLElement | null;
        const inOtherEditor =
          ae &&
          ae !== document.body &&
          ae !== taRef.current &&
          (ae.tagName === "INPUT" ||
            ae.tagName === "TEXTAREA" ||
            ae.isContentEditable);
        if (inOtherEditor) return;
        taRef.current.focus();
      });
    };
    window.addEventListener("focus", onWindowFocus);
    return () => {
      window.removeEventListener("focus", onWindowFocus);
      if (handle != null) cancelAnimationFrame(handle);
    };
  }, []);

  // Apply each fresh injection token exactly once. Uses the React 19
  // "store previous prop" pattern: when the incoming token differs from
  // the one we last applied, we update state during render (before the
  // commit) — keeping these `setValue`/`setImages` calls out of a
  // useEffect body to satisfy react-hooks/set-state-in-effect. Focus +
  // autosize are DOM side-effects that need the commit to finish first,
  // so they stay in an effect keyed by the same token.
  // https://react.dev/reference/react/useState#storing-information-from-previous-renders
  const [appliedInjectionToken, setAppliedInjectionToken] = useState<number>(-1);
  if (draftInjection && draftInjection.token !== appliedInjectionToken) {
    setAppliedInjectionToken(draftInjection.token);
    // Append mode joins onto the existing textarea (with a separator newline
    // when both sides are non-empty) instead of replacing. Used by the
    // Electron right-click "Append Selection to Current Chat" path so a
    // chain of right-clicks accumulates context into one prompt. The
    // existing image-attachment fields stay replace-only — appending images
    // would require ordinal reconciliation we don't need yet.
    if (draftInjection.mode === "append") {
      const next =
        value.length > 0
          ? `${value}${value.endsWith("\n") ? "" : "\n"}${draftInjection.text}`
          : draftInjection.text;
      setValue(next);
      refreshPickerState(next, next.length);
      // Append doesn't touch images/ordinals — the existing attachments
      // belong to the user's in-progress prompt and stay as-is. The
      // per-session draft GET that fires on sessionId change can't
      // clobber this because append is only triggered while the user is
      // ON the same session — sessionId hasn't changed, so that effect
      // doesn't refire.
    } else {
      setValue(draftInjection.text);
      refreshPickerState(draftInjection.text, draftInjection.text.length);
      if (draftInjection.images && draftInjection.images.length > 0) {
        setImages(draftInjection.images);
        // Bump the ordinal counter past anything the prior queue used so a new
        // attach starts a fresh `#N` rather than colliding with a restored one.
        const maxOrd = draftInjection.images.reduce(
          (m, im) => Math.max(m, im.ordinal),
          0,
        );
        ordinalCounterRef.current = Math.max(ordinalCounterRef.current, maxOrd);
      } else {
        setImages([]);
      }
    }
  }
  useEffect(() => {
    if (appliedInjectionToken < 0) return;
    const handle = requestAnimationFrame(() => {
      taRef.current?.focus();
      autosize();
    });
    return () => cancelAnimationFrame(handle);
  }, [appliedInjectionToken]);

  // ── Per-session draft persistence ──────────────────────────────────────
  // Each session has its own composer draft — switching tabs should NOT
  // carry the textarea over. We seed on sessionId-change from the server
  // and debounce-save on every edit. Submit clears the row.
  //
  // Race notes (these will bite if removed):
  //   1. If the user types into the new session before the GET resolves,
  //      the seed must NOT clobber their input. `userTypedRef` guards this.
  //   2. A debounced save in flight when the user switches sessions must
  //      land on the *previous* sessionId — `pendingSaveRef` carries the
  //      session id at save start so closure stale-ness can't cross sessions.
  //   3. `draftInjection` (lifted queued message) wins over the stored
  //      draft if both fire on the same render — the injection effect
  //      runs after this one in render order and overwrites.
  const userTypedRef = useRef(false);
  const seededForSessionRef = useRef<string | null>(null);
  // Reset the "typed" flag whenever the session id changes so the next seed
  // can land. We do this in render (cheap, idempotent) rather than in an
  // effect to avoid a frame of "stale typed=true" against the new session.
  if (seededForSessionRef.current !== sessionId) {
    userTypedRef.current = false;
    // Switching sessions means a different history — abandon any in-progress
    // recall so the next Cmd/Ctrl+↑ starts fresh from the new session's tail.
    histIdxRef.current = null;
  }

  useEffect(() => {
    if (!sessionId) return;
    // Capture the id this load is *for* so a late response that arrives
    // after the user has switched away gets dropped on the floor.
    const seedingFor = sessionId;
    let cancelled = false;
    fetch(`/api/sessions/${seedingFor}/prompt-draft`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { text?: string; images?: AttachedImage[] } | null) => {
        if (cancelled) return;
        if (seedingFor !== sessionId) return;
        // Mark this session as "seeded" BEFORE the typed-guard returns —
        // otherwise typing-before-load permanently disables saves: the
        // save-effect's seededForSessionRef guard never opens, and every
        // subsequent keystroke aborts. Order matters here.
        seededForSessionRef.current = seedingFor;
        if (userTypedRef.current) return; // user beat the fetch — don't clobber
        const text = data?.text ?? "";
        const imgs = Array.isArray(data?.images) ? data!.images! : [];
        setValue(text);
        // Restored drafts can legally start with `/` (slash command) or end
        // with `@token` (in-progress mention) — keep the picker state in
        // sync so the user sees the same UI they had when they left.
        refreshPickerState(text, text.length);
        setImages(imgs);
        if (imgs.length > 0) {
          const maxOrd = imgs.reduce((m, im) => Math.max(m, im.ordinal), 0);
          ordinalCounterRef.current = Math.max(ordinalCounterRef.current, maxOrd);
        }
        requestAnimationFrame(() => autosize());
      })
      .catch(() => {
        // Mark the session as "seeded" even on failure so subsequent edits
        // start saving — falling back to an empty composer is fine, and
        // missing the seed shouldn't disable persistence for the session.
        if (!cancelled) seededForSessionRef.current = seedingFor;
      });
    return () => {
      cancelled = true;
    };
    // Deliberately keyed only to sessionId: this is a one-shot seed fetch
    // per session. `refreshPickerState` is recreated on every render — adding
    // it to deps would re-fire the seed (and clobber any in-flight typing)
    // on every keystroke, which is exactly the bug the seededForSessionRef
    // guard exists to prevent. The function reads only setState setters
    // (stable) and `disableSlash` (a prop that doesn't change mid-session in
    // practice), so the stale-closure risk is nil.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Debounced save. Pinned to the sessionId in scope at fire-time so a
  // mid-flight save can't cross over after the user switches tabs.
  useEffect(() => {
    if (!sessionId) return;
    // Don't echo the just-seeded state back to the server — wait until the
    // user actually edits something.
    if (seededForSessionRef.current !== sessionId) return;
    if (!userTypedRef.current && value === "" && images.length === 0) return;
    const id = sessionId;
    const t = setTimeout(() => {
      fetch(`/api/sessions/${id}/prompt-draft`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: value, images }),
      }).catch(() => {
        // Persistence is best-effort — if the network is down the user
        // still has the in-memory textarea; we'll save again on the next
        // keystroke.
      });
    }, 500);
    return () => clearTimeout(t);
  }, [sessionId, value, images]);

  const interimRef = useRef<string>("");
  const baseRef = useRef<string>("");
  const voice = useVoice((text, isFinal) => {
    // Dictation bypasses the textarea's onChange, so flag activity here too.
    userTypedRef.current = true;
    if (isFinal) {
      const next = (baseRef.current + " " + text).trimStart();
      baseRef.current = next;
      interimRef.current = "";
      setValue(next);
    } else {
      interimRef.current = text;
      setValue((baseRef.current ? baseRef.current + " " : "") + text);
    }
    requestAnimationFrame(() => autosize());
  });

  function toggleVoice() {
    if (voice.listening) return voice.stop();
    baseRef.current = value;
    interimRef.current = "";
    voice.start();
  }

  function autosize() {
    const el = taRef.current;
    if (!el) return;
    if (userMaxPxRef.current != null) {
      // User dragged the handle to an explicit size — pin to that height
      // regardless of content so the composer doesn't shrink back down
      // when empty. Double-click the handle to clear the override.
      el.style.height = userMaxPxRef.current + "px";
      return;
    }
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, DEFAULT_MAX_PX) + "px";
  }

  /**
   * Drag handle on the top edge of the composer. Pull up to grow, down to
   * shrink. Bounds:
   *   - min 80px so two lines of text always fit
   *   - max 70% of viewport so the chat above stays usable
   * The chosen value persists in localStorage so it survives reload.
   */
  function onResizeHandleDown(e: React.MouseEvent<HTMLDivElement>) {
    e.preventDefault();
    const ta = taRef.current;
    const startHeight = ta ? ta.getBoundingClientRect().height : (userMaxPx ?? DEFAULT_MAX_PX);
    const startY = e.clientY;
    const hardCap = Math.max(MIN_MAX_PX + 1, Math.floor(window.innerHeight * HARD_CAP_VH));
    const onMove = (ev: MouseEvent) => {
      // Drag UP (smaller clientY) → bigger composer.
      const next = Math.max(MIN_MAX_PX, Math.min(hardCap, startHeight + (startY - ev.clientY)));
      setUserMaxPx(next);
      // Apply immediately without waiting for React commit — feels native.
      if (ta) ta.style.height = next + "px";
    };
    const onUp = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      const final = Math.max(MIN_MAX_PX, Math.min(hardCap, startHeight + (startY - ev.clientY)));
      // Pulled (almost) all the way down → treat as a reset gesture so
      // the composer returns to content-driven autosize. The user can
      // then drag up again from the natural one-line baseline.
      if (final <= RESET_THRESHOLD_PX) {
        setUserMaxPx(null);
        try {
          window.localStorage.removeItem(STORAGE_KEY);
        } catch {
          // ignore
        }
        requestAnimationFrame(() => autosize());
        return;
      }
      setUserMaxPx(final);
      try {
        window.localStorage.setItem(STORAGE_KEY, String(final));
      } catch {
        // ignore — quota / privacy mode
      }
      requestAnimationFrame(() => autosize());
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  /** Double-click the handle to clear the override and snap back to default. */
  function onResizeHandleDoubleClick() {
    setUserMaxPx(null);
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
    requestAnimationFrame(() => autosize());
  }

  /**
   * `!`-mode bash submission. Strips the leading `!`, opens the sudo modal
   * when needed, otherwise calls `sendBash` directly. Clears the textarea
   * on dispatch (same UX as a normal send); the result lands in the chat
   * via the server-side broadcast so we don't need to thread it through
   * the parent's `onSend` callback. Best-effort: a network failure leaves
   * the value drained and the user can re-type — the bash route is local.
   */
  function submitBash() {
    if (!sessionId) return;
    const stripped = value.replace(/^!/, "");
    const cmd = stripped.trim();
    if (!cmd) return;
    if (commandNeedsSudo(cmd)) {
      setSudoPrompt({ command: cmd });
      return;
    }
    void runBashCommand(cmd);
  }

  async function runBashCommand(command: string, sudoPassword?: string) {
    if (!sessionId) return;
    setBashRunning(true);
    // Clear the textarea AND the draft right away so a fast follow-up `!`
    // doesn't accidentally include the just-sent command. Mirrors the
    // `submit()` reset block but without the model-bound side effects
    // (suggested/queue/history) — bash-mode doesn't participate in those.
    setValue("");
    setDismissedHints(new Set());
    setImages([]);
    setPickerOpen(false);
    setAtQuery(null);
    ordinalCounterRef.current = 0;
    histIdxRef.current = null;
    userTypedRef.current = false;
    if (sessionId) {
      fetch(`/api/sessions/${sessionId}/prompt-draft`, { method: "DELETE" }).catch(() => {
        // best-effort
      });
    }
    requestAnimationFrame(() => {
      if (taRef.current) {
        taRef.current.style.height = "auto";
        taRef.current.focus();
      }
    });
    try {
      await sendBash(sessionId, { command, sudoPassword });
    } finally {
      setBashRunning(false);
      // Drop the password from memory the moment the call resolves. The
      // setSudoPrompt(null) in the modal's handler already cleared the
      // modal state; this resetSudoPrompt() guards against a race where
      // the modal re-opened mid-call (it shouldn't, the textarea is
      // disabled during bashRunning).
      setSudoPrompt(null);
    }
  }

  function submit() {
    if (sendDisabled) return;
    // `!`-mode takes precedence over the normal send. Detected at submit
    // time (rather than during onKeyDown) so any code path that calls
    // submit() — Enter, Send button click, IME flush — routes to bash
    // when appropriate.
    if (value.startsWith("!")) {
      submitBash();
      return;
    }
    const text = value.trim();
    if (!text && images.length === 0) return;
    // The composer renders bullets as `•` so the textarea has something
    // nicer to look at than `*`, but the wire format / Claude rendering
    // expect standard markdown — convert back here so what Claude sees is
    // what the user would have typed in any other markdown editor.
    const wire = bulletsToMarkdown(text);
    onSend(wire, images.length ? images : undefined);
    setValue("");
    setDismissedHints(new Set());
    setImages([]);
    setPickerOpen(false);
    setAtQuery(null);
    // Each prompt is its own ordinal namespace.
    ordinalCounterRef.current = 0;
    // Sending ends any history browse; the just-sent prompt becomes the new tail.
    histIdxRef.current = null;
    // Submitting consumes the draft. Reset the "typed" flag so subsequent
    // session-switches still seed cleanly, and tell the server to clear.
    userTypedRef.current = false;
    if (sessionId) {
      fetch(`/api/sessions/${sessionId}/prompt-draft`, { method: "DELETE" }).catch(() => {
        // Best-effort — the next debounced save will overwrite anyway.
      });
    }
    requestAnimationFrame(() => {
      if (taRef.current) {
        taRef.current.style.height = "auto";
        taRef.current.focus();
      }
    });
  }

  // Recompute picker visibility + the active @-mention token from a
  // (value, caret) pair. Called from every place that sets `value`:
  // textarea onChange, draft-injection apply, voice-dictation callback,
  // and the at-mention insert helper. Replaces a former
  // `useEffect([value])` that tripped react-hooks/set-state-in-effect.
  function refreshPickerState(nextValue: string, caret: number) {
    const before = nextValue.slice(0, caret);
    // First-line slash picker: line starts with / (skipped when disabled).
    setPickerOpen(!disableSlash && /^\s*\/\S*$/.test(nextValue));
    // @-mention: capture the active token if it starts with @
    const atMatch = /(^|\s)@([^\s@]*)$/.exec(before);
    setAtQuery(atMatch ? atMatch[2] : null);
  }

  /**
   * Replace the current textarea selection with `insert` and place the caret
   * at `caretOffset` characters into the inserted text. Used by Enter-to-
   * continue-list and Tab indent/outdent so they all share the same
   * setValue + setSelectionRange dance.
   */
  function applyEdit(start: number, end: number, insert: string, caretOffset: number) {
    const el = taRef.current;
    if (!el) return;
    const next = value.slice(0, start) + insert + value.slice(end);
    setValue(next);
    userTypedRef.current = true;
    refreshPickerState(next, start + caretOffset);
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + caretOffset;
      el.setSelectionRange(pos, pos);
      autosize();
    });
  }

  /**
   * Drop a recalled (or restored) prompt into the composer: replace the value,
   * resync the slash/@-mention picker, and park the caret at the end so the
   * user can keep editing or fire it off. We deliberately leave `userTypedRef`
   * untouched — a non-empty value already passes the draft-save gate, and not
   * flipping the flag keeps the "hasn't typed yet" seed semantics intact.
   */
  function applyRecalledText(text: string) {
    setValue(text);
    refreshPickerState(text, text.length);
    requestAnimationFrame(() => {
      const el = taRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(text.length, text.length);
      autosize();
    });
  }

  /**
   * Step through prompt history like a shell. `dir === -1` walks toward older
   * prompts (Cmd/Ctrl+↑), `dir === 1` walks back toward newer ones and finally
   * restores the draft that was in the box when browsing started (Cmd/Ctrl+↓).
   * Returns true when it handled the keystroke so the caller can `preventDefault`
   * (and let the caret fall through to its default home/end jump otherwise).
   */
  function recallHistory(dir: -1 | 1): boolean {
    const history = promptHistory ?? [];
    if (history.length === 0) return false;
    let idx = histIdxRef.current;
    // History can shrink while browsing (e.g. /clear) — clamp a now-stale
    // cursor back into range so we never index past the end.
    if (idx !== null && idx > history.length - 1) idx = history.length - 1;
    if (dir === -1) {
      if (idx === null) {
        // Entering history — stash the live draft so ↓ can bring it back.
        stashedDraftRef.current = value;
        idx = history.length - 1;
      } else if (idx > 0) {
        idx -= 1;
      } else {
        // Already at the oldest entry — swallow so the caret doesn't jump.
        return true;
      }
    } else {
      if (idx === null) return false; // not browsing — let ↓ move the caret
      if (idx < history.length - 1) {
        idx += 1;
      } else {
        // Past the newest entry → back to the stashed draft.
        histIdxRef.current = null;
        applyRecalledText(stashedDraftRef.current);
        return true;
      }
    }
    histIdxRef.current = idx;
    applyRecalledText(history[idx]);
    return true;
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // IME composition + open pickers each own their own keyboard semantics —
    // bail out of markdown shortcuts so we don't fight them. The Enter-submit
    // fallback still respects `!pickerOpen && atQuery == null` below.
    if (composingRef.current) return;

    // Shell-style history recall. Intentionally NOT gated on the pickers: a
    // recalled slash command keeps the slash picker open, and we still want ↓
    // to walk back out of it. The pickers ignore Arrow keys while meta/ctrl is
    // held (see SlashCommandPicker / AtMentionPicker), so there's no conflict.
    if ((e.metaKey || e.ctrlKey) && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      if (recallHistory(e.key === "ArrowUp" ? -1 : 1)) e.preventDefault();
      return;
    }

    if (e.key === "Enter" && !pickerOpen && atQuery == null) {
      const caret = e.currentTarget.selectionStart ?? 0;
      const lineStart = value.lastIndexOf("\n", caret - 1) + 1;
      const nlIdx = value.indexOf("\n", caret);
      const lineEnd = nlIdx === -1 ? value.length : nlIdx;
      const line = value.slice(lineStart, lineEnd);

      const cont = computeListContinuation(line);
      // List-aware Enter runs for *both* Enter and Shift+Enter: plain Enter
      // submits, so Shift+Enter is the user's only way to add a newline, and
      // it must continue the list just like Enter would in any other editor.
      if (cont) {
        e.preventDefault();
        if (cont.kind === "empty") {
          // Empty list item → exit the list by clearing this line's marker.
          // Caret lands at the (now-blank) line start so the next Enter
          // produces a normal newline. Mirrors VS Code / Slack behaviour.
          applyEdit(lineStart, lineEnd, "", 0);
        } else {
          // Non-empty list item → split at caret and seed the new line
          // with the continuation marker.
          applyEdit(caret, caret, "\n" + cont.next, 1 + cont.next.length);
        }
        return;
      }

      // Outside a list, fall back to original semantics: Enter submits,
      // Shift+Enter inserts a plain newline (browser default).
      if (e.shiftKey) return;
      e.preventDefault();
      submit();
      return;
    }

    if (e.key === "Tab" && !pickerOpen && atQuery == null) {
      const caret = e.currentTarget.selectionStart ?? 0;
      const lineStart = value.lastIndexOf("\n", caret - 1) + 1;
      const nlIdx = value.indexOf("\n", caret);
      const lineEnd = nlIdx === -1 ? value.length : nlIdx;
      const line = value.slice(lineStart, lineEnd);

      // Only hijack Tab inside list items — outside a list we leave the
      // browser's default focus-traversal alone so keyboard nav still works.
      if (!isListLine(line)) return;

      e.preventDefault();
      if (e.shiftKey) {
        const m = /^( {1,2})/.exec(line);
        if (!m) return;
        const removed = m[1].length;
        applyEdit(lineStart, lineEnd, line.slice(removed), Math.max(0, caret - lineStart - removed));
      } else {
        applyEdit(lineStart, lineStart, "  ", 2 + (caret - lineStart));
      }
      return;
    }
  }

  function insertAtMention(rel: string) {
    const el = taRef.current;
    const caret = el?.selectionStart ?? value.length;
    const before = value.slice(0, caret);
    const after = value.slice(caret);
    const replaced = before.replace(/(^|\s)@([^\s@]*)$/, (_m, pre) => `${pre}@${rel} `);
    const next = replaced + after;
    setValue(next);
    setAtQuery(null);
    requestAnimationFrame(() => {
      el?.focus();
      const pos = replaced.length;
      el?.setSelectionRange(pos, pos);
      autosize();
    });
  }

  async function readFileAsBase64(file: File): Promise<{ data: string; mediaType: string } | null> {
    if (file.size > MAX_IMAGE_BYTES) return null;
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => {
        const r = String(reader.result ?? "");
        const m = /^data:([^;]+);base64,(.+)$/.exec(r);
        if (!m) return resolve(null);
        resolve({ mediaType: m[1], data: m[2] });
      };
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    });
  }

  async function ingestFiles(files: File[]) {
    // Drag-drop / paste / file-picker all flow through here — count it as
    // user activity so a late-arriving seed can't clobber attachments.
    userTypedRef.current = true;
    // In Electron, `webUtils.getPathForFile` recovers the absolute OS path
    // for each dropped File so non-image drops can resolve to a project-
    // relative path (when inside `cwd`) or an absolute path (when outside).
    // In a regular browser tab the bridge is `null` and we fall back to the
    // basename, which is the most we can recover from the HTML5 File API.
    const bridge = readBridgeOnClient();
    const droppedPaths: string[] = [];
    type Pending = { data: string; mediaType: string };
    const newImageBlobs: Pending[] = [];
    for (const f of files) {
      if (f.type.startsWith("image/")) {
        const b = await readFileAsBase64(f);
        if (b) newImageBlobs.push(b);
      } else {
        const absPath = bridge?.files?.getPath(f) ?? null;
        droppedPaths.push(resolveDroppedPath(absPath, f.name, cwd));
      }
    }

    if (newImageBlobs.length) {
      // Assign ordinals + ids in arrival order.
      const created: AttachedImage[] = newImageBlobs.map((b) => {
        ordinalCounterRef.current += 1;
        return {
          id: crypto.randomUUID(),
          ordinal: ordinalCounterRef.current,
          data: b.data,
          mediaType: b.mediaType,
        };
      });
      setImages((prev) => [...prev, ...created]);
      // Insert `[Image #N] ` tokens at the textarea caret in order.
      const el = taRef.current;
      const caret = el?.selectionStart ?? value.length;
      const before = value.slice(0, caret);
      const after = value.slice(caret);
      const tokens = created.map((img) => `[Image #${img.ordinal}] `).join("");
      const next = before + tokens + after;
      setValue(next);
      requestAnimationFrame(() => {
        el?.focus();
        const pos = before.length + tokens.length;
        el?.setSelectionRange(pos, pos);
        autosize();
      });
    }

    if (droppedPaths.length) {
      setValue((prev) => {
        const tokens = droppedPaths.map((p) => `@${p}`).join(" ");
        const sep = prev && !prev.endsWith(" ") ? " " : "";
        return prev + sep + tokens + " ";
      });
      requestAnimationFrame(() => autosize());
    }
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length) void ingestFiles(files);
  }

  // Stable reference to the latest `ingestFiles` so the chat-area-wide
  // listener below doesn't need to re-attach on every render. The listener
  // attaches once (per chat-area mount) and dispatches through this ref.
  const ingestFilesRef = useRef(ingestFiles);
  ingestFilesRef.current = ingestFiles;

  // Capture the ancestor chat-area on first paint via a ref (not state) so
  // the attach effect is one-shot and we don't trip `react-hooks/set-state-
  // in-effect`. The portal target is read in render once `dragOver` flips.
  const chatAreaRef = useRef<HTMLElement | null>(null);

  // Whole-chat drop zone. Listens on the closest `[data-pane-name="chat-area"]`
  // ancestor when `wideDropTarget` is on, so dropping a file anywhere on the
  // chat screen (message list, banners, tabs, gutters) routes to the same
  // ingest pipeline as dropping on the composer. Gated by an explicit prop
  // because PromptInput is also reused inside the goal banner; without the
  // gate, both instances would attach to the same chat-area node and a single
  // drop would populate both inputs.
  useEffect(() => {
    if (!wideDropTarget) return;
    // Walk up from a known textarea ref to find the chat-area; fall back to
    // a document query (e.g. before the textarea ref is populated).
    const root =
      taRef.current?.closest<HTMLElement>('[data-pane-name="chat-area"]') ??
      document.querySelector<HTMLElement>('[data-pane-name="chat-area"]');
    if (!root) return;
    chatAreaRef.current = root;

    // `dragenter` fires on every child boundary cross, so a naive
    // setDragOver(false) on `dragleave` would flicker the overlay as the
    // pointer moves between children. Counting enter/leave pairs is the
    // standard fix.
    let depth = 0;
    // Gate listeners to drags that actually carry files — the chat is full of
    // selectable text, and a plain text-selection drag would otherwise flash
    // the overlay every time the user highlights a message.
    function isFilesDrag(e: globalThis.DragEvent): boolean {
      const types = e.dataTransfer?.types;
      if (!types) return false;
      for (let i = 0; i < types.length; i++) {
        if (types[i] === "Files") return true;
      }
      return false;
    }
    function onEnter(e: globalThis.DragEvent) {
      if (!isFilesDrag(e)) return;
      e.preventDefault();
      depth += 1;
      if (depth === 1) setDragOver(true);
    }
    function onOver(e: globalThis.DragEvent) {
      if (!isFilesDrag(e)) return;
      // Required for `drop` to fire AND to prevent Electron from navigating
      // the renderer to `file://<dropped>` when the drop lands outside any
      // inner handler.
      e.preventDefault();
    }
    function onLeave(e: globalThis.DragEvent) {
      if (!isFilesDrag(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragOver(false);
    }
    function onDropEvt(e: globalThis.DragEvent) {
      if (!isFilesDrag(e)) return;
      e.preventDefault();
      depth = 0;
      setDragOver(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length) void ingestFilesRef.current(files);
    }
    root.addEventListener("dragenter", onEnter);
    root.addEventListener("dragover", onOver);
    root.addEventListener("dragleave", onLeave);
    root.addEventListener("drop", onDropEvt);
    return () => {
      root.removeEventListener("dragenter", onEnter);
      root.removeEventListener("dragover", onOver);
      root.removeEventListener("dragleave", onLeave);
      root.removeEventListener("drop", onDropEvt);
    };
  }, [wideDropTarget]);

  async function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (const item of Array.from(items)) {
      if (item.kind === "file") {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length) {
      e.preventDefault();
      await ingestFiles(files);
    }
  }

  function removeImageById(id: string) {
    setImages((prev) => {
      const target = prev.find((p) => p.id === id);
      if (!target) return prev;
      // Strip `[Image #N]` and a single neighboring space (prefer the trailing
      // one Claude Code inserts after the token).
      setValue((cur) => stripImageToken(cur, target.ordinal));
      return prev.filter((p) => p.id !== id);
    });
  }

  // `!`-mode visual / behavioural flag — drives the chip, monospace font,
  // placeholder swap, and the keyword-hint suppression below. Hoisted up
  // here so the keyword-hint derivation can consult it; the JSX render
  // path re-reads the same identifier further down.
  const isBashMode = value.startsWith("!");

  // First trigger word present in the draft — drives the dismissible footer
  // hint. We surface it in two states: `active` (still nudging) and `ignored`
  // (user clicked away, but the row stays put with an undo affordance for
  // hints that opt into the restore flow via `ignoredLabel`). `dismissedHints`
  // resets on send (below), so the "for this prompt" scope is automatic.
  // Skipped entirely in `!`-mode — the hints are model-prompt nudges and have
  // no meaning when the input is a shell command.
  const detectedHint = isBashMode
    ? null
    : KEYWORD_HINTS.find((h) => h.pattern.test(value)) ?? null;
  const hintState: "active" | "ignored" | null = detectedHint
    ? dismissedHints.has(detectedHint.id)
      ? detectedHint.ignoredLabel
        ? "ignored"
        : null
      : "active"
    : null;

  // While the turn is running, point users at how their next message is
  // handled. Once at least one message is actually queued, switch the copy to
  // remind them the visible QueueIndicator above is editable — parity with the
  // TUI's "Press up to edit queued messages" nudge, retargeted at our richer
  // panel (Claudius doesn't bind plain ArrowUp to queue-edit).
  const queueHint = pending
    ? queuedCount > 0
      ? `${queuedCount} queued · edit above`
      : "Send queues until current response finishes"
    : "";

  return (
    <div className="border-t border-[var(--border)] bg-[var(--panel)] px-4 py-3">
      {sudoPrompt ? (
        <SudoPasswordModal
          command={sudoPrompt.command}
          running={bashRunning}
          onCancel={() => setSudoPrompt(null)}
          onSubmit={(password) => {
            // Defer the run so the modal can unmount synchronously — keeps
            // focus return cleaner. The password is dropped from React
            // state immediately; only the in-flight closure holds it.
            setSudoPrompt(null);
            void runBashCommand(sudoPrompt.command, password);
          }}
        />
      ) : null}
      {/* Whole-chat drop overlay. Portal'd into the chat-area container so it
          sits above tabs, banners, the message list, and the composer in one
          shot. Pointer-events: none — the underlying chat-area listener is
          what actually receives the drop. Requires the chat-area element to
          be `position: relative` (set in app/[workspaceId]/page.tsx). */}
      {wideDropTarget && dragOver && chatAreaRef.current
        ? createPortal(
            <div
              data-testid="prompt-wide-drop-overlay"
              className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-[var(--accent)]/8"
            >
              <div className="m-4 flex h-full w-full items-center justify-center rounded-2xl border-2 border-dashed border-[var(--accent)]">
                <div className="rounded-lg bg-[var(--panel)]/95 px-4 py-2 text-sm font-medium text-[var(--accent)] shadow-lg backdrop-blur-sm">
                  Drop files to attach
                </div>
              </div>
            </div>,
            chatAreaRef.current,
          )
        : null}
      <div className="relative mx-auto max-w-[var(--chat-col)]">
        {images.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2 rounded-md border border-[var(--border)] bg-[var(--panel-2)]/40 p-2">
            {images.map((img, i) => (
              <div key={i} className="relative">
                <button
                  type="button"
                  onClick={() => setLightbox(img)}
                  title={`Click to zoom · [Image #${img.ordinal}]`}
                  className="block overflow-hidden rounded-md border border-[var(--border)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`data:${img.mediaType};base64,${img.data}`}
                    alt=""
                    className="h-14 w-14 object-cover transition hover:brightness-110"
                  />
                </button>
                <button
                  onClick={() => removeImageById(img.id)}
                  className="absolute -right-1.5 -top-1.5 rounded-full border border-[var(--border)] bg-[var(--panel)] p-0.5 text-[var(--muted)] hover:text-red-400"
                  title={`Remove [Image #${img.ordinal}]`}
                >
                  <X className="h-3 w-3" />
                </button>
                <span className="pointer-events-none absolute -bottom-1 left-1/2 -translate-x-1/2 rounded bg-[var(--panel)] px-1 text-[9px] font-mono text-[var(--muted)]">
                  #{img.ordinal}
                </span>
              </div>
            ))}
            <span className="self-center text-[10px] text-[var(--muted)]">
              {images.length} image{images.length === 1 ? "" : "s"} attached
            </span>
          </div>
        )}
        {lightbox && (
          <ImageLightbox
            src={`data:${lightbox.mediaType};base64,${lightbox.data}`}
            label={`Image #${lightbox.ordinal}`}
            onClose={() => setLightbox(null)}
          />
        )}

        {/*
          Drag-up resize handle. Sits flush above the composer's rounded
          frame, full-width, ns-resize cursor, with a subtle dashed
          indicator on hover. Pull up to grow the textarea, down to
          shrink. Double-click to reset to the default height. Persists
          to localStorage.
         */}
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize composer"
          aria-valuemin={MIN_MAX_PX}
          aria-valuemax={Math.floor((typeof window !== "undefined" ? window.innerHeight : 800) * HARD_CAP_VH)}
          aria-valuenow={userMaxPx ?? DEFAULT_MAX_PX}
          tabIndex={0}
          onMouseDown={onResizeHandleDown}
          onDoubleClick={onResizeHandleDoubleClick}
          onKeyDown={(e) => {
            // Keyboard a11y: arrow keys nudge by 24px, double-press to reset.
            if (e.key === "ArrowUp" || e.key === "ArrowDown") {
              e.preventDefault();
              const ta = taRef.current;
              const cur = userMaxPx ?? (ta ? ta.getBoundingClientRect().height : DEFAULT_MAX_PX);
              const cap = Math.max(MIN_MAX_PX + 1, Math.floor(window.innerHeight * HARD_CAP_VH));
              const delta = e.key === "ArrowUp" ? 24 : -24;
              const next = Math.max(MIN_MAX_PX, Math.min(cap, cur + delta));
              setUserMaxPx(next);
              try {
                window.localStorage.setItem(STORAGE_KEY, String(next));
              } catch {
                // ignore
              }
              requestAnimationFrame(() => autosize());
            }
          }}
          data-testid={`${testIdPrefix}-resize-handle`}
          title="Drag to resize · double-click to reset"
          className="group mx-auto h-2 w-full cursor-ns-resize select-none"
        >
          <div className="mx-auto h-[2px] w-12 rounded-full bg-[var(--border)] transition group-hover:bg-[var(--accent)]/60 group-focus-visible:bg-[var(--accent)]/60" />
        </div>
        <div
          // When the chat-area-wide drop zone is active, inner drag handlers
          // would double-fire (drop event bubbles up to the chat-area listener
          // too) and populate the same attachments twice. Skip them in that
          // mode and rely entirely on the wide listener + portal overlay.
          onDragOver={wideDropTarget ? undefined : (e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={wideDropTarget ? undefined : () => setDragOver(false)}
          onDrop={wideDropTarget ? undefined : onDrop}
          className={cn(
            "flex items-end gap-2 rounded-2xl border bg-[var(--panel-2)] px-3 py-2 transition",
            !wideDropTarget && dragOver
              ? "border-[var(--accent)] bg-[var(--accent)]/5"
              : isBashMode
                ? "border-amber-500/60 focus-within:border-amber-500"
                : "border-[var(--border)] focus-within:border-[var(--accent)]/60",
          )}
        >
          {isBashMode ? (
            <span
              data-testid={`${testIdPrefix}-bash-chip`}
              title="Bash mode — Enter runs locally, not as a prompt"
              className="flex h-7 shrink-0 items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 font-mono text-[11px] font-semibold uppercase tracking-wide text-amber-400"
            >
              {bashRunning ? <Hourglass className="h-3 w-3 animate-spin" /> : null}
              bash
            </span>
          ) : null}
          <button
            type="button"
            title="Attach file — images embed inline, other files are inserted as @path mentions"
            onClick={() => {
              const inp = document.createElement("input");
              inp.type = "file";
              // No `accept` filter — the picker mirrors the drag-drop contract:
              // images travel inline as base64, any other file is inserted as
              // an `@path` mention (cropped to cwd-relative when inside the
              // workspace; absolute otherwise). Locking the picker to
              // `image/*` greyed out everything else, even though the drop
              // path supports them.
              inp.multiple = true;
              inp.onchange = () => {
                if (inp.files) void ingestFiles(Array.from(inp.files));
              };
              inp.click();
            }}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--muted)] hover:bg-[var(--panel)]"
          >
            <Paperclip className="h-4 w-4" />
          </button>
          <textarea
            ref={taRef}
            data-testid={`${testIdPrefix}-input`}
            value={value}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={() => {
              composingRef.current = false;
            }}
            onChange={(e) => {
              const next = e.target.value;
              // A real keystroke — block the seed-from-server effect from
              // overwriting the user's input if the GET resolves late.
              userTypedRef.current = true;
              // Editing the text exits history-browse mode: the next Cmd/Ctrl+↑
              // should re-stash this edited draft and start again from the tail.
              histIdxRef.current = null;
              // Atomic-token cleanup: any token present in the prior value but
              // gone (or partially mangled) in the new value drops its image.
              if (!composingRef.current) {
                const before = extractOrdinals(value);
                const after = extractOrdinals(next);
                const dropped: number[] = [];
                for (const ord of before) if (!after.has(ord)) dropped.push(ord);
                if (dropped.length > 0) {
                  setImages((prev) => prev.filter((img) => !dropped.includes(img.ordinal)));
                  // Auto-complete partial deletions: anything left of a dropped
                  // token's bracket fragments gets cleaned up too.
                  let cleaned = next;
                  for (const ord of dropped) {
                    cleaned = cleaned.replace(new RegExp(`\\[Image #${ord}[^\\]]*$`), "");
                    cleaned = cleaned.replace(new RegExp(`^[^\\[]*Image #${ord}\\]`), "");
                  }
                  setValue(cleaned);
                  refreshPickerState(cleaned, cleaned.length);
                  autosize();
                  return;
                }

                // Markdown bullet auto-insert: a freshly-typed space following
                // a lone `* ` at the start of a (possibly indented) line gets
                // swapped for the bullet glyph. Guarded by a single-char
                // insertion check so pastes and programmatic edits don't
                // surprise the user.
                const caret = e.target.selectionStart ?? next.length;
                if (next.length === value.length + 1 && next[caret - 1] === " ") {
                  const lineStart = next.lastIndexOf("\n", caret - 1) + 1;
                  const beforeCaret = next.slice(lineStart, caret);
                  const m = /^(\s*)\* $/.exec(beforeCaret);
                  if (m) {
                    const indent = m[1];
                    const replaced =
                      next.slice(0, lineStart) + indent + `${BULLET_GLYPH} ` + next.slice(caret);
                    setValue(replaced);
                    refreshPickerState(replaced, caret);
                    // No length change → caret stays at `caret` natively; we
                    // still re-pin to defend against browsers that reset the
                    // selection when the controlled value swaps.
                    requestAnimationFrame(() => {
                      taRef.current?.setSelectionRange(caret, caret);
                      autosize();
                    });
                    return;
                  }
                }
              }
              setValue(next);
              refreshPickerState(next, e.target.selectionStart ?? next.length);
              autosize();
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            rows={1}
            disabled={inputDisabled || bashRunning}
            placeholder={
              placeholder ??
              (!mounted || ready
                ? pending
                  ? "Queue a follow-up — Shift+Enter for newline"
                  : "Message Claudius — / for commands, @ for files/agents, drop or paste images, ! for shell"
                : "Starting session…")
            }
            // In bash mode we drop to a monospace font so a long pipeline
            // reads like terminal input. The leading `!` itself is included
            // in the textarea value (no leading-character trick) so the
            // user can backspace it to leave bash mode naturally.
            className={cn(
              "flex-1 resize-none bg-transparent leading-6 text-[var(--foreground)] placeholder:text-[var(--muted)]/70 focus:outline-none disabled:cursor-not-allowed",
              isBashMode ? "font-mono text-[13px]" : "text-sm",
            )}
          />
          {voice.supported && (
            <button
              type="button"
              data-testid={`${testIdPrefix}-mic`}
              onClick={toggleVoice}
              // Hover title surfaces the last voice error so silent
              // failures (denied permission, no Claude.ai account,
              // upstream drop) don't look like a broken button. The
              // error stays visible until the next successful start().
              title={
                voice.error
                  ? `Voice: ${voice.error}`
                  : voice.listening
                    ? "Stop dictation"
                    : "Voice dictation"
              }
              className={cn(
                "flex h-7 w-7 shrink-0 items-center justify-center rounded-md",
                voice.listening
                  ? "bg-red-500/90 text-white animate-pulse"
                  : voice.error
                    ? "text-amber-500 hover:bg-[var(--panel)]"
                    : "text-[var(--muted)] hover:bg-[var(--panel)]",
              )}
            >
              {voice.listening ? <MicOff className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
            </button>
          )}
          {pending && (
            <button
              type="button"
              onClick={submit}
              disabled={!ready || sendDisabled || (!value.trim() && images.length === 0)}
              className={cn(
                "flex h-8 shrink-0 items-center gap-1 rounded-full border border-[var(--accent)]/40 bg-[var(--accent)]/15 px-3 text-xs text-[var(--accent)]",
                "hover:bg-[var(--accent)]/25 active:scale-95 transition",
                "disabled:opacity-40 disabled:cursor-not-allowed",
              )}
              title="Queue — sends after current response"
            >
              <Hourglass className="h-3.5 w-3.5" />
              Queue
            </button>
          )}
          {pending ? (
            <button
              data-testid={`${testIdPrefix}-interrupt`}
              onClick={onInterrupt}
              className={cn(
                "flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-red-500/90 text-white",
                "hover:bg-red-500 active:scale-95 transition",
              )}
              title="Interrupt"
            >
              <Square className="h-3.5 w-3.5" fill="currentColor" />
            </button>
          ) : (
            <button
              data-testid={`${testIdPrefix}-send`}
              onClick={submit}
              disabled={!ready || sendDisabled || (!value.trim() && images.length === 0)}
              className={cn(
                "flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--accent)] text-white",
                "hover:opacity-90 active:scale-95 transition",
                "disabled:opacity-40 disabled:cursor-not-allowed",
              )}
              title="Send"
            >
              <ArrowUp className="h-4 w-4" />
            </button>
          )}
        </div>

        {!disableSlash && pickerOpen && atQuery == null && (
          <SlashCommandPicker
            value={value.trimStart()}
            sdkSlashCommands={slashCommands}
            sdkSkills={skills}
            sdkRichCommands={sdkRichCommands}
            onSelect={(cmd) => {
              setValue(`/${cmd} `);
              setPickerOpen(false);
              requestAnimationFrame(() => taRef.current?.focus());
            }}
            onClose={() => setPickerOpen(false)}
          />
        )}

        {atQuery != null && (
          <AtMentionPicker
            query={atQuery}
            cwd={cwd}
            sessionId={sessionId}
            onSelect={(rel) => insertAtMention(rel)}
            onClose={() => setAtQuery(null)}
          />
        )}

        <div className="mt-1.5 flex items-center justify-between px-1 text-[11px] text-[var(--muted)]/70">
          {hintState === "active" && detectedHint ? (
            <button
              type="button"
              data-testid={`${testIdPrefix}-keyword-hint-active`}
              onClick={() => setDismissedHints((d) => new Set(d).add(detectedHint.id))}
              title="Dismiss this hint"
              className="flex items-center gap-1 rounded text-[var(--accent)] hover:text-[var(--foreground)]"
            >
              <Sparkles className="h-3 w-3 shrink-0" />
              <span>{detectedHint.label}</span>
              <span className="text-[var(--muted)]/70">· ignore</span>
            </button>
          ) : hintState === "ignored" && detectedHint?.ignoredLabel ? (
            <button
              type="button"
              data-testid={`${testIdPrefix}-keyword-hint-ignored`}
              onClick={() =>
                setDismissedHints((d) => {
                  const next = new Set(d);
                  next.delete(detectedHint.id);
                  return next;
                })
              }
              title="Restore this hint"
              className="flex items-center gap-1 rounded text-[var(--muted)] hover:text-[var(--foreground)]"
            >
              <Sparkles className="h-3 w-3 shrink-0 opacity-50" />
              <span>{detectedHint.ignoredLabel}</span>
              <span className="text-[var(--muted)]/70">· undo</span>
            </button>
          ) : (
            <span>{queueHint}</span>
          )}
          <span className="flex items-center gap-2">
            {images.length > 0 && (
              <span className="flex items-center gap-1">
                <ImageIcon className="h-3 w-3" /> {images.length}
              </span>
            )}
            <span className="font-mono">{value.length} chars</span>
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * One-shot sudo password modal. Opens when the user types `!sudo …` (or
 * clicks Execute on a ```bash code fence whose first token is sudo). The
 * password lives only in the input ref + the in-flight closure passed to
 * `onSubmit`; we deliberately don't store it in React state OR localStorage
 * — closing the modal drops it from memory immediately.
 *
 * Render shape: a centred overlay using the existing Tailwind theme tokens.
 * Esc cancels, Enter submits, the input takes focus on mount. While the
 * command is in flight (`running`), Run is disabled and the input is
 * read-only so a stray double-Enter can't re-send.
 */
function SudoPasswordModal({
  command,
  running,
  onSubmit,
  onCancel,
}: {
  command: string;
  running: boolean;
  onSubmit: (password: string) => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Enter sudo password"
      data-testid="prompt-sudo-modal"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={(e) => {
        // Click-outside cancels — matches the rest of the app's modal feel.
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="mx-4 w-full max-w-md rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-4 shadow-xl">
        <div className="mb-2 text-sm font-semibold">Run with sudo</div>
        <div
          className="mb-3 max-h-24 overflow-auto rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 font-mono text-[12px] text-[var(--foreground)]"
          title="Command to run with sudo"
        >
          {command}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const v = inputRef.current?.value ?? "";
            if (!v) return;
            onSubmit(v);
            // Best-effort: zero out the field so the password isn't sitting
            // in the DOM after the modal unmounts. The form-state path also
            // hands the value off; this is purely a defense-in-depth.
            if (inputRef.current) inputRef.current.value = "";
          }}
        >
          <input
            ref={inputRef}
            type="password"
            autoComplete="off"
            data-testid="prompt-sudo-password"
            disabled={running}
            placeholder="Password"
            // 1Password / Keychain autofill on a password field that lives
            // outside a real login form is more annoying than helpful here —
            // hint to skip via the standard attribute.
            data-1p-ignore="true"
            data-lpignore="true"
            className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 font-mono text-sm text-[var(--foreground)] focus:border-[var(--accent)] focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
            onKeyDown={(e) => {
              if (e.key === "Escape") onCancel();
            }}
          />
          <div className="mt-3 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="rounded-md px-3 py-1 text-sm text-[var(--muted)] hover:text-[var(--foreground)]"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={running}
              data-testid="prompt-sudo-run"
              className="rounded-md border border-amber-500/40 bg-amber-500/15 px-3 py-1 text-sm font-medium text-amber-300 hover:bg-amber-500/25 disabled:opacity-50"
            >
              {running ? "Running…" : "Run"}
            </button>
          </div>
        </form>
        <div className="mt-2 text-[11px] text-[var(--muted)]">
          The password is sent once over a local request and never persisted.
        </div>
      </div>
    </div>
  );
}
