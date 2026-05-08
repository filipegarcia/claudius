---
name: sdk-message-handler
description: Add a new server-event type that flows from `lib/server/session.ts` through SSE to `lib/client/use-session.ts`. Covers the type declarations, broadcast site, replay-buffer rules, and client reducer. Use when the user says "we need to surface X from the agent" / "add a new SSE event".
allowed-tools:
  - Read
  - Edit
  - Grep
  - Glob
---

# SDK message handler

Adding a new event has six edits. Skip any of them and you'll get either a silent no-op or a TypeScript error during build.

## 1. Declare the event type

`lib/shared/events.ts` — add to the `ServerEvent` union and export the dedicated shape.

```ts
export type FooEvent = {
  type: "foo";
  payload: { … };
};

export type ServerEvent =
  | { type: "sdk"; message: SDKMessage }
  | …
  | FooEvent;
```

The literal `type` string is the wire contract. Don't change it once shipped.

## 2. Broadcast it from the server

`lib/server/session.ts` — wherever the event originates (often inside `consume()` while iterating SDK messages, or from a `canUseTool` callback):

```ts
this.broadcast({ type: "foo", payload: { … } });
```

`broadcast()` pushes to `this.buffer` AND notifies live subscribers. That's usually what you want.

## 3. Decide if it should replay

Some events are **live-only** (permission requests, ask-user-question forms): replaying them on a new subscriber would re-pop a stale modal. Filter those in `subscribe()`'s replay loop.

```ts
for (const ev of toReplay) {
  if (ev.type === "permission_request" || ev.type === "ask_user_question") continue;
  // ↑ add yours here if it represents a one-shot user-facing prompt
  fn(ev);
}
```

If unsure, default to replaying — wrong replays are visible bugs, missed replays are silent ones.

## 4. Handle it client-side

`lib/client/use-session.ts` `applyEvent` — add a branch above the `ev.type === "sdk"` check:

```ts
if (ev.type === "foo") {
  setFoo(ev.payload);
  return;
}
```

If the event reflects state, hold it in a useState and surface via the hook's return.

## 5. Type the hook surface

`lib/client/types.ts` — extend `ChatState` (and `ChatActions` if there's a corresponding action) so consumers see the new field.

## 6. Resolve / clear

If your event represents something resolvable (a request, a notification), wire the resolution:

- Server: a method that resolves the pending promise and broadcasts a paired clearing event (or just removes from `pendingFoos` map).
- Client: an action method that POSTs the resolution to a route handler.
- Reset: clear the state in `resetState()` so a new session doesn't inherit the old.

## Common pitfalls

- **Forgetting step 3.** Symptom: stale modal pops on every reload. Add the buffer-skip.
- **Forgetting step 6.** Symptom: pending state stuck after the agent moved on. Either a clearing event or an idle timer.
- **Renaming the wire type.** Symptom: old clients break against new servers. Don't. Add a new type instead, deprecate the old one.
- **Storing rich objects in events.** Symptom: bigger SSE payloads, longer replay times. Send refs/ids, look up the data client-side.
