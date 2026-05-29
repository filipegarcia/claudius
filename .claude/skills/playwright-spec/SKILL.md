---
name: playwright-spec
description: Write or extend a Playwright e2e test for Claudius following the existing conventions. Picks data-testids over CSS, uses the workspace-activation helper, knows when to inject API fixtures vs hit the real agent. Use when the user says "add a test for" / "cover this with e2e".
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Grep
  - Glob
---

# Playwright spec

Tests live at `tests/e2e/<feature>.spec.ts`. Run them with `bun run test:e2e` (or `:headed` to watch).

## Selectors

Always `data-testid`. Never CSS classes (Tailwind classes change). Never user-visible text alone (i18n drift). The test ids are stable contracts; if you don't see one for the element you need, **add it to the component first**, in the same MR.

```ts
const btn = page.getByTestId("session-tabs-overflow");
await btn.click();
```

For lists, use a regex:

```ts
const items = page.getByTestId(/^todos-banner-item-/);
await expect(items).toHaveCount(3);
```

## Workspace setup

Every test runs inside the "claudius" workspace so the chrome (sidebar, tab strip) reflects the active project. The `activateClaudiusWorkspace` helper in `site-screenshots.spec.ts` is the reference; copy it or import it.

## Real agent vs fixture

| Scenario | Approach |
|---|---|
| UI behavior only (modals, forms, validation) | No agent. Fake the SSE event or POST to the relevant API directly. |
| Plumbing through the agent (TodoWrite, AskUserQuestion, tool_use) | Hit the real Anthropic API. `bypassPermissions` so prompts don't gate. Set `test.setTimeout(180_000)` so a slow turn doesn't false-fail. |
| Page screenshots | `page.route("**/api/<endpoint>*", …)` to inject deterministic data. See the cost screenshot for the pattern. |

Agent-driven tests are flaky-by-nature; one retry is acceptable, two is a regression. Don't paper over flakes by skipping.

## Persisted state

Tests inherit state across runs (open tabs, sessions, commit drafts). Reset what your test cares about at the start:

```ts
await page.request.put(`${baseURL}/api/sessions/open-tabs`, {
  data: { tabs: [], activeId: null },
});
```

Don't assume the box is fresh. Don't leave it dirty either — clean up persisted state at the end if the test creates anything that the next run shouldn't see.

## Don't

- Don't use `page.waitForTimeout` for synchronization. Use `expect(...).toBeVisible({ timeout })`. The hard timeouts hide real bugs.
- Don't dump screenshots into the repo "for debugging." Playwright captures them on failure automatically.
- Don't add a test that just navigates to a route and checks status 200. That's not testing anything; it's noise.
