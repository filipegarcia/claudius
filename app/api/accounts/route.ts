import { NextResponse } from "next/server";
import {
  addAccount,
  deleteAccount,
  readAccountsPublic,
  setActiveAccount,
  setAutoRotate,
  type AccountKind,
} from "@/lib/server/accounts-store";
import { invalidateProfileCache } from "@/lib/server/account-profile";

export const runtime = "nodejs";

/**
 * GET /api/accounts — list configured account profiles. Returns the
 * client-safe shape (no raw secrets, only a 4-char preview), so this
 * endpoint is safe to call from the browser.
 */
export async function GET() {
  const data = await readAccountsPublic();
  return NextResponse.json(data);
}

type PostBody = {
  label?: string;
  kind?: AccountKind;
  secret?: string;
};

/**
 * POST /api/accounts — add a new profile. First-added profile auto-
 * becomes the active one (so a fresh install can "add + use" in one
 * round-trip).
 */
export async function POST(req: Request) {
  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!body.label || !body.kind || !body.secret) {
    return NextResponse.json(
      { error: "label, kind, secret required" },
      { status: 400 },
    );
  }
  try {
    const { state, profile } = await addAccount({
      label: body.label,
      kind: body.kind,
      secret: body.secret,
    });
    // Fresh secret ⇒ fresh profile — wipe any stale cached info so the
    // next GET re-fetches against the new token.
    invalidateProfileCache(profile.id);
    const publicState = {
      profiles: state.profiles.map((p) => ({
        id: p.id,
        label: p.label,
        kind: p.kind,
        secretPreview:
          p.secret.length <= 4 ? "•".repeat(p.secret.length) : `…${p.secret.slice(-4)}`,
        createdAt: p.createdAt,
      })),
      activeProfileId: state.activeProfileId,
      autoRotateOnRateLimit: state.autoRotateOnRateLimit,
    };
    return NextResponse.json({ state: publicState, profileId: profile.id });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "add failed" },
      { status: 400 },
    );
  }
}

type PatchBody = {
  activeProfileId?: string;
  autoRotateOnRateLimit?: boolean;
};

/**
 * PATCH /api/accounts — update which profile is the default for new
 * sessions and/or toggle auto-rotate-on-rate-limit. Either field is
 * optional; at least one must be present. Live sessions keep their
 * original profile until restart — matches what the SDK actually does
 * (env is read at `query()` time).
 */
export async function PATCH(req: Request) {
  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!body.activeProfileId && typeof body.autoRotateOnRateLimit !== "boolean") {
    return NextResponse.json(
      { error: "activeProfileId or autoRotateOnRateLimit required" },
      { status: 400 },
    );
  }
  try {
    if (typeof body.autoRotateOnRateLimit === "boolean") {
      await setAutoRotate(body.autoRotateOnRateLimit);
    }
    if (body.activeProfileId) {
      await setActiveAccount(body.activeProfileId);
    }
    return NextResponse.json(await readAccountsPublic());
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "patch failed" },
      { status: 400 },
    );
  }
}

/**
 * DELETE /api/accounts?id=... — remove a profile. If it was active,
 * the next-remaining profile (if any) becomes active automatically.
 */
export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  await deleteAccount(id);
  invalidateProfileCache(id);
  return NextResponse.json(await readAccountsPublic());
}
