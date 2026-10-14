/**
 * CC 2.1.299 parity — "Fixed Enter answering a question or permission prompt
 * that had been held back while you typed an unsent message".
 *
 * A prompt that mounts while the user is mid-draft must not grab focus: the
 * Enter they press to send their message would otherwise land on the prompt
 * (for a `defaultToNo` permission prompt, its focused Deny button) and answer
 * it unseen. Pure predicate over a duck-typed element so the rule is
 * unit-testable without a DOM.
 */

/** The bits of an element this check reads — `document.activeElement` fits. */
export type FocusedFieldLike = {
  tagName?: string;
  type?: string;
  value?: unknown;
  isContentEditable?: boolean;
  textContent?: string | null;
};

/** `<input type=…>` values that take typed text (an Enter there is "send"). */
const TEXT_INPUT_TYPES = new Set(["", "text", "search", "email", "url", "tel", "password", "number"]);

/**
 * True when `el` is a text field the user is actively composing in — an
 * `<input>` (text-like type), `<textarea>`, or contentEditable host holding
 * non-whitespace content. An empty focused field isn't "mid-draft", so a
 * prompt may still take focus from it.
 */
export function isTypingInField(el: FocusedFieldLike | null | undefined): boolean {
  if (!el) return false;
  const tag = (el.tagName ?? "").toUpperCase();
  if (tag === "TEXTAREA") return hasText(el.value);
  if (tag === "INPUT") {
    const type = (el.type ?? "").toLowerCase();
    return TEXT_INPUT_TYPES.has(type) && hasText(el.value);
  }
  if (el.isContentEditable) return hasText(el.textContent);
  return false;
}

function hasText(v: unknown): boolean {
  return typeof v === "string" && v.trim().length > 0;
}
