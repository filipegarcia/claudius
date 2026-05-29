"use client";

/**
 * Mounts the `useDeepLinks` subscription so `claudius://` URLs route
 * to the right workspace/session from anywhere in the app.
 *
 * Renders nothing — exists only to give `app/layout.tsx` (a server
 * component) a place to attach the client-side hook.
 *
 * Phase 8 of docs/electron-conversion/PLAN.md.
 */
import { useDeepLinks } from "@/lib/client/useDeepLinks";

export function DeepLinksHandler() {
  useDeepLinks();
  return null;
}
