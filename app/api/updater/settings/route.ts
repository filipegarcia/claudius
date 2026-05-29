import { NextResponse } from "next/server";
import {
  getUpdaterSettings,
  patchUpdaterSettings,
  type UpdaterMode,
} from "@/lib/server/updater/settings";

export const runtime = "nodejs";

const ALLOWED_MODES: ReadonlyArray<UpdaterMode> = [
  "cc-merge",
  "ff-only",
  "notify-only",
  "disabled",
];

export async function GET() {
  return NextResponse.json(await getUpdaterSettings());
}

export async function PUT(req: Request) {
  const body = (await req.json()) as Partial<{
    mode: string;
    remote: string;
    branch: string;
    intervalHours: number;
  }>;
  const patch: Parameters<typeof patchUpdaterSettings>[0] = {};
  if (body.mode !== undefined) {
    if (!ALLOWED_MODES.includes(body.mode as UpdaterMode)) {
      return NextResponse.json(
        { error: `mode must be one of ${ALLOWED_MODES.join(", ")}` },
        { status: 400 },
      );
    }
    patch.mode = body.mode as UpdaterMode;
  }
  if (typeof body.remote === "string") patch.remote = body.remote;
  if (typeof body.branch === "string") patch.branch = body.branch;
  if (typeof body.intervalHours === "number") patch.intervalHours = body.intervalHours;
  const next = await patchUpdaterSettings(patch);
  return NextResponse.json(next);
}
