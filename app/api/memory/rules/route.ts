import { NextResponse } from "next/server";
import {
  deleteRule,
  listRules,
  readRule,
  rulesDir,
  writeRule,
  type RuleScope,
} from "@/lib/server/rules";
import { PathInjectionError } from "@/lib/server/safe-path";

export const runtime = "nodejs";

function parseScope(url: URL): RuleScope | null {
  const raw = url.searchParams.get("scope") ?? "project";
  if (raw === "user" || raw === "project") return raw;
  return null;
}

// A bad/relative project cwd surfaces from inside any rules.ts call (each
// resolves the dir via assertAbsoluteUserPath). Map that to a 400.
function fail(err: unknown): NextResponse {
  if (err instanceof PathInjectionError) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
  return NextResponse.json(
    { error: err instanceof Error ? err.message : String(err) },
    { status: 500 },
  );
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const scope = parseScope(url);
  if (!scope) return NextResponse.json({ error: "invalid scope" }, { status: 400 });
  const cwd = scope === "project" ? url.searchParams.get("cwd") : null;
  const file = url.searchParams.get("file");
  try {
    if (file) {
      const content = await readRule(scope, file, cwd);
      if (content === null) return NextResponse.json({ error: "not found" }, { status: 404 });
      return NextResponse.json({ name: file, content });
    }
    const files = await listRules(scope, cwd);
    return NextResponse.json({ dir: rulesDir(scope, cwd), files });
  } catch (err) {
    return fail(err);
  }
}

type PostBody = { filename?: string; body?: string };

export async function POST(req: Request) {
  const url = new URL(req.url);
  const scope = parseScope(url);
  if (!scope) return NextResponse.json({ error: "invalid scope" }, { status: 400 });
  const cwd = scope === "project" ? url.searchParams.get("cwd") : null;
  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (typeof body?.filename !== "string" || typeof body?.body !== "string") {
    return NextResponse.json({ error: "filename and body required" }, { status: 400 });
  }
  try {
    const result = await writeRule(scope, body.filename, body.body, cwd, false);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ name: result.name, path: result.path }, { status: 201 });
  } catch (err) {
    return fail(err);
  }
}

type PatchBody = { body?: string };

export async function PATCH(req: Request) {
  const url = new URL(req.url);
  const scope = parseScope(url);
  if (!scope) return NextResponse.json({ error: "invalid scope" }, { status: 400 });
  const cwd = scope === "project" ? url.searchParams.get("cwd") : null;
  const filename = url.searchParams.get("filename");
  if (!filename) {
    return NextResponse.json({ error: "filename query param required" }, { status: 400 });
  }
  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (typeof body?.body !== "string") {
    return NextResponse.json({ error: "body required" }, { status: 400 });
  }
  try {
    const result = await writeRule(scope, filename, body.body, cwd, true);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ name: result.name, path: result.path });
  } catch (err) {
    return fail(err);
  }
}

export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const scope = parseScope(url);
  if (!scope) return NextResponse.json({ error: "invalid scope" }, { status: 400 });
  const cwd = scope === "project" ? url.searchParams.get("cwd") : null;
  const filename = url.searchParams.get("filename");
  if (!filename) {
    return NextResponse.json({ error: "filename query param required" }, { status: 400 });
  }
  try {
    const result = await deleteRule(scope, filename, cwd);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return fail(err);
  }
}
