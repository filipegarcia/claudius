"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type NotifyState = "default" | "granted" | "denied" | "unsupported";

const ENABLE_KEY = "claudius.notifications.enabled";

export function useNotifications() {
  const [state, setState] = useState<NotifyState>("unsupported");
  const [enabled, setEnabledState] = useState(false);
  const visibleRef = useRef(true);

  useEffect(() => {
    if (typeof window === "undefined" || !("Notification" in window)) {
      setState("unsupported");
      return;
    }
    setState(Notification.permission as NotifyState);
    try {
      setEnabledState(window.localStorage.getItem(ENABLE_KEY) === "1");
    } catch {
      setEnabledState(false);
    }
    function onVis() {
      visibleRef.current = !document.hidden;
    }
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  const requestPermission = useCallback(async () => {
    if (typeof Notification === "undefined") return "unsupported" as const;
    const r = await Notification.requestPermission();
    setState(r as NotifyState);
    return r;
  }, []);

  const setEnabled = useCallback(async (next: boolean) => {
    if (next && state !== "granted") {
      const r = await Notification.requestPermission();
      setState(r as NotifyState);
      if (r !== "granted") return false;
    }
    setEnabledState(next);
    try {
      window.localStorage.setItem(ENABLE_KEY, next ? "1" : "0");
    } catch {
      // ignore
    }
    return true;
  }, [state]);

  const notify = useCallback((title: string, body?: string) => {
    if (!enabled || state !== "granted") return;
    if (typeof Notification === "undefined") return;
    if (visibleRef.current) return; // user is here, don't be annoying
    try {
      const n = new Notification(title, { body, icon: "/favicon.ico" });
      n.onclick = () => {
        window.focus();
        n.close();
      };
    } catch {
      // ignore
    }
  }, [enabled, state]);

  return { state, enabled, setEnabled, requestPermission, notify };
}
