"use client";

import { useEffect, useState } from "react";
import Editor from "react-simple-code-editor";
import { ensureHighlighter, highlightSync, languageForPath } from "@/lib/client/shiki";
import { isLetterKey } from "@/lib/client/key-match";

type Props = {
  /** Workspace-relative path of the file — used to pick a grammar. */
  path: string;
  /** Current source text shown in the editor. */
  value: string;
  /** Fires on every keystroke / paste / undo. */
  onChange: (next: string) => void;
  /** Read-only editor (no caret, no edits). Defaults to false. */
  readOnly?: boolean;
  /**
   * Optional key handler — the parent uses it to bind ⌘S etc. Forwarded to
   * the underlying <textarea>, not the wrapping div, so it fires only when
   * the editor itself has focus.
   */
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
};

/**
 * Syntax-highlighted, editable code panel for the /files view. Wraps
 * `react-simple-code-editor` — a transparent <textarea> on top of a synced
 * highlighted <pre> — and uses shiki to colorize.
 *
 * The highlighter is a singleton (see `lib/client/shiki.ts`); on first
 * mount we await its boot so the very first paint is already colored
 * instead of flashing escaped plain text. On subsequent mounts the await
 * resolves immediately.
 *
 * Shiki returns a full `<pre class="shiki"><code>…</code></pre>` block —
 * react-simple-code-editor wraps its highlighted output in its OWN <pre>,
 * so we strip shiki's outer wrapper before handing it back. The inner
 * per-token <span style="color: …"> spans are what actually colors the
 * code, and those are preserved.
 */
export function HighlightedEditor({ path, value, onChange, readOnly, onKeyDown }: Props) {
  const [ready, setReady] = useState(false);
  const lang = languageForPath(path);

  // Boot the highlighter once (singleton — second mount is instant).
  useEffect(() => {
    let cancelled = false;
    ensureHighlighter().then(() => {
      if (!cancelled) setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!ready) {
    // Render the value as plain mono text while shiki boots so the layout
    // doesn't shift when colors arrive (same font, size, padding).
    return (
      <pre
        className="m-0 h-full w-full overflow-auto bg-[var(--background)] p-4 font-mono text-xs leading-5 text-[var(--foreground)] scroll-thin"
        data-testid="files-highlighted-editor-loading"
      >
        {value}
      </pre>
    );
  }

  return (
    <div
      className="shiki-host h-full w-full overflow-auto bg-[var(--background)] scroll-thin"
      data-testid="files-highlighted-editor"
      data-lang={lang ?? "text"}
    >
      <Editor
        value={value}
        onValueChange={readOnly ? noop : onChange}
        highlight={(code) => stripShikiWrapper(highlightSync(code, lang))}
        padding={16}
        tabSize={2}
        insertSpaces
        readOnly={readOnly}
        // react-simple-code-editor types onKeyDown as
        // KeyboardEventHandler<HTMLDivElement> & KeyboardEventHandler<HTMLTextAreaElement>,
        // but actually forwards events from the underlying <textarea>. Cast to satisfy
        // the intersection without lying about the runtime target.
        onKeyDown={
          (readOnly ? readOnlyKeyDown(onKeyDown) : onKeyDown) as unknown as React.KeyboardEventHandler<HTMLDivElement> &
            React.KeyboardEventHandler<HTMLTextAreaElement>
        }
        // A read-only editor shouldn't capture Tab for indentation.
        ignoreTabKey={readOnly}
        textareaId="files-editor-textarea"
        textareaClassName="files-editor-textarea"
        preClassName="files-editor-pre"
        style={{
          fontFamily:
            "var(--font-mono), ui-monospace, SFMono-Regular, Menlo, Monaco, 'Liberation Mono', monospace",
          fontSize: 12,
          lineHeight: "20px",
          minHeight: "100%",
        }}
      />
    </div>
  );
}

function noop() {}

/**
 * The textarea's native `readonly` only blocks typed characters —
 * react-simple-code-editor's own keydown handler still rewrites the value for
 * Enter (auto-indent), Backspace (dedent), its undo/redo history, and — with
 * text selected — the bracket/quote keys, which wrap the selection in
 * `()` `[]` `{}` `''` `""` or backticks. It skips all of that when the event
 * is already `defaultPrevented`, so for a read-only editor we forward to the
 * parent (⌘S etc.) and then cancel those keys.
 * (CC 2.1.299 parity — non-UTF-8 files open read-only in /files.)
 */
function readOnlyKeyDown(
  onKeyDown: Props["onKeyDown"],
): (e: React.KeyboardEvent<HTMLTextAreaElement>) => void {
  return (e) => {
    onKeyDown?.(e);
    if (e.defaultPrevented) return;
    const mod = e.metaKey || e.ctrlKey;
    if (
      e.key === "Enter" ||
      e.key === "Backspace" ||
      e.key === "Delete" ||
      (mod && (isLetterKey(e, "z") || isLetterKey(e, "y")))
    ) {
      e.preventDefault();
      return;
    }
    // The library's selection-wrap keys, matched on `keyCode` as it does.
    const t = e.currentTarget;
    if (t.selectionStart !== t.selectionEnd && isWrapKey(e.keyCode, e.shiftKey)) e.preventDefault();
  };
}

/** react-simple-code-editor's wrap keys: Shift+9 `(`, `[`/`{`, `'`/`"`, unshifted `` ` ``. */
function isWrapKey(keyCode: number, shift: boolean): boolean {
  return (keyCode === 57 && shift) || keyCode === 219 || keyCode === 222 || (keyCode === 192 && !shift);
}

/**
 * Drop shiki's outer `<pre …><code …>…</code></pre>` so the inner spans can
 * live inside react-simple-code-editor's own <pre> (otherwise we'd have
 * nested <pre>s, which mis-aligns with the textarea).
 *
 * Defensive: if the regex doesn't match (older shiki, edge case), fall
 * back to returning the raw output so we still render *something*.
 */
function stripShikiWrapper(html: string): string {
  const m = /^<pre\b[^>]*><code\b[^>]*>([\s\S]*?)<\/code><\/pre>\s*$/.exec(html);
  return m ? m[1] : html;
}
