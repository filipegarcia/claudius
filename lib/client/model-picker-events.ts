/**
 * Window CustomEvents the chat composer's native slash handler (`runNative`
 * in `components/chat/ChatSurface.tsx`) dispatches to open the right-rail
 * SessionCard's ModelPicker (`components/panels/widgets/SessionCard.tsx`).
 *
 * - `OPEN_ADVISOR_PICKER_EVENT` — bare `/advisor` (the picker hosts the
 *   "Advisor (experimental)" section).
 * - `OPEN_MODEL_PICKER_EVENT` — CC 2.1.299 parity — "a bare /model, /effort
 *   or /fast there now opens a picker". The same ModelPicker hosts the model
 *   list plus the effort and fast-mode rows, so all three bare commands land
 *   on it.
 */
export const OPEN_ADVISOR_PICKER_EVENT = "claudius:open-advisor-picker";
export const OPEN_MODEL_PICKER_EVENT = "claudius:open-model-picker";

/**
 * Ask the SessionCard to open its model picker. Returns whether a listener
 * claimed the request: the event is cancelable and the SessionCard calls
 * `preventDefault()` when it actually opens the picker. The card isn't always
 * mounted (focus mode hides the right rail; read-only cards don't listen), so
 * callers use a `false` return to fall back to their pre-picker behaviour
 * instead of the slash command silently doing nothing.
 */
export function requestOpenModelPicker(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const ev = new CustomEvent(OPEN_MODEL_PICKER_EVENT, { cancelable: true });
    // `dispatchEvent` returns false iff a listener called preventDefault().
    return !window.dispatchEvent(ev);
  } catch {
    return false;
  }
}
