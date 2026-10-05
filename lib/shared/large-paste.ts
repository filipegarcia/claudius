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
