"use client";

import { useRef } from "react";

/**
 * CC 2.1.330 parity — "[VSCode] Fixed dialogs closing, and losing typed text,
 * when a text selection was dragged past their edge".
 *
 * A modal's backdrop closed it on `click`. Drag-selecting text in one of its
 * fields and letting go outside the panel makes the browser fire `click` on
 * the nearest common ancestor of the press and the release — the backdrop —
 * so the dialog closed and the typed text went with it. A `target ===
 * currentTarget` check doesn't help: the target IS the backdrop.
 *
 * Pure rule: dismiss only when the press started on the backdrop itself and
 * the click lands on it too.
 */
export function shouldDismissOnBackdropClick(pressStartedOnBackdrop: boolean, clickOnBackdrop: boolean): boolean {
  return pressStartedOnBackdrop && clickOnBackdrop;
}

/**
 * Spread onto a modal's backdrop element in place of `onClick={onDismiss}`.
 * Records where the press began (`pointerdown` bubbles up from the panel, so
 * a press inside it is seen too) and applies {@link shouldDismissOnBackdropClick}.
 */
export function useBackdropDismiss(onDismiss: () => void): {
  onPointerDown: (e: React.PointerEvent<HTMLElement>) => void;
  onClick: (e: React.MouseEvent<HTMLElement>) => void;
} {
  const pressStartedOnBackdrop = useRef(false);
  return {
    onPointerDown: (e) => {
      pressStartedOnBackdrop.current = e.target === e.currentTarget;
    },
    onClick: (e) => {
      const started = pressStartedOnBackdrop.current;
      pressStartedOnBackdrop.current = false;
      if (shouldDismissOnBackdropClick(started, e.target === e.currentTarget)) onDismiss();
    },
  };
}
