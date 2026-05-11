"use client";

import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import { ArrowUp, Hourglass, Image as ImageIcon, Mic, MicOff, Paperclip, Square, X } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { SlashCommandPicker } from "./SlashCommandPicker";
import { AtMentionPicker } from "./AtMentionPicker";
import { ImageLightbox } from "./ImageLightbox";
import { useVoice } from "@/lib/client/useVoice";
import type { AttachedImage } from "@/lib/client/types";

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
   */
  draftInjection?: { token: number; text: string; images?: AttachedImage[] };
  /** When true, Send is force-disabled (e.g. session spending cap reached). */
  sendDisabled?: boolean;
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
  sendDisabled = false,
}: Props) {
  const [value, setValue] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [atQuery, setAtQuery] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const [images, setImages] = useState<AttachedImage[]>([]);
  const [dragOver, setDragOver] = useState(false);
  /** When set, opens the lightbox over the composer for click-to-zoom. */
  const [lightbox, setLightbox] = useState<AttachedImage | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  /** Per-prompt monotonic counter — increments on each insert, never decrements. */
  const ordinalCounterRef = useRef(0);
  /** True while IME composition is active — diff-based deletion is suppressed. */
  const composingRef = useRef(false);

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
  const [userMaxPx, setUserMaxPx] = useState<number | null>(null);
  // Mirror to a ref so autosize's plain function can read the latest value
  // without re-binding through deps.
  const userMaxPxRef = useRef<number | null>(null);
  userMaxPxRef.current = userMaxPx;
  // Load persisted preference on mount.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw == null) return;
      const n = Number(raw);
      if (Number.isFinite(n) && n >= MIN_MAX_PX) setUserMaxPx(n);
    } catch {
      // ignore — quota / privacy mode
    }
  }, []);

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

  useEffect(() => setMounted(true), []);
  const inputDisabled = mounted && !ready;

  // Apply each fresh injection token exactly once.
  const lastInjectionRef = useRef<number>(-1);
  useEffect(() => {
    if (!draftInjection) return;
    if (draftInjection.token === lastInjectionRef.current) return;
    lastInjectionRef.current = draftInjection.token;
    setValue(draftInjection.text);
    if (draftInjection.images && draftInjection.images.length > 0) {
      setImages(draftInjection.images);
      // Bump the ordinal counter past anything the prior queue used so a new
      // attach starts a fresh `#N` rather than colliding with a restored one.
      const maxOrd = draftInjection.images.reduce((m, im) => Math.max(m, im.ordinal), 0);
      ordinalCounterRef.current = Math.max(ordinalCounterRef.current, maxOrd);
    } else {
      setImages([]);
    }
    requestAnimationFrame(() => {
      taRef.current?.focus();
      autosize();
    });
  }, [draftInjection]);

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

  function submit() {
    if (sendDisabled) return;
    const text = value.trim();
    if (!text && images.length === 0) return;
    onSend(text, images.length ? images : undefined);
    setValue("");
    setImages([]);
    setPickerOpen(false);
    setAtQuery(null);
    // Each prompt is its own ordinal namespace.
    ordinalCounterRef.current = 0;
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

  // Track which kind of picker should be open by inspecting the active token.
  useEffect(() => {
    const el = taRef.current;
    const caret = el?.selectionStart ?? value.length;
    const before = value.slice(0, caret);
    // First-line slash picker: line starts with /
    const slashMatch = /^\s*\/\S*$/.test(value);
    setPickerOpen(slashMatch);
    // @-mention: capture the active token if it starts with @
    const atMatch = /(^|\s)@([^\s@]*)$/.exec(before);
    setAtQuery(atMatch ? atMatch[2] : null);
  }, [value]);

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !pickerOpen && atQuery == null) {
      e.preventDefault();
      submit();
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
    const droppedPaths: string[] = [];
    type Pending = { data: string; mediaType: string };
    const newImageBlobs: Pending[] = [];
    for (const f of files) {
      if (f.type.startsWith("image/")) {
        const b = await readFileAsBase64(f);
        if (b) newImageBlobs.push(b);
      } else {
        droppedPaths.push(f.name);
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

  const queueHint = pending ? "Send queues until current response finishes" : "";

  return (
    <div className="border-t border-[var(--border)] bg-[var(--panel)] px-4 py-3">
      <div className="relative mx-auto max-w-3xl">
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
          data-testid="prompt-resize-handle"
          title="Drag to resize · double-click to reset"
          className="group mx-auto h-2 w-full cursor-ns-resize select-none"
        >
          <div className="mx-auto h-[2px] w-12 rounded-full bg-[var(--border)] transition group-hover:bg-[var(--accent)]/60 group-focus-visible:bg-[var(--accent)]/60" />
        </div>
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          className={cn(
            "flex items-end gap-2 rounded-2xl border bg-[var(--panel-2)] px-3 py-2 transition",
            dragOver ? "border-[var(--accent)] bg-[var(--accent)]/5" : "border-[var(--border)] focus-within:border-[var(--accent)]/60",
          )}
        >
          <button
            type="button"
            title="Attach (image)"
            onClick={() => {
              const inp = document.createElement("input");
              inp.type = "file";
              inp.accept = "image/*";
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
            data-testid="prompt-input"
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
                  autosize();
                  return;
                }
              }
              setValue(next);
              autosize();
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            rows={1}
            disabled={inputDisabled}
            placeholder={
              !mounted || ready
                ? pending
                  ? "Queue a follow-up — Shift+Enter for newline"
                  : "Message Claudius — / for commands, @ for files, drop or paste images"
                : "Starting session…"
            }
            className="flex-1 resize-none bg-transparent text-sm leading-6 text-[var(--foreground)] placeholder:text-[var(--muted)]/70 focus:outline-none disabled:cursor-not-allowed"
          />
          {voice.supported && (
            <button
              type="button"
              onClick={toggleVoice}
              title={voice.listening ? "Stop dictation" : "Voice dictation"}
              className={cn(
                "flex h-7 w-7 shrink-0 items-center justify-center rounded-md",
                voice.listening
                  ? "bg-red-500/90 text-white animate-pulse"
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
              data-testid="prompt-interrupt"
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
              data-testid="prompt-send"
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

        {pickerOpen && atQuery == null && (
          <SlashCommandPicker
            value={value.trimStart()}
            sdkSlashCommands={slashCommands}
            sdkSkills={skills}
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
            onSelect={(rel) => insertAtMention(rel)}
            onClose={() => setAtQuery(null)}
          />
        )}

        <div className="mt-1.5 flex items-center justify-between px-1 text-[11px] text-[var(--muted)]/70">
          <span>{queueHint}</span>
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
