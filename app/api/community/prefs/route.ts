import { NextResponse } from "next/server";
import { readSettings, writeSettings } from "@/lib/server/settings";

export const runtime = "nodejs";

/**
 * GET / PUT the community-chat user preferences from
 * `~/.claude/settings.json`. Two keys:
 *
 *   communityConsent: "yes" | "no" | undefined
 *     The "Connect to the Claudius community?" choice. Persisting it
 *     here (instead of just localStorage like before) means a fresh
 *     Electron install or a switch from desktop → browser keeps the
 *     opt-in, so the consent modal doesn't reappear.
 *
 *   communityNick: string | undefined
 *     The nickname the user picked on first connect. Same reason —
 *     keeps the picker from popping up again on a new install.
 *
 * No other settings keys are accepted by PUT; we whitelist the two
 * community fields so a buggy client can't accidentally rewrite the
 * whole settings file from this surface.
 *
 * The route always operates on the user scope. `cwd` is irrelevant for
 * user-scope reads/writes (the path resolves under $HOME/.claude), but
 * the settings API requires an arg; we pass `process.cwd()`.
 */

type Prefs = {
  consent: "yes" | "no" | null;
  nick: string | null;
};

function readPrefs(s: Record<string, unknown>): Prefs {
  const consent = s.communityConsent;
  const nick = s.communityNick;
  return {
    consent: consent === "yes" || consent === "no" ? consent : null,
    nick: typeof nick === "string" && nick.length > 0 ? nick : null,
  };
}

export async function GET() {
  const settings = await readSettings("user", process.cwd());
  return NextResponse.json(readPrefs(settings as Record<string, unknown>));
}

type PutBody = {
  consent?: "yes" | "no" | null;
  nick?: string | null;
};

export async function PUT(req: Request) {
  let body: PutBody;
  try {
    body = (await req.json()) as PutBody;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const settings = (await readSettings("user", process.cwd())) as Record<
    string,
    unknown
  >;

  // Merge — only touch keys the caller explicitly mentioned. `null`
  // means "clear this key"; undefined means "leave it alone."
  if ("consent" in body) {
    if (body.consent === "yes" || body.consent === "no") {
      settings.communityConsent = body.consent;
    } else if (body.consent === null) {
      delete settings.communityConsent;
    } else {
      return NextResponse.json(
        { error: "consent must be 'yes', 'no', or null" },
        { status: 400 },
      );
    }
  }
  if ("nick" in body) {
    if (typeof body.nick === "string" && body.nick.length > 0) {
      // Reasonable cap — keep ~/.claude/settings.json from growing on a
      // pathological input. Matches the nickname regex enforced
      // client-side and server-side in the chat-server itself.
      if (body.nick.length > 64) {
        return NextResponse.json(
          { error: "nick too long" },
          { status: 400 },
        );
      }
      settings.communityNick = body.nick;
    } else if (body.nick === null || body.nick === "") {
      delete settings.communityNick;
    } else {
      return NextResponse.json(
        { error: "nick must be a string or null" },
        { status: 400 },
      );
    }
  }

  await writeSettings("user", process.cwd(), settings);
  return NextResponse.json(readPrefs(settings));
}
