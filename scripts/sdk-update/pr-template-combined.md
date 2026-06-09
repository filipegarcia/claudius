<!--
  PR body template for COMBINED SDK-update + CC-parity branches.
  `orchestrate.ts` reads this file, substitutes the {{...}} placeholders,
  inlines the matching sections from BOTH run-notes files, and passes the
  result to `gh pr create --body`. Used only when the SDK orchestrator's
  combined mode picks up a CC-parity tag-along on the same firing.

  Placeholders:
    {{NEW_SDK_VERSION}}            e.g. 0.3.142
    {{PREVIOUS_SDK_VERSION}}       e.g. 0.3.141
    {{SDK_CHANGELOG_URL}}          compare URL on claude-agent-sdk-typescript
    {{SDK_CHANGELOG_BODY}}         verbatim SDK changelog excerpt PREV..NEW
    {{NEW_CC_VERSION}}             e.g. 1.0.40
    {{PREVIOUS_CC_VERSION}}        e.g. 1.0.39
    {{CC_CHANGELOG_URL}}           compare URL on anthropics/claude-code
    {{CC_CHANGELOG_BODY}}          verbatim CC changelog excerpt PREV..NEW
    {{SDK_NOTES_SUMMARY}}          "## Summary" from SDK run-notes
    {{SDK_NOTES_SDK}}              "## SDK changelog highlights" from SDK run-notes
    {{SDK_NOTES_CODE}}             "## Code changes" from SDK run-notes
    {{CC_NOTES_SUMMARY}}           "## Summary" from CC run-notes
    {{CC_NOTES_CLASSIFICATION}}    "## Changelog classification" from CC run-notes
    {{CC_NOTES_IMPLEMENTED}}       "## Implemented (bucket B)" from CC run-notes
    {{COMBINED_NOTES_UI}}          concatenation of both "New UI surfaces" sections
    {{COMBINED_NOTES_TESTS}}       concatenation of both "Tests" sections
    {{COMBINED_NOTES_RISKS}}       concatenation of both "Risks / follow-ups" sections
    {{COMBINED_SCREENSHOTS_BLOCK}} merged screenshots from both docs/ trees
    {{BUDGET_STATUS}}              either "" (clean run) or a warning block
-->

# Combined bump: claude-agent-sdk `{{PREVIOUS_SDK_VERSION}}` → `{{NEW_SDK_VERSION}}` + claude-code parity `{{PREVIOUS_CC_VERSION}}` → `{{NEW_CC_VERSION}}`

> ℹ️ **This PR combines two pipelines triggered by the same hourly firing.**
> The SDK updater found a new `@anthropic-ai/claude-agent-sdk` release
> and, on the same firing, the cc-parity probe found a newer
> `@anthropic-ai/claude-code` baseline — so both upgrades ride this
> branch in a single review. The two halves are **disjoint by design**:
> the SDK half migrates bucket-A items (SDK-exposed), the CC half ships
> bucket-B items (product-surface). See the CC classification section
> below to confirm the bot didn't duplicate work across the line.

{{BUDGET_STATUS}}

## SDK half — `claude-agent-sdk` `{{PREVIOUS_SDK_VERSION}}` → `{{NEW_SDK_VERSION}}`

{{SDK_NOTES_SUMMARY}}

### SDK upstream changelog

[Compare on GitHub →]({{SDK_CHANGELOG_URL}})

<details>
<summary>Raw upstream SDK changelog between <code>v{{PREVIOUS_SDK_VERSION}}</code> and <code>v{{NEW_SDK_VERSION}}</code></summary>

{{SDK_CHANGELOG_BODY}}

</details>

### SDK highlights mapped to Claudius

{{SDK_NOTES_SDK}}

### What changed for the SDK half

{{SDK_NOTES_CODE}}

---

## CC parity half — `claude-code` `{{PREVIOUS_CC_VERSION}}` → `{{NEW_CC_VERSION}}`

{{CC_NOTES_SUMMARY}}

### CC upstream changelog

[Compare on GitHub →]({{CC_CHANGELOG_URL}})

<details>
<summary>Raw upstream claude-code changelog between <code>v{{PREVIOUS_CC_VERSION}}</code> and <code>v{{NEW_CC_VERSION}}</code></summary>

{{CC_CHANGELOG_BODY}}

</details>

### CC changelog classification (A / B / C)

This is where the bot bucketed each substantive CC entry. Items tagged
`[A]` are intentionally **NOT** implemented in the CC half — they
should already be covered by the SDK migration above. If you see a
bucket-A item in the SDK changelog highlights AND in this section
without a `[skip — already shipped via SDK migration]` marker, the bot
likely duplicated work — flag it on the PR.

{{CC_NOTES_CLASSIFICATION}}

### CC bucket-B items implemented

{{CC_NOTES_IMPLEMENTED}}

---

## New UI surfaces (combined)

{{COMBINED_NOTES_UI}}

{{COMBINED_SCREENSHOTS_BLOCK}}

## Tests (combined)

{{COMBINED_NOTES_TESTS}}

## Risks / follow-ups (combined)

{{COMBINED_NOTES_RISKS}}

---

<sub>
Opened automatically by `scripts/sdk-update/orchestrate.ts` in combined
mode (the cc-parity probe found `{{PREVIOUS_CC_VERSION}}` → `{{NEW_CC_VERSION}}` was
also out, so both upgrades ride this branch). The body is generated
from `scripts/sdk-update/pr-template-combined.md` and the run-notes
files at `.claudius/sdk-updater/run-notes/{{NEW_SDK_VERSION}}.md` and
`.claudius/cc-parity/run-notes/{{NEW_CC_VERSION}}.md`.
</sub>
