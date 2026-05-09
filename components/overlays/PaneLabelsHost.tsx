"use client";

import { useEffect, useState } from "react";
import { PaneLabelsOverlay } from "./PaneLabelsOverlay";

/**
 * Global mount point for the pane-name overlay. Lives in the root layout so
 * any route can open it. Two ways to trigger:
 *   1. Keyboard: Cmd/Ctrl + . (period)
 *   2. Custom event: window.dispatchEvent(new Event('claudius:open-pane-labels'))
 *
 * The overlay walks the entire document for `[data-pane-name]` nodes, so it
 * works the same regardless of which page is mounted.
 */
export const PANE_LABELS_EVENT = "claudius:open-pane-labels";

export function PaneLabelsHost() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function isTyping(target: EventTarget | null): boolean {
      const el = target as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
    }
    function onKey(e: KeyboardEvent) {
      if (isTyping(e.target)) return;
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key === ".") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    }
    function onOpen() {
      setOpen(true);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener(PANE_LABELS_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(PANE_LABELS_EVENT, onOpen);
    };
  }, []);

  if (!open) return null;
  return <PaneLabelsOverlay onClose={() => setOpen(false)} />;
}
