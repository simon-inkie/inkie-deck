# #37: "Known limitations" is out of date after this run

- Issue: #37
- Branch: 37-known-limitations-audit
- Started: 2026-10-12

## TL;DR

Audits every entry in INSTALL.md "Known limitations" against the code and the
merged PRs. Corrects three entries the 2026-09-27 WSL run changed, one that a
merged PR made wrong, adds three real limitations that were unlisted, and puts
a "checked" note on entries that are still true.

## Scope

In scope: the Known limitations section of INSTALL.md. The README has no copy
of the list.

Out of scope: anything outside that section (see Follow-ups).

## Acceptance

- Each entry says what was measured, by whom (rig or by hand) and when.
- The PR carries a table: limitation, still true or not, evidence.

## Test plan

- Reproduce by hand the two behavioural claims (CLI send target, quoted
  header split) and read the code for the rest.
- `node rig/self-test.mjs`, the CI checks.

## Decisions log

- Dates for by-hand runs (2026-09-27) come from the issue text; nothing here
  could re-observe them. They are stated as reported.
- "Checked" notes use the audit date, 2026-10-12, and say whether it was code
  reading or a command.
- Entries still true are left in place, with a "Checked" sentence only where
  something was actually looked at.
- Added three entries, each backed by code or an existing section of the
  document: first boot needs a person, boot start unchecked, native Windows
  unsupported (folded into the Windows entry).

## Follow-ups

- The prerequisites table and `xxd` apt line in section 1, and the locale
  paragraph, describe test failures that #57 removed (`xxd` is no longer
  used under `packages/base/test` or `bin`). Needs its own check before edit.
- The private-repo `gh auth login` paragraph in section 1 can go now the
  repo is public.
- Tier table anchors at the top of INSTALL.md (`#1-try-it` etc.) do not match
  the real headings.

## Review feedback

(none yet)
