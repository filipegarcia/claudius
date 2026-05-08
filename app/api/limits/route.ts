import { NextResponse } from "next/server";
import {
  appendAudit,
  readLimits,
  sessionOverrideKey,
  setOverride,
  writeLimits,
  type Limits,
  type LimitsAuditEvent,
} from "@/lib/server/limits-store";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const cwd = url.searchParams.get("cwd") || process.cwd();
  const data = await readLimits(cwd);
  return NextResponse.json(data);
}

export async function PUT(req: Request) {
  const url = new URL(req.url);
  const cwd = url.searchParams.get("cwd") || process.cwd();
  let body: Limits;
  try {
    body = (await req.json()) as Limits;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const next: Limits = {};
  if (typeof body.projectDailyUsd === "number" && body.projectDailyUsd >= 0) {
    next.projectDailyUsd = body.projectDailyUsd;
  }
  if (typeof body.sessionUsd === "number" && body.sessionUsd >= 0) {
    next.sessionUsd = body.sessionUsd;
  }
  const data = await writeLimits(cwd, next);
  return NextResponse.json(data);
}

type ActionBody =
  | { action: "audit"; event: LimitsAuditEvent }
  | { action: "override"; sessionId: string; on: boolean };

export async function POST(req: Request) {
  const url = new URL(req.url);
  const cwd = url.searchParams.get("cwd") || process.cwd();
  let body: ActionBody;
  try {
    body = (await req.json()) as ActionBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (body.action === "audit") {
    const data = await appendAudit(cwd, body.event);
    return NextResponse.json(data);
  }
  if (body.action === "override") {
    const data = await setOverride(cwd, sessionOverrideKey(body.sessionId), body.on);
    return NextResponse.json(data);
  }
  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
