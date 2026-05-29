"use client";

/**
 * Resolves the community chat-server endpoint at build time.
 *
 * Source of truth: `NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL`. A canonical
 * default (https://chat.claudius.network) ships via `next.config.ts`'s
 * `env` field, so a fresh build with no env override gets a working
 * community page out of the box. Override per-install in `.env.local`
 * (dev) or your deployment env (prod).
 *
 * No in-app override — there used to be a localStorage path here driven by
 * an in-page settings form, but the chat server is institution-level
 * config, not per-browser, so it lives in the env now.
 *
 * Returning "" (rather than throwing) lets the page render a friendly
 * "not configured" empty state without crashing — fires when someone
 * explicitly sets the env var to an empty string to disable /community.
 */

const RAW = process.env.NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL ?? "";
const NORMALISED = RAW.replace(/\/+$/, "");

/** Read the resolved server URL. Returns "" when nothing is configured. */
export function getCommunityServerUrl(): string {
  return NORMALISED;
}
