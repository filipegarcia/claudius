"use client";

/**
 * Resolves the community chat-server endpoint at build time.
 *
 * Source of truth: `NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL` (set in
 * `.env.local` for dev, `.env.production` or your deployment env for prod).
 * No in-app override — there used to be a localStorage path here driven by
 * an in-page settings form, but the chat server is institution-level
 * config, not per-browser, so it lives in the env now.
 *
 * Returning "" (rather than throwing) lets the page render a friendly
 * "configure the env var" empty state without crashing dev builds.
 */

const RAW = process.env.NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL ?? "";
const NORMALISED = RAW.replace(/\/+$/, "");

/** Read the resolved server URL. Returns "" when nothing is configured. */
export function getCommunityServerUrl(): string {
  return NORMALISED;
}
