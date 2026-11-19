# #235: Render source attachments in the review code view

- Issue: #235
- Branch: `fix-attachment-code-view`
- Started: 2026-11-19

## TL;DR

Classify attachment text using the same extension rules as the filesystem
review path. JSON and source attachments use CodeView, preserving their
original indentation; Markdown and media keep their existing rendering.

## Scope

In scope:
- Choose the review renderer and syntax language for attachment URLs.
- Cover the attachment fetch and render path with a focused Vitest regression.

Out of scope:
- JSON pretty-printing, attachment serving and media behaviour changes.

## Test plan

- Run `pnpm -C packages/deck test test/review-panel-rerender.test.tsx`.
- Run `pnpm typecheck`, `pnpm check:boundaries`, `node scripts/leak-gate.mjs`,
  `pnpm check:leaks`, `pnpm check:licence` and `pnpm check:lib-version`.
- Run the direct dash scan with
  `rg --hidden --pcre2 -n '[\x{2014}\x{2013}]' --glob '!node_modules' --glob '!build' --glob '!.git' --glob '!.react-router'`
  and run `git diff --check`.

## Follow-ups

None.

## Log

### 2026-11-19: Use the shared extension rules for attachment previews
- What changed: Classify attachment previews using the existing review
  extension helpers and pass the original response text to the renderer.
- Why: The direct fetch only supplied text, so source attachments fell through
  to Markdown. The filesystem review path also serves JSON without reformatting.
- Supersedes: nothing, additive
- Commits: pending

### 2026-11-19: Verify attachment rendering offline
- What changed: Added a regression that failed before the fix and now checks
  that JSON uses the code renderer, preserves indentation and treats HTML
  tags as text. All 143 targeted tests passed, as did typecheck, boundaries,
  licence, library version, the direct dash scan and whitespace checks.
- Why: The sandbox blocked Git subprocesses in both default leak commands and
  the broader review suite's clean-tree check. The same leak scanner passed
  when given the working-tree file list from the shell.
- Supersedes: nothing, additive
- Commits: pending
