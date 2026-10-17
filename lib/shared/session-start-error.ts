/**
 * CC 2.1.302 parity — "[Cloud sessions] Improved the error shown when a cloud
 * session fails to start: it now says 'Connection lost' or 'Server error'
 * instead of 'Something went wrong'". Claudius's analog is the error banner
 * after `POST /api/sessions` fails: a network failure used to surface the
 * browser's raw `TypeError` text ("Failed to fetch" / "Load failed"), and a
 * server crash read the same as a bad request.
 *
 * Browser-safe, pure.
 */

const PREFIX = "create session failed";

/** The request never reached Claudius (server down, offline, connection reset). */
export function sessionStartConnectionLost(): string {
  return `${PREFIX}: connection lost — couldn't reach Claudius`;
}

/**
 * The server answered with an error. `detail` is the route's `{ error, name }`
 * text when it sent one. A 5xx says "server error" so it isn't mistaken for a
 * problem with what the user asked for; a 4xx keeps the route's own message.
 */
export function sessionStartHttpError(status: number, detail?: string): string {
  const d = detail?.trim();
  if (status >= 500) return d ? `${PREFIX}: server error (${status}) — ${d}` : `${PREFIX}: server error (${status})`;
  return `${PREFIX}: ${d || status}`;
}
