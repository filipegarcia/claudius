/**
 * CC 2.1.280 [VSCode] — "Paste >800 chars or >2 line breaks marked so Claude
 * can tell it from typed text." A large paste is recorded and passed to the
 * SDK as `SDKUserMessage.inline_pastes` (the paste text stays inline in the
 * prompt where the user put it); the CLI wraps each entry in `<pasted_content>`
 * tags, and the system prompt treats that span as not user-authored — a
 * prompt-injection provenance signal. Pure threshold so it's unit-testable.
 */
export const LARGE_PASTE_MIN_CHARS = 800;

/**
 * The recorded large-paste segments that are still present in the outgoing
 * text, as `inline_pastes` entries. The composer trims the text before send
 * (and converts bullets), so a paste that ended in a trailing newline would
 * fail a raw `text.includes(segment)` check — match the trimmed segment and
 * emit the trimmed form, which is what actually remains in `text`.
 */
export function inlinePastesInText(segments: string[], text: string): string[] {
  const out: string[] = [];
  for (const seg of segments) {
    const trimmed = seg.trim();
    if (trimmed && text.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

/** ">2 line breaks" — i.e. 3 or more newline characters. */
export function isLargePaste(text: string): boolean {
  if (text.length > LARGE_PASTE_MIN_CHARS) return true;
  let newlines = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) {
      newlines += 1;
      if (newlines > 2) return true;
    }
  }
  return false;
}

/**
 * CC 2.1.292 — "Fixed some pasted text reaching Claude as typed text when
 * several pastes overlapped in one prompt". Matching each recorded paste as
 * a contiguous string fails as soon as a second paste lands inside the first
 * (`A1 + B + A2`): A is no longer a substring, so A1 and A2 went out as
 * typed text. Instead the composer tracks where each paste sits and keeps
 * the ranges current through every edit.
 */
export type PasteRange = { start: number; end: number };

/** One edit: `removed` chars at `at` replaced by `inserted` chars. */
export type TextEdit = { at: number; removed: number; inserted: number };

/**
 * The single edit that turns `prev` into `next` (common prefix/suffix).
 * A pure insert or delete inside a run of repeated text is ambiguous —
 * prefix-first matching puts it at the run's end — so `caret` (the caret
 * after the change) slides it to where it actually happened.
 */
export function diffEdit(prev: string, next: string, caret?: number): TextEdit {
  const max = Math.min(prev.length, next.length);
  let at = 0;
  while (at < max && prev.charCodeAt(at) === next.charCodeAt(at)) at++;
  let tail = 0;
  while (
    tail < max - at &&
    prev.charCodeAt(prev.length - 1 - tail) === next.charCodeAt(next.length - 1 - tail)
  ) {
    tail++;
  }
  const edit = { at, removed: prev.length - at - tail, inserted: next.length - at - tail };
  if (caret != null && (edit.removed === 0 || edit.inserted === 0)) {
    let suffix = tail;
    while (
      suffix < max &&
      prev.charCodeAt(prev.length - 1 - suffix) === next.charCodeAt(next.length - 1 - suffix)
    ) {
      suffix++;
    }
    // Any start in [lo, at] yields the same strings: the prefix before it
    // and the suffix after it are shared.
    const lo = Math.max(0, prev.length - edit.removed - suffix);
    const want = caret - edit.inserted;
    if (want >= lo && want < edit.at) edit.at = want;
  }
  return edit;
}

/**
 * Carry paste ranges across one edit. A range before or after the edit
 * shifts; text an edit inserts inside a paste is not part of that paste (a
 * nested paste records its own range), so an overlapped range keeps only its
 * surviving pieces on either side.
 */
export function applyEditToRanges(ranges: PasteRange[], edit: TextEdit): PasteRange[] {
  const { at, removed, inserted } = edit;
  const editEnd = at + removed;
  const delta = inserted - removed;
  const out: PasteRange[] = [];
  for (const r of ranges) {
    if (editEnd <= r.start) {
      // Entirely before (an insertion right at the start lands before it).
      out.push({ start: r.start + delta, end: r.end + delta });
    } else if (at >= r.end) {
      // Entirely after (an insertion right at the end lands after it).
      out.push(r);
    } else {
      if (r.start < at) out.push({ start: r.start, end: at });
      if (r.end > editEnd) out.push({ start: at + inserted, end: r.end + delta });
    }
  }
  return out;
}

/**
 * The pasted spans of `text`: ranges merged where they overlap or touch, so
 * a paste dropped inside another (or right against it) reads as one block.
 */
export function pastedSpans(ranges: PasteRange[], text: string): string[] {
  const sorted = ranges
    .map((r) => ({ start: Math.max(0, r.start), end: Math.min(text.length, r.end) }))
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start);
  const merged: PasteRange[] = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  return merged.map((r) => text.slice(r.start, r.end));
}
