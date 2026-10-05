"use client";

import { createContext, useContext } from "react";
import type { ClockOptions } from "@/lib/shared/time-format";

/**
 * CC 2.1.257 (F4) — the resolved `timeFormat` / `timeZone` clock overrides,
 * computed once near the chat root (ChatSurface, from `useClockOptions`) and
 * shared via context so every message bubble and the StatusLine clock apply
 * the same settings without each spinning up its own `/api/settings` fetch.
 *
 * The default is an empty object: a bubble rendered outside the provider
 * (e.g. TranscriptViewer) falls back to the locale-default formatters, which
 * is the pre-F4 behavior.
 */
const ClockOptionsContext = createContext<ClockOptions>({});

export const ClockOptionsProvider = ClockOptionsContext.Provider;

export function useClockOptionsContext(): ClockOptions {
  return useContext(ClockOptionsContext);
}
