import { describe, expect, test } from "vitest";

import { shouldDismissOnBackdropClick } from "@/lib/client/backdrop-dismiss";

/**
 * CC 2.1.330 — "[VSCode] Fixed dialogs closing, and losing typed text, when a
 * text selection was dragged past their edge".
 *
 * Claudius's modals closed on any `click` whose target was the backdrop. A
 * drag-select that starts in a field and ends outside the panel fires `click`
 * on the common ancestor — the backdrop — so `Overlay` (and the question,
 * restore-files, new-DM and folder-access modals) closed and dropped the
 * typed text. `useBackdropDismiss` now also requires the press to have
 * started on the backdrop. The DOM half is in
 * tests/e2e/cc-parity-2.1.330-backdrop-drag.spec.ts.
 */
describe("shouldDismissOnBackdropClick", () => {
  test("a press and release on the backdrop closes the dialog", () => {
    expect(shouldDismissOnBackdropClick(true, true)).toBe(true);
  });

  test("a selection dragged from inside the panel out onto the backdrop doesn't", () => {
    expect(shouldDismissOnBackdropClick(false, true)).toBe(false);
  });

  test("a press on the backdrop released inside the panel doesn't either", () => {
    expect(shouldDismissOnBackdropClick(true, false)).toBe(false);
  });

  test("nothing on the backdrop at all doesn't", () => {
    expect(shouldDismissOnBackdropClick(false, false)).toBe(false);
  });
});
