---
name: commit-draft
description: Draft a conventional commit message from the working-tree diff — read git status + diff, summarize the why (not the what), match this repo's existing tone. Use when the user says "commit this" / "draft a message" / "write a commit for the staged changes".
allowed-tools:
  - Bash
  - Read
  - Grep
---

# Draft a commit message

Goal: a one-line subject (≤ 72 chars), optional body that explains the *why*. Match the repo's existing voice — see `git log --oneline -20` for tone.

## Steps

1. `git status --short` — see what's staged vs unstaged. If both, ask whether to scope to staged-only.
2. `git diff --staged` (or `git diff` for everything) — read the changes, not just paths.
3. Summarize. The subject answers "what changed *and why*" in one short imperative sentence.
4. If the change is non-trivial (>~50 lines, multiple files, behavior change) add a short body with bullet points. No fluff — the diff already shows what was touched.

## Tone in this repo

- Imperative, lowercase. `add dark mode toggle to settings` — not "Added", not "Adds".
- Skip type prefixes (`feat:`, `fix:`) unless the repo already uses them. Check `git log` first.
- Reference incidents/issues by the *reason*, not the ticket id. "fix race in session-resume" beats "fix CLAUD-1234".
- Don't write "small refactor" or "cleanup" alone — say what got cleaner.

## What NOT to do

- Don't summarize file paths ("update file.ts") — that's what the diff is for.
- Don't lie about scope. If the commit also drops a sneaky feature flag, say so.
- Don't `git commit` yourself — the user asked for a draft, hand it back as a heredoc.
