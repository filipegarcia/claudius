import { NextResponse } from "next/server";
import { sessionManager } from "@/lib/server/session-manager";
import { info as sessionFileInfo } from "@/lib/server/sessions-store";
import {
  clearPromptDraft,
  getPromptDraft,
  setPromptDraft,
  type PromptDraftImage,
} from "@/lib/server/prompt-drafts-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Per-session draft store for the composer textarea. The composer in
 * `components/chat/PromptInput.tsx` GETs on mount to seed its initial value,
 * PUTs (debounced) on every change, and DELETEs on submit.
 */

/** Mirror the helper in notification-prefs/route.ts — same fallback path. */
async function resolveCwd(sessionId: string): Promise<string | null> {
  const live = sessionManager.get(sessionId);
  if (live) return live.cwd;
  try {
    const info = await sessionFileInfo(sessionId);
    return info?.cwd ?? null;
  } catch {
    return null;
  }
}

type PutBody = {
  text?: string;
  images?: PromptDraftImage[];
};

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const cwd = await resolveCwd(id);
  if (!cwd) return NextResponse.json({ error: "session not found" }, { status: 404 });
  const draft = await getPromptDraft(cwd, id);
  // Empty shape so the client can blindly seed without checking for null —
  // distinguishable from "no draft" because the `updatedAt` is omitted.
  if (!draft) return NextResponse.json({ text: "", images: [] });
  return NextResponse.json(draft);
}

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const cwd = await resolveCwd(id);
  if (!cwd) return NextResponse.json({ error: "session not found" }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as PutBody;
  const text = typeof body.text === "string" ? body.text : "";
  const images = Array.isArray(body.images) ? body.images : [];
  // Cap to a defensive ceiling — the composer enforces 20MB per image, but
  // we don't want a malformed request to write a giant blob row.
  const MAX_TEXT = 200_000;
  const MAX_IMAGES = 16;
  const trimmedText = text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text;
  const clampedImages = images.slice(0, MAX_IMAGES);
  await setPromptDraft(cwd, id, trimmedText, clampedImages);
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const cwd = await resolveCwd(id);
  if (!cwd) return NextResponse.json({ error: "session not found" }, { status: 404 });
  await clearPromptDraft(cwd, id);
  return NextResponse.json({ ok: true });
}
