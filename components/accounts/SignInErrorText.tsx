"use client";

import { accountOnHoldAppealUrl } from "@/lib/shared/account-on-hold";

/**
 * CC 2.1.330 — "[VSCode] Fixed signing in to an account on hold showing a
 * generic failure instead of the on-hold notice and appeal link".
 *
 * A sign-in error message, with the on-hold notice's appeal link (the
 * `appealUrl` `POST /api/accounts/oauth` returns) rendered as a link where it
 * appears in the text. The link is re-checked with the engine's rule, so only
 * an https claude.ai / anthropic.com URL is ever linked; anything else (or
 * no link) renders the message as plain text.
 */
export function SignInErrorText({ message, appealUrl }: { message: string; appealUrl?: string | null }) {
  const at = appealUrl && accountOnHoldAppealUrl(appealUrl) === appealUrl ? message.indexOf(appealUrl) : -1;
  if (!appealUrl || at < 0) return <>{message}</>;
  return (
    <>
      {message.slice(0, at)}
      <a
        href={appealUrl}
        target="_blank"
        rel="noreferrer"
        data-testid="account-on-hold-appeal"
        className="break-all underline underline-offset-2"
      >
        {appealUrl}
      </a>
      {message.slice(at + appealUrl.length)}
    </>
  );
}
