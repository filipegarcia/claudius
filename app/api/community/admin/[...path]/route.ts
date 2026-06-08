import { NextResponse } from "next/server";
import { withCommunityClientParam } from "@/lib/shared/community-client";

export const runtime = "nodejs";

/**
 * Proxy for the chat-server's `/admin/*` endpoints. Injects the
 * `X-Admin-Token` header server-side so the token (CLAUDIUS_CHAT_ADMIN_TOKEN)
 * never reaches the browser. The client calls these routes with the same
 * verb + body it would have used against the chat-server directly.
 *
 * Path mapping: `/api/community/admin/<path...>` → `${SERVER}/admin/<path...>`
 */

function serverUrl(): string {
  return (process.env.NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL ?? "").replace(/\/+$/, "");
}

function adminToken(): string {
  return process.env.CLAUDIUS_CHAT_ADMIN_TOKEN ?? "";
}

async function proxy(
  req: Request,
  ctx: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const server = serverUrl();
  const token = adminToken();
  if (!server) {
    return NextResponse.json(
      { error: "NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL is not set" },
      { status: 503 },
    );
  }
  if (!token) {
    return NextResponse.json(
      { error: "CLAUDIUS_CHAT_ADMIN_TOKEN is not set on this install" },
      { status: 403 },
    );
  }
  const { path } = await ctx.params;
  const target = withCommunityClientParam(
    `${server}/admin/${path.map(encodeURIComponent).join("/")}`,
  );
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  // Read the body as text — the admin surface only takes small JSON payloads,
  // and re-streaming would just add complexity for no gain.
  const body = hasBody ? await req.text() : undefined;
  const upstream = await fetch(target, {
    method: req.method,
    headers: {
      "X-Admin-Token": token,
      ...(body && body.length > 0 ? { "Content-Type": "application/json" } : {}),
    },
    body: body && body.length > 0 ? body : undefined,
  });
  const text = await upstream.text();
  return new NextResponse(text, {
    status: upstream.status,
    headers: {
      "Content-Type":
        upstream.headers.get("Content-Type") ?? "application/json",
    },
  });
}

export const GET = proxy;
export const POST = proxy;
export const DELETE = proxy;
