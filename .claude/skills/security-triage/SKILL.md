---
name: security-triage
description: Check the GitHub code-scanning page, triage each open alert (read source + sink, classify true positive vs false positive), propose a fix the user can OK, implement it, commit the scoped change, and re-check after the next scan. Use whenever the user says "check the security page", "fix the code scanning alerts", "what's on /security/code-scanning", "triage CodeQL findings", or asks you to look at security alerts for this repo.
allowed-tools:
  - Bash
  - Read
  - Edit
  - Grep
  - Glob
  - WebFetch
---

# Triage and fix code-scanning alerts

Goal: walk an open code-scanning alert from "I see a red box on the security tab" to "the alert is closed, my commit is on `main`, the fix is right rather than just plausible." User holds the pen on every decision that changes files or alert state.

This skill assumes the `gh` CLI is authenticated and the repo has GitHub code-scanning enabled (`.github/workflows/codeql.yml`).

## Steps

### 1. List open alerts

```bash
gh api repos/$(gh repo view --json nameWithOwner --jq .nameWithOwner)/code-scanning/alerts \
  --paginate --jq '.[] | select(.state=="open") | {
    number, rule_id: .rule.id, severity: .rule.severity,
    file: .most_recent_instance.location.path,
    line: .most_recent_instance.location.start_line,
    message: .most_recent_instance.message.text
  }'
```

Report in one line per alert. Severity order: `error` > `warning` > `note`. Group by `rule_id` if there are clusters — one rule often fires on many files at once, and the fix is usually shared.

### 2. Pull full detail for the alert(s) you'll work on

```bash
gh api repos/$REPO/code-scanning/alerts/<N> \
  --jq '{html_url, rule: .rule, instance: .most_recent_instance}'
```

The `message.markdown` field often embeds the SOURCE location (`#L<n>C<m>-L<n>C<m>`) — that's where the tainted value originates. The `location` is the SINK. Read **both** files before drafting a fix; sanitizer placement depends on the whole flow, not the sink alone.

### 3. Read the code at source AND sink

`Read` both files at the relevant offsets. For taint-flow rules (`js/xss-through-dom`, `js/path-injection`, `js/regex-injection`, etc.), trace the value from source → sink mentally. Note every function it passes through — CodeQL's inter-procedural analysis often sees flows that look fine at the sink but are dangerous at the source.

If the file has prior CodeQL-fix commits (`git log --oneline -- <file>` and grep for "CodeQL" / "security"), **read them**. Recurring alerts on the same file usually mean a previous fix was guessed-at and didn't satisfy the query. Don't repeat the same guess.

### 4. Classify: true positive, false positive, or already-mitigated

Three buckets:

- **True positive** — the warning describes a real bug. Fix the code.
- **False positive** — the warning describes a flow that's safe in practice (an invariant CodeQL can't see). Fix is either (a) a CodeQL-recognized sanitizer added defensively, or (b) dismissal with a comment explaining the invariant.
- **Already mitigated** — the alert was there pre-fix and the next scan just hasn't run yet. Confirm with `git log` against the file/line; if the fix is already on `main`, leave it — the alert closes on the next scheduled scan.

When in doubt between (a) and (b), prefer (a) — a defensive runtime check costs nothing and protects against future refactors that change the producer.

### 5. If a recognized-sanitizer attempt doesn't work, read CodeQL's query source

This is the lesson that took four attempts to learn: CodeQL's sanitizer recognition is narrower than the docs suggest, and intuition about "safe" patterns is often wrong. Two failed attempts on the same alert = STOP and read the actual query source before trying a third.

```bash
# Find the rule's qll file. Rules are named like `js/<rule-name>`.
# Source lives in github/codeql under javascript/ql/lib/semmle/javascript/security/dataflow/
```

Use `WebFetch` against `raw.githubusercontent.com/github/codeql/main/javascript/ql/lib/semmle/javascript/security/dataflow/<RuleName>Query.qll` and ask which functions/patterns extend the sanitizer class for that rule. Examples of non-obvious behavior we've hit:

- `URL.createObjectURL` is a **flow step** (taint propagator), not a sanitizer.
- `s.startsWith("blob:")` triggers `PrefixStringSanitizer` but **only** when taint is at the prefix position — whole-string taint isn't sanitized.
- `new URL(s).protocol === "..."` is **not** a recognized barrier for `js/xss-through-dom`.
- `encodeURI`, `encodeURIComponent`, `escape` ARE recognized via `UriEncodingSanitizer` — and `encodeURI` is a no-op on valid `blob:` / `https:` URLs, so it's often a free win.

When the source's barrier list rules out every "obvious" fix, you're in dismissal territory — see step 7.

### 6. Propose the fix — do not edit yet

Hand the user back:

- **Alert** (number, rule id, file:line).
- **Diagnosis** in one sentence ("CodeQL traces taint from `e.target.files` through `URL.createObjectURL` to the `<img src=>` sink; previous `startsWith` and `new URL().protocol` attempts didn't satisfy the query").
- **Proposed fix** as an exact diff hunk in a fenced block.
- **Confidence**: high (grounded in CodeQL source / canonical pattern), medium (plausible, will need re-scan to confirm), low (third+ attempt on a stubborn alert).
- If multiple reasonable options exist, use `AskUserQuestion` with 2–3 concrete diffs. Don't ask abstract "should I X or Y" — show the actual code.

**Wait for the user to say go.** Then apply the edit.

### 7. When dismissal is the right answer

If the code is provably safe and two CodeQL-recognized sanitizer patterns have already failed, propose dismissal:

```bash
gh api -X PATCH repos/$REPO/code-scanning/alerts/<N> \
  -f state=dismissed \
  -f dismissed_reason='false positive' \
  -f dismissed_comment='<one-paragraph explanation of the invariant CodeQL cannot see + list of patterns tried>'
```

`dismissed_reason` must be one of: `"false positive"`, `"won't fix"`, `"used in tests"`.

**Always ask the user first** — dismissal mutates state on GitHub and shows up in the audit log under their account. Phrase the question with the comment text pre-filled so they can approve verbatim.

### 8. After applying the edit — verify locally

Before proposing the commit:

```bash
bun run lint <touched-files>      # scope to changed files
bun run test                       # full unit suite is fast
```

Lint must be clean on the touched files. If lint surfaces an unrelated pre-existing error, run it again — concurrent agent runs sometimes inject false positives; per the project's `lint-policy` memory the second run filters those out.

### 9. Commit — scoped, never `git add -A`

If the working tree has unrelated WIP (very common in this repo), explicitly scope the `git add` to the security-fix paths only:

```bash
git add <file1> <file2>
git commit -m "$(cat <<'EOF'
fix(security): <one-line, alert rule + what changed>

CodeQL alert #<N> (`<rule-id>`). <2–4 sentence explanation of the
invariant the alert was missing and the sanitizer that satisfies it.>
EOF
)"
```

Match the repo's existing voice — see `git log --oneline -20`. The body is for the *why* (which CodeQL query, which sanitizer, why this approach over the alternatives), not the *what* (the diff already shows what).

**Push only if the user asked you to.** Many users batch security fixes with other work; default is to leave the commit local and tell the user the branch is ready to push.

### 10. Re-check after the next scan

After the fix is pushed (whether by you or the user), CodeQL re-scans on push to `main` and on every PR. The alert will close automatically when the next scan passes.

You can confirm closure with:

```bash
gh api repos/$REPO/code-scanning/alerts/<N> --jq '.state'   # → "fixed" or "dismissed"
```

Or list all currently-open alerts to confirm none remain:

```bash
gh api repos/$REPO/code-scanning/alerts --paginate \
  --jq '.[] | select(.state=="open") | .number'
```

If the alert is still open after the next scan completes (check the CodeQL workflow run in Actions), the fix didn't take — go back to step 5, this time WITH the CodeQL source open, and switch approach.

## What NOT to do

- **Don't WebFetch the GitHub Security HTML page.** It's an SPA — the body is empty until JS runs. Use `gh api` for everything.
- **Don't propose a fix without reading the source line.** "DOM text reinterpreted as HTML" tells you the rule, not where the value came from. The `message.markdown` field has the source location; read it.
- **Don't iterate on the same flawed pattern.** Two CodeQL re-scans with the same kind of sanitizer = the sanitizer category doesn't satisfy the query. Switch approach (read the query source, refactor the data flow, or dismiss).
- **Don't `git add -A` / `git commit -am`.** The working tree usually has unrelated WIP. Stage by path.
- **Don't dismiss without an explanatory comment.** A bare dismissal looks like the alert was ignored; a paragraph explaining the invariant is the audit trail a future reviewer needs.
- **Don't auto-push.** The user holds the push pen — security fixes often batch with other work.
- **Don't bring back a pattern that already failed in `git log` for this file.** Read the prior fix commits first. If `startsWith("blob:")` was tried twice before, don't try it again — try something the prior fixes didn't.

## Quick reference

| What | Command |
| --- | --- |
| List open alerts | `gh api repos/$REPO/code-scanning/alerts --paginate --jq '.[] \| select(.state=="open") \| {number, rule_id: .rule.id, severity: .rule.severity, file: .most_recent_instance.location.path, line: .most_recent_instance.location.start_line, message: .most_recent_instance.message.text}'` |
| One alert detail | `gh api repos/$REPO/code-scanning/alerts/<N>` |
| Re-scan status | `gh run list --workflow=codeql.yml --limit 3 --json status,conclusion,headSha,createdAt` |
| Read CodeQL query | `WebFetch https://raw.githubusercontent.com/github/codeql/main/javascript/ql/lib/semmle/javascript/security/dataflow/<RuleName>Query.qll` |
| Dismiss as false positive | `gh api -X PATCH repos/$REPO/code-scanning/alerts/<N> -f state=dismissed -f dismissed_reason='false positive' -f dismissed_comment='...'` |
| Reopen a dismissed alert | `gh api -X PATCH repos/$REPO/code-scanning/alerts/<N> -f state=open` |
| Confirm alert closed | `gh api repos/$REPO/code-scanning/alerts/<N> --jq '.state'` |

## Known CodeQL JS sanitizer cheatsheet (from query source)

For `js/xss-through-dom` and `js/dom-based-xss`:

- ✅ `encodeURI(x)`, `encodeURIComponent(x)`, `escape(x)` → `UriEncodingSanitizer`
- ✅ `s.startsWith("X")` → `PrefixStringSanitizer` — **only if** taint is at prefix position (i.e. the SOURCE was a string and the tainted part is at the start). Whole-string taint (e.g. through `URL.createObjectURL`) isn't sanitized.
- ✅ `typeof s === "string"` → `TypeTestGuard`
- ✅ DOMPurify / sanitize-html calls → `HtmlSanitizerAsSanitizer`
- ✅ `s.replace(/[<>&"']/g, ...)` → `MetacharEscapeSanitizer`
- ❌ `URL.createObjectURL(file)` is a **flow step**, not a sanitizer — propagates taint.
- ❌ `new URL(s).protocol === "..."` is NOT recognized (at least as of writing).
- ❌ Substring/regex/length checks alone are NOT recognized.

For `js/regex-injection` and `js/incomplete-sanitization`:

- ✅ Full-coverage escape: `s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")` (the MDN canonical pattern).
- ❌ Partial escapes that miss any of `\`, `^`, `$`, `.`, `|`, `?`, `*`, `+`, `(`, `)`, `[`, `]`, `{`, `}`.

For `js/path-injection`:

- ✅ `path.resolve(base, user)` followed by `result.startsWith(base + path.sep)` — inline at the sink.
- ❌ Same check wrapped in a helper function — CodeQL doesn't propagate the barrier through call boundaries reliably.

Keep this list updated. When you find a sanitizer that CodeQL accepts (or rejects) by inspecting the `.qll`, add it here so the next pass doesn't re-derive it.
