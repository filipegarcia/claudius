import { NextResponse } from "next/server";

import {
  listCustomizations,
  listPublishes,
} from "@/lib/server/customizations-store";
import { bootstrapCustomization } from "@/lib/server/customization-bootstrap";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const [customizations, publishes] = await Promise.all([
    listCustomizations(),
    listPublishes(),
  ]);
  return NextResponse.json({ customizations, publishes });
}

type CreateBody = { name?: string };

export async function POST(req: Request) {
  let body: CreateBody = {};
  try {
    body = (await req.json()) as CreateBody;
  } catch {
    // empty body is fine — we'll default the name
  }
  const name = body?.name?.trim() || `Customization ${new Date().toISOString().slice(0, 10)}`;
  try {
    const result = await bootstrapCustomization({ name });
    return NextResponse.json(
      {
        customization: result.customization,
        filesCopied: result.filesCopied,
        srcDir: result.srcDir,
      },
      { status: 201 },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "bootstrap failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
