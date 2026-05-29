import { NextResponse } from "next/server";
import {
  DEFAULT_AUTO_FIX_PROMPT,
  getSettings,
  setSettings,
} from "@/lib/server/customize-settings";

export const runtime = "nodejs";

export async function GET() {
  const settings = await getSettings();
  return NextResponse.json({
    ...settings,
    defaults: { autoFixPrompt: DEFAULT_AUTO_FIX_PROMPT },
  });
}

export async function PUT(req: Request) {
  const body = (await req.json()) as { autoFixPrompt?: string };
  if (typeof body.autoFixPrompt !== "string") {
    return NextResponse.json(
      { error: "autoFixPrompt (string) required" },
      { status: 400 },
    );
  }
  const settings = await setSettings({ autoFixPrompt: body.autoFixPrompt });
  return NextResponse.json(settings);
}
