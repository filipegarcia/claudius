"use client";

import { createContext, useContext, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";

/**
 * CC 2.1.327 parity — "Improved transcript search to find text in edits and
 * written files." The find bar (`TranscriptSearch`) publishes its active
 * query here so collapsed Edit / Write cards (`ToolCall`) can open themselves
 * when their file text matches, and close again when it no longer does.
 *
 * Two contexts: the value (read by tool cards) and a stable setter (read by
 * the bar), so publishing never re-renders the bar itself. Provided around
 * the find bar + message list in ChatSurface; the default `null` means "no
 * active search", so a card rendered outside the provider is unaffected.
 */
export type TranscriptFindQuery = { query: string; matchCase: boolean };

const QueryContext = createContext<TranscriptFindQuery | null>(null);
const SetQueryContext = createContext<Dispatch<SetStateAction<TranscriptFindQuery | null>>>(() => {});

export function TranscriptFindProvider({ children }: { children: ReactNode }) {
  const [query, setQuery] = useState<TranscriptFindQuery | null>(null);
  return (
    <SetQueryContext.Provider value={setQuery}>
      <QueryContext.Provider value={query}>{children}</QueryContext.Provider>
    </SetQueryContext.Provider>
  );
}

/** The find bar's active query, or null when the bar is closed / empty. */
export function useTranscriptFindQuery(): TranscriptFindQuery | null {
  return useContext(QueryContext);
}

/** Setter the find bar publishes its query through. */
export function usePublishTranscriptFindQuery(): Dispatch<SetStateAction<TranscriptFindQuery | null>> {
  return useContext(SetQueryContext);
}
