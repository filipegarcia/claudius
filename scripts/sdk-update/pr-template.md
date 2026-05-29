<!--
  PR body template for automated SDK-update branches.
  `orchestrate.ts` reads this file, substitutes the {{...}} placeholders,
  inlines the matching sections from `.claudius/sdk-updater/run-notes/<version>.md`,
  and passes the result to `gh pr create --body`.

  Placeholders:
    {{NEW_VERSION}}        e.g. 0.3.142
    {{PREVIOUS_VERSION}}   e.g. 0.3.141
    {{CHANGELOG_URL}}      compare URL between the two tags on the upstream repo
    {{CHANGELOG_BODY}}     verbatim changelog excerpt between PREV..NEW
    {{NOTES_SUMMARY}}      "## Summary" section from run-notes
    {{NOTES_SDK}}          "## SDK changelog highlights" from run-notes
    {{NOTES_CODE}}         "## Code changes" from run-notes
    {{NOTES_UI}}           "## New UI surfaces" from run-notes
    {{NOTES_TESTS}}        "## Tests" from run-notes
    {{NOTES_RISKS}}        "## Risks / follow-ups" from run-notes
    {{SCREENSHOTS_BLOCK}}  auto-built list of ![alt](raw.githubusercontent.com URLs)
                           for every PNG under docs/sdk-updates/{{NEW_VERSION}}/
    {{BUDGET_STATUS}}      either "" (clean run) or a warning block when the
                           PR was opened in draft because the budget was hit
-->

# Bump claude-agent-sdk `{{PREVIOUS_VERSION}}` → `{{NEW_VERSION}}`

{{BUDGET_STATUS}}

{{NOTES_SUMMARY}}

## SDK changelog (upstream)

[Compare on GitHub →]({{CHANGELOG_URL}})

<details>
<summary>Raw upstream changelog between <code>v{{PREVIOUS_VERSION}}</code> and <code>v{{NEW_VERSION}}</code></summary>

{{CHANGELOG_BODY}}

</details>

### Highlights mapped to Claudius

{{NOTES_SDK}}

## What changed in this repo

{{NOTES_CODE}}

## New UI surfaces

{{NOTES_UI}}

{{SCREENSHOTS_BLOCK}}

## Tests

{{NOTES_TESTS}}

## Risks / follow-ups

{{NOTES_RISKS}}

---

<sub>
Opened automatically by `scripts/sdk-update/orchestrate.ts`.
The body is generated from `scripts/sdk-update/pr-template.md` and the
run-notes file at `.claudius/sdk-updater/run-notes/{{NEW_VERSION}}.md`.
</sub>
