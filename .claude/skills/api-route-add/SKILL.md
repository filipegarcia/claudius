---
name: api-route-add
description: Scaffold a new App Router API route under app/api/ following Claudius conventions — Node runtime, NextResponse JSON, server-only imports under @/lib/server/. Use when the user asks to "add an endpoint" / "expose X over HTTP" / "wire up an API for the UI".
allowed-tools:
  - Read
  - Write
  - Edit
  - Grep
  - Glob
---

# Add an API route

Routes live at `app/api/<segment>/route.ts`. Multiple HTTP methods go in the same file as named exports (`GET`, `POST`, `PUT`, `DELETE`).

## Conventions to follow

1. **Runtime** — start with `export const runtime = "nodejs";`. Edge runtime can't use `better-sqlite3` or the agent SDK.
2. **Server-only deps** — import data layer from `@/lib/server/...`. Never from a client component, never under `@/lib/client/`.
3. **JSON in, JSON out** — `(await req.json())` for input, `NextResponse.json({...})` for output. Use `{ status: 4xx }` for errors.
4. **Validation** — narrow scope/role/id strings against a small const tuple before passing to the data layer. Don't trust the request.
5. **Error shape** — `{ error: "human message" }` on failure. Keep it consistent across routes.

## Skeleton

```ts
import { NextResponse } from "next/server";
import { someDataFn } from "@/lib/server/some-store";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  // ... read query params, validate, call data fn ...
  return NextResponse.json({ ok: true, data: ... });
}

type PutBody = { /* ... */ };

export async function PUT(req: Request) {
  const body = (await req.json()) as PutBody;
  if (!body?.required) return NextResponse.json({ error: "required" }, { status: 400 });
  // ... do work ...
  return NextResponse.json({ ok: true });
}
```

## Dynamic segments

`app/api/<resource>/[id]/route.ts` for per-resource ops. The handler signature is:

```ts
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;  // params is a Promise in Next 16
  // ...
}
```

## Then

- **Add tests** if the route has non-trivial logic. e2e specs hit real routes via `page.request.<method>`.
- **Update the client hook or component** that consumes the route. New routes that nothing calls just rot.
