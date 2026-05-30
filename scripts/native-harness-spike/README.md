# native-harness-spike

Proof-of-concept companion to [`docs/native-harness-feasibility.md`](../../docs/native-harness-feasibility.md).

`spike.ts` is a **standalone** demonstration that a hand-rolled agent loop on the
raw Messages API (`@anthropic-ai/sdk`) can run a complete tool-use round-trip
*without* the Claude Agent SDK's `query()`. It implements one tool (`Read`), a
permission stub, and the send → detect `tool_use` → execute → feed `tool_result`
back → loop cycle.

It is **not** imported by the app and is **not** run in CI (it would make a paid
API call). It exists to ground the feasibility study: the loop itself is small;
everything annotated `GAP:` in the source is the harness work the SDK gives for
free, costed in the doc.

```bash
ANTHROPIC_API_KEY=… bun scripts/native-harness-spike/spike.ts package.json
```

> Authored and type-checked only — not run live here (no API creds in this
> environment, and the raw-API-key path is not the SDK's subscription auth; see
> §4.9 of the feasibility doc).
