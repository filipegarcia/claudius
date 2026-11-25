import { TEXT_INPUT_TYPES, type FocusedFieldLike } from "@/lib/client/typing-focus";

/**
 * CC 2.1.318 parity — "Fixed permission prompts being answered by keys typed
 * just after sending a message, or before a slow prompt appeared".
 * CC 2.1.327 parity — "Fixed Esc being ignored on a permission prompt that
 * had just appeared."
 *
 * Claudius's permission card and MCP input prompt listen for Escape on
 * `window` from the moment they mount (deny / cancel). An Escape typed in the
 * composer a beat before a slow prompt appeared — meant for the composer's
 * picker or "two Escapes clear the input" — bubbled to that listener and
 * declined a request the user never saw.
 *
 * 2.1.318 dropped every Escape in the first {@link PROMPT_ARM_GRACE_MS} after
 * mount. That also swallowed deliberate ones: a quick Esc on a prompt the
 * user is looking at, and — since answering a queued prompt mounts the next
 * one at once — the second Esc of "Esc, Esc" through two queued prompts.
 * Now the grace only applies when the user was typing in a text field just
 * before (or since) the prompt armed. Evidence comes from a window capture
 * listener (installed once, on first arm) that notes keystrokes in fields.
 *
 * The Escape's own target is deliberately NOT evidence: a permission prompt
 * leaves focus in the composer (CC 2.1.299), so a deliberate Esc on it
 * targets the composer textarea too.
 */
export const PROMPT_ARM_GRACE_MS = 400;

/**
 * How far before the prompt armed a keystroke in a text field still counts
 * as "the user was typing" — e.g. the Enter that sent the message, or the
 * letters before an Escape meant for the composer's picker.
 */
export const FIELD_TYPING_LOOKBACK_MS = 1000;

/**
 * Pure rule: true when an Escape at `eventTimeStamp` (a
 * `KeyboardEvent.timeStamp`, same clock as `performance.now()`) should be
 * left alone because it was most likely meant for the field the user was
 * typing in, not for the prompt armed at `armedAt`.
 *
 * - `armedAt === null` (not armed yet) → ignore.
 * - Past the grace window → answer the prompt.
 * - Inside it → ignore only if `lastFieldKeyAt` (last keystroke in a text
 *   field, or null) is within {@link FIELD_TYPING_LOOKBACK_MS} before the
 *   prompt armed, or after it.
 */
export function isEscapeMeantForField(
  eventTimeStamp: number,
  armedAt: number | null,
  lastFieldKeyAt: number | null,
): boolean {
  if (armedAt === null) return true;
  if (eventTimeStamp - armedAt >= PROMPT_ARM_GRACE_MS) return false;
  if (lastFieldKeyAt === null) return false;
  return lastFieldKeyAt >= armedAt - FIELD_TYPING_LOOKBACK_MS;
}

/**
 * True when `el` is a text field — `<textarea>`, text-like `<input>`, or a
 * contentEditable host — regardless of content. (Unlike `isTypingInField`,
 * an empty field counts: right after Enter sends, the composer is empty.)
 */
export function isTextField(el: FocusedFieldLike | null | undefined): boolean {
  if (!el) return false;
  const tag = (el.tagName ?? "").toUpperCase();
  if (tag === "TEXTAREA") return true;
  if (tag === "INPUT") return TEXT_INPUT_TYPES.has((el.type ?? "").toLowerCase());
  return !!el.isContentEditable;
}

/** The bits of a `KeyboardEvent` the tracker reads. */
export type KeydownLike = {
  key: string;
  timeStamp: number;
  target: unknown;
};

const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "Fn"]);

// Module state. Browser-only in practice (the listener is installed from an
// effect); tests drive it through the exported functions below.
let lastFieldKeyAt: number | null = null;
let openPrompts = 0;
let listenerInstalled = false;

/**
 * Capture-phase keydown body: record a keystroke in a text field as typing
 * evidence. Runs BEFORE the prompts' bubble listeners for the same event, so
 * while a prompt is open an Escape writes nothing — recording it would make
 * every in-grace Esc suppress itself, and it's the prompt's guard that
 * decides what it meant. With no prompt open, an Escape in the composer is
 * typing (the first of "two Escapes clear the input").
 */
export function noteFieldKeydown(e: KeydownLike): void {
  if (MODIFIER_KEYS.has(e.key)) return;
  if (e.key === "Escape" && openPrompts > 0) return;
  if (!isTextField(e.target as FocusedFieldLike | null)) return;
  lastFieldKeyAt = e.timeStamp;
}

/**
 * Capture-phase pointerdown body: a click while a prompt is open (e.g.
 * "Allow" on the first of two queued prompts) means the user is dealing with
 * prompts now, so earlier composer typing no longer explains an Escape.
 */
export function notePointerdown(): void {
  if (openPrompts > 0) lastFieldKeyAt = null;
}

function installListeners(): void {
  if (listenerInstalled || typeof window === "undefined") return;
  listenerInstalled = true;
  window.addEventListener("keydown", noteFieldKeydown, { capture: true });
  window.addEventListener("pointerdown", notePointerdown, { capture: true });
}

/**
 * Call when a prompt arms (an effect keyed by its requestId); returns the
 * disarm for the effect cleanup. Installs the tracking listeners on first
 * use. Disarm only drops the open count — it must not clear the typing
 * evidence, or dev StrictMode's mount/cleanup/mount would wipe it.
 */
export function armPrompt(): () => void {
  installListeners();
  openPrompts++;
  let disarmed = false;
  return () => {
    if (disarmed) return;
    disarmed = true;
    openPrompts = Math.max(0, openPrompts - 1);
  };
}

/**
 * The prompts' Escape guard: true → leave this Escape alone. When it returns
 * false the caller answers the prompt, so the typing evidence is cleared — a
 * queued next prompt that mounts right away then takes a quick second Esc.
 */
export function shouldIgnorePromptEscape(e: Pick<KeydownLike, "timeStamp">, armedAt: number | null): boolean {
  if (isEscapeMeantForField(e.timeStamp, armedAt, lastFieldKeyAt)) return true;
  lastFieldKeyAt = null;
  return false;
}

/** Test-only: reset the module state between cases. */
export function resetPromptArmStateForTests(): void {
  lastFieldKeyAt = null;
  openPrompts = 0;
}
