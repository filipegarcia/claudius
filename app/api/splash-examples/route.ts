import { NextResponse } from "next/server";
import { resolveActiveWorkspace } from "@/lib/server/active-workspace";
import {
  DEFAULT_SPLASH_EXAMPLES,
  getSplashDisplayName,
  getSplashExamples,
  resetSplashExamples,
  setSplashDisplayName,
  setSplashExamples,
  SPLASH_DISPLAY_NAME_MAX_LEN,
  SPLASH_EXAMPLE_MAX_LEN,
  SPLASH_EXAMPLES_MAX,
} from "@/lib/server/splash-examples-db";
import { resolveSplashFallbackName } from "@/lib/server/splash-fallback-name";

export const runtime = "nodejs";

/**
 * Per-workspace splash configuration: the suggestion-chip list AND the
 * display name shown in the greeting. Both live in the per-cwd
 * `ui_state` key/value table (workspace scoping is implicit because the
 * DB file itself is keyed by cwd).
 *
 *   GET    → current chips + display-name override + fallback name.
 *   PUT    → save chips and/or override (each field is optional so the
 *            client can update one without re-sending the other).
 *   DELETE → reset chips to defaults AND clear the name override.
 */

async function activeCwd(): Promise<string> {
  const ws = await resolveActiveWorkspace().catch(() => null);
  return ws?.rootPath ?? process.cwd();
}

export async function GET() {
  const cwd = await activeCwd();
  const [examplesPayload, override, fallback] = await Promise.all([
    getSplashExamples(cwd),
    getSplashDisplayName(cwd),
    resolveSplashFallbackName(),
  ]);
  return NextResponse.json({
    examples: examplesPayload.examples,
    customized: examplesPayload.customized,
    defaults: DEFAULT_SPLASH_EXAMPLES,
    limits: {
      maxLen: SPLASH_EXAMPLE_MAX_LEN,
      maxCount: SPLASH_EXAMPLES_MAX,
      nameMaxLen: SPLASH_DISPLAY_NAME_MAX_LEN,
    },
    displayName: { override, fallback },
  });
}

export async function PUT(req: Request) {
  let body: { examples?: unknown; displayName?: unknown } = {};
  try {
    body = (await req.json()) as { examples?: unknown; displayName?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const cwd = await activeCwd();
  // Each field is independently optional — same pattern as
  // /api/sessions/open-tabs so the client can save just the chips, just
  // the name, or both in one round-trip.
  let examples = (await getSplashExamples(cwd)).examples;
  let customized = (await getSplashExamples(cwd)).customized;
  if (body.examples !== undefined) {
    if (!Array.isArray(body.examples)) {
      return NextResponse.json(
        { error: "examples must be an array of strings" },
        { status: 400 },
      );
    }
    examples = await setSplashExamples(
      cwd,
      body.examples.filter((x): x is string => typeof x === "string"),
    );
    customized = true;
  }
  let override: string | null;
  if (body.displayName !== undefined) {
    // null / empty string / whitespace all clear the override; a real
    // string saves it (trimmed + capped server-side).
    if (body.displayName !== null && typeof body.displayName !== "string") {
      return NextResponse.json(
        { error: "displayName must be a string or null" },
        { status: 400 },
      );
    }
    override = await setSplashDisplayName(cwd, body.displayName);
  } else {
    override = await getSplashDisplayName(cwd);
  }
  const fallback = await resolveSplashFallbackName();
  return NextResponse.json({
    examples,
    customized,
    displayName: { override, fallback },
  });
}

export async function DELETE() {
  const cwd = await activeCwd();
  await Promise.all([resetSplashExamples(cwd), setSplashDisplayName(cwd, null)]);
  const fallback = await resolveSplashFallbackName();
  return NextResponse.json({
    examples: DEFAULT_SPLASH_EXAMPLES,
    customized: false,
    displayName: { override: null, fallback },
  });
}
