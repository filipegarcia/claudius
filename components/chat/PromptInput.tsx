"use client";

import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import { ArrowUp, Hourglass, Image as ImageIcon, Mic, MicOff, Paperclip, Square, X } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { SlashCommandPicker } from "./SlashCommandPicker";
import { AtMentionPicker } from "./AtMentionPicker";
import { useVoice } from "@/lib/client/useVoice";
import type { AttachedImage } from "@/lib/client/types";

type Props = {
  pending: boolean;
  ready: boolean;
  slashCommands: string[];
  skills: string[];
  cwd: string | null;
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
  const taRef = useRef<HTMLTextAreaElement>(null);
  /** Per-prompt monotonic counter — increments on each insert, never decrements. */
  const ordinalCounterRef = useRef(0);
  /** True while IME composition is active — diff-based deletion is suppressed. */
  const composingRef = useRef(false);

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

  const interimRef = useRef<string>("");
  const baseRef = useRef<string>("");
  const voice = useVoice((text, isFinal) => {
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
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 320) + "px";
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
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`data:${img.mediaType};base64,${img.data}`}
                  alt=""
                  className="h-14 w-14 rounded-md border border-[var(--border)] object-cover"
                />
                <button
                  onClick={() => removeImageById(img.id)}
                  className="absolute -right-1.5 -top-1.5 rounded-full border border-[var(--border)] bg-[var(--panel)] p-0.5 text-[var(--muted)] hover:text-red-400"
                  title={`Remove [Image #${img.ordinal}]`}
                >
                  <X className="h-3 w-3" />
                </button>
                <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 rounded bg-[var(--panel)] px-1 text-[9px] font-mono text-[var(--muted)]">
                  #{img.ordinal}
                </span>
              </div>
            ))}
            <span className="self-center text-[10px] text-[var(--muted)]">
              {images.length} image{images.length === 1 ? "" : "s"} attached
            </span>
          </div>
        )}

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
