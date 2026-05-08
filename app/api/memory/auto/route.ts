import { NextResponse } from "next/server";
import {
  autoMemoryDir,
  deleteMemoryFile,
  listAutoMemory,
  patchMemoryFile,
  readMemoryFile,
  writeMemoryFile,
  type MemoryType,
} from "@/lib/server/auto-memory";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const cwd = url.searchParams.get("cwd") || process.cwd();
  const file = url.searchParams.get("file");
  if (file) {
    const content = await readMemoryFile(cwd, file);
    if (content === null) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ name: file, content });
  }
  const list = await listAutoMemory(cwd);
  return NextResponse.json({ dir: autoMemoryDir(cwd), files: list });
}

type PostBody = {
  filename?: string;
  type?: MemoryType;
  name?: string;
  description?: string;
  body?: string;
};

export async function POST(req: Request) {
  const url = new URL(req.url);
  const cwd = url.searchParams.get("cwd") || process.cwd();
  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (
    typeof body?.filename !== "string" ||
    typeof body?.type !== "string" ||
    typeof body?.name !== "string" ||
    typeof body?.description !== "string" ||
    typeof body?.body !== "string"
  ) {
    return NextResponse.json({ error: "filename/type/name/description/body required" }, { status: 400 });
  }
  const result = await writeMemoryFile(cwd, {
    filename: body.filename,
    type: body.type,
    name: body.name,
    description: body.description,
    body: body.body,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ name: result.name, path: result.path }, { status: 201 });
}

type PatchBody = {
  description?: string;
  type?: MemoryType;
  body?: string;
};

export async function PATCH(req: Request) {
  const url = new URL(req.url);
  const cwd = url.searchParams.get("cwd") || process.cwd();
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
  if (
    body == null ||
    (body.description === undefined && body.type === undefined && body.body === undefined)
  ) {
    return NextResponse.json({ error: "at least one of description/type/body required" }, { status: 400 });
  }
  const r = await patchMemoryFile(cwd, {
    filename,
    description: body.description,
    type: body.type,
    body: body.body,
  });
  if (!r.ok) {
    return NextResponse.json({ error: r.error }, { status: r.status });
  }
  return NextResponse.json({ path: r.path, parsed: r.parsed });
}

export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const cwd = url.searchParams.get("cwd") || process.cwd();
  const filename = url.searchParams.get("filename");
  if (!filename) {
    return NextResponse.json({ error: "filename query param required" }, { status: 400 });
  }
  const r = await deleteMemoryFile(cwd, filename);
  if (!r.ok) {
    return NextResponse.json({ error: r.error }, { status: r.status });
  }
  return NextResponse.json({ ok: true });
}
