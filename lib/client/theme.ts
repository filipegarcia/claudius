"use client";

import { useCallback, useEffect, useState } from "react";

export type ThemeId = "dark" | "light" | "midnight" | "paper" | "tui" | "tui-light";

export const THEMES: { id: ThemeId; label: string; preview: { bg: string; accent: string } }[] = [
  { id: "dark", label: "Dark", preview: { bg: "#0b0b0c", accent: "#d97757" } },
  { id: "light", label: "Light", preview: { bg: "#fafafa", accent: "#c0531a" } },
  { id: "midnight", label: "Midnight", preview: { bg: "#070914", accent: "#8b9bff" } },
  { id: "paper", label: "Paper", preview: { bg: "#f6f1e7", accent: "#7c4a2a" } },
  { id: "tui", label: "TUI", preview: { bg: "#000000", accent: "#f5a524" } },
  { id: "tui-light", label: "TUI Light", preview: { bg: "#fafaf7", accent: "#b45309" } },
];

const STORAGE_KEY = "claudius.theme";

function applyTheme(id: ThemeId) {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = id;
}

export function useTheme() {
  const [theme, setThemeState] = useState<ThemeId>("dark");

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY) as ThemeId | null;
      if (saved && THEMES.some((t) => t.id === saved)) {
        setThemeState(saved);
        applyTheme(saved);
      } else {
        applyTheme("dark");
      }
    } catch {
      applyTheme("dark");
    }
  }, []);

  const setTheme = useCallback((id: ThemeId) => {
    setThemeState(id);
    applyTheme(id);
    try {
      window.localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // ignore
    }
  }, []);

  return { theme, setTheme };
}
