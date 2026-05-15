"use client";

import { useCallback, useRef, useState } from "react";

type SpeechRecognitionLike = {
  lang?: string;
  interimResults?: boolean;
  continuous?: boolean;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((ev: { resultIndex: number; results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean }> }) => void) | null;
  onerror: ((ev: { error?: string }) => void) | null;
  onend: (() => void) | null;
};

declare global {
  interface Window {
    SpeechRecognition?: { new (): SpeechRecognitionLike };
    webkitSpeechRecognition?: { new (): SpeechRecognitionLike };
  }
}

// Feature-detect once at module load. The Web Speech API capability is
// fixed for the lifetime of the page, so a module-level constant is more
// honest than a useState — and it lets us skip the SSR-safety `useEffect`
// dance entirely. On the server, `window` is undefined and `supported`
// reads as `false`, which matches what a fresh client tab will see before
// the first user interaction.
const VOICE_SUPPORTED =
  typeof window !== "undefined" &&
  Boolean(window.SpeechRecognition ?? window.webkitSpeechRecognition);

export function useVoice(onTranscript: (text: string, isFinal: boolean) => void) {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const supported = VOICE_SUPPORTED;

  const start = useCallback(() => {
    if (typeof window === "undefined") return;
    const Ctor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Ctor) {
      setError("Web Speech API not available in this browser");
      return;
    }
    const rec = new Ctor();
    rec.lang = navigator.language || "en-US";
    rec.interimResults = true;
    rec.continuous = true;
    rec.onresult = (ev) => {
      let interim = "";
      let final = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i];
        const t = res[0].transcript;
        if (res.isFinal) final += t;
        else interim += t;
      }
      if (final) onTranscript(final, true);
      else if (interim) onTranscript(interim, false);
    };
    rec.onerror = (ev) => {
      setError(ev.error ?? "voice error");
      setListening(false);
    };
    rec.onend = () => setListening(false);
    recognitionRef.current = rec;
    setError(null);
    setListening(true);
    rec.start();
  }, [onTranscript]);

  const stop = useCallback(() => {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setListening(false);
  }, []);

  return { supported, listening, error, start, stop };
}
