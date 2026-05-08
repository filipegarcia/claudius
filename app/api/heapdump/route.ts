import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST() {
  try {
    // Node's diagnostic report — includes JavaScript stacks, native stack,
    // heap statistics, libuv handles, GC metrics. Not a v8 heap snapshot, but
    // 100× cheaper to write and the right tool for "what is this process doing".
    const report = (process as unknown as { report?: { writeReport: () => string } }).report;
    if (!report?.writeReport) {
      return NextResponse.json(
        { ok: false, error: "process.report.writeReport not available" },
        { status: 500 },
      );
    }
    const path = report.writeReport();
    return NextResponse.json({ ok: true, path });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
