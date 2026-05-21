# Electron app bugs surfaced by the e2e loop

When the e2e Ralph loop writes a spec that fails because the *app* is
broken (not the spec), the implementor leaves the failing test in repo
wrapped in `test.fail()` (so CI surfaces the regression but doesn't go
red) and records the bug here so a human can pick it up.

## Format

Each bug is a section like:

```md
## <one-line title>

- **Spec**: `tests/electron/<file>.spec.ts` line `NNN`
- **Category**: <category from COVERAGE.md>
- **First seen**: <iso date>
- **Repro**: <copy-paste from the spec or a one-paragraph description>
- **Expected**: <what should happen>
- **Actual**: <what does happen>
- **Notes**: <any debugging the loop already did>
```

---

<!-- new bug sections go here -->
