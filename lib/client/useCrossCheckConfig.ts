"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Per-browser config for the "check with another LLM" feature — the provider,
 * model, and credentials Claudius will use to get a second opinion from a
 * different model. Stored client-side only for now; the cross-check action
 * itself is not wired up yet (this only persists the configuration).
 *
 * Mirrors the `useSyncExternalStore` + localStorage pattern of
 * `useTipDismissals` / `useTheme` so the config stays in sync across tabs and
 * same-tab callers without a setState-in-effect anti-pattern. The snapshot is
 * the parsed config object, kept stable across reads via a module-level cache
 * so React's `Object.is` check on the snapshot doesn't fire spuriously.
 */

const STORAGE_KEY = "claudius.crossCheck.config";
const SAME_TAB_EVENT = "claudius.crossCheck.config.changed";

export type CrossCheckProvider = "openai" | "anthropic" | "google" | "custom";

export type CrossCheckConfig = {
  provider: CrossCheckProvider;
  /** Model id, e.g. `gpt-4o`, `gemini-1.5-pro`, `claude-opus-4-8`. */
  model: string;
  /** API key for the chosen provider. */
  apiKey: string;
  /** Optional override for OpenAI-compatible / self-hosted endpoints. */
  baseUrl?: string;
};

const EMPTY_CONFIG: CrossCheckConfig | null = null;

// Cache the last parsed snapshot so repeated readSnapshot() calls return the
// same reference until the underlying string changes — `useSyncExternalStore`
// bails out of re-rendering on `Object.is` equality, so a fresh object every
// call would defeat that.
let cachedRaw: string | null | undefined = undefined;
let cachedConfig: CrossCheckConfig | null = EMPTY_CONFIG;

function isProvider(v: unknown): v is CrossCheckProvider {
  return v === "openai" || v === "anthropic" || v === "google" || v === "custom";
}

function readSnapshot(): CrossCheckConfig | null {
  if (typeof window === "undefined") return EMPTY_CONFIG;
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return EMPTY_CONFIG;
  }
  if (raw === cachedRaw) return cachedConfig;
  cachedRaw = raw;
  if (!raw) {
    cachedConfig = EMPTY_CONFIG;
    return cachedConfig;
  }
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      isProvider(parsed.provider) &&
      typeof parsed.model === "string" &&
      typeof parsed.apiKey === "string"
    ) {
      cachedConfig = {
        provider: parsed.provider,
        model: parsed.model,
        apiKey: parsed.apiKey,
        baseUrl: typeof parsed.baseUrl === "string" ? parsed.baseUrl : undefined,
      };
      return cachedConfig;
    }
  } catch {
    // ignore — corrupt value, treat as unconfigured
  }
  cachedConfig = EMPTY_CONFIG;
  return cachedConfig;
}

function writeSnapshot(config: CrossCheckConfig | null): void {
  try {
    if (!config) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    // ignore — non-persistent fallback is fine.
  }
  window.dispatchEvent(new Event(SAME_TAB_EVENT));
}

function subscribe(cb: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("storage", cb);
  window.addEventListener(SAME_TAB_EVENT, cb);
  return () => {
    window.removeEventListener("storage", cb);
    window.removeEventListener(SAME_TAB_EVENT, cb);
  };
}

/** True when the config has the minimum needed to call another model. */
export function isCrossCheckConfigured(config: CrossCheckConfig | null): boolean {
  return !!config && config.model.trim().length > 0 && config.apiKey.trim().length > 0;
}

export function useCrossCheckConfig() {
  const config = useSyncExternalStore(subscribe, readSnapshot, () => EMPTY_CONFIG);

  const save = useCallback((next: CrossCheckConfig) => {
    writeSnapshot(next);
  }, []);

  const clear = useCallback(() => {
    writeSnapshot(null);
  }, []);

  return { config, configured: isCrossCheckConfigured(config), save, clear };
}
