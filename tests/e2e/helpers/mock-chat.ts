import { type Page, type Route } from "../../helpers/test";

/**
 * Mocked chat backend for specs that drive the chat surface from a canned
 * SSE stream (the pattern the sdk-update / cc-parity specs share): the
 * session POST returns `sessionId`, its stream replays `events`, and the
 * side endpoints the chat polls answer empty.
 *
 * Like the real stream route, the mocked stream ends with a bare
 * `{ type: "ready", sessionId }` after the scripted events (the route's
 * belt-and-suspenders ready, sent after `subscribe()` replays the buffer), so
 * a client handler that lets that bare ready wipe state the replayed ready
 * carried (e.g. `transcriptPath`) fails the spec instead of only the real app.
 */
export type SdkEvent = Record<string, unknown>;

export function sseBody(events: SdkEvent[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

export async function mockChatBackend(
  page: Page,
  sessionId: string,
  events: SdkEvent[],
  opts: { activeId?: string | null } = {},
): Promise<void> {
  await page.route("**/api/sessions", async (route: Route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: sessionId }) });
  });
  await page.route(`**/api/sessions/${sessionId}/stream*`, async (route: Route) =>
    route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
      body: sseBody([...events, { type: "ready", sessionId }]),
    }),
  );
  await page.route("**/api/sessions/open-tabs", async (route: Route) => {
    if (route.request().method() !== "GET") {
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ activeId: opts.activeId ?? null, tabs: [] }),
    });
  });
  await page.route(`**/api/sessions/${sessionId}/pending-prompts`, async (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ asks: [], permissions: [] }) }),
  );
  await page.route("**/api/limits*", async (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ limits: { sessionUsd: 0, projectDailyUsd: 0 } }),
    }),
  );
}

export function initEvent(uuid: string): SdkEvent {
  return { type: "sdk", message: { type: "system", subtype: "init", uuid, model: "claude-sonnet-4-6" } };
}

export function userText(uuid: string, text: string): SdkEvent {
  return { type: "sdk", message: { type: "user", uuid, message: { role: "user", content: [{ type: "text", text }] } } };
}

export function assistantText(uuid: string, text: string): SdkEvent {
  return {
    type: "sdk",
    message: { type: "assistant", uuid, message: { id: `msg_${uuid}`, role: "assistant", content: [{ type: "text", text }] } },
  };
}
