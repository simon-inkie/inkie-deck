# #22: INSTALL.md never tells you to clone the repo

- Issue: #22
- Branch: 22-install-clone-step
- Started: 2026-10-07

## TL;DR

INSTALL.md says you need a git clone but no step makes one. This adds an
explicit `git clone` step at the end of section 1, a note that a private repo
needs `gh auth login`, a narrow leak-gate exemption so the real clone URL can
be written, and an explicit, declared skip of the clone block in the install
rig.

## Scope

In scope:
- Clone block and private-repo note in INSTALL.md.
- Leak-gate exemption for the canonical repo URL only, plus self-test cases.
- Install rig: declare the clone block as deliberately skipped, with a reason.

Out of scope:
- Anything else in INSTALL.md or the rig (see Follow-ups).

## Acceptance

- INSTALL.md has an explicit clone step with the real URL.
- `pnpm check:leaks` and `pnpm check:leaks -- --self-test` pass.
- The rig extracts and runs the clone block, or deliberately skips it with a
  comment saying why. This change skips it (see Decisions log).

## Test plan

- `node scripts/leak-gate.mjs --self-test`: new cases prove the URL is exempt,
  and the name rule still fires on the bare name, on a different URL and on a
  longer owner or repo path that merely starts with the URL.
- `pnpm check:leaks`, `pnpm check:dashes` and the other CI checks.
- `node rig/self-test.mjs`: new case proves a skipped block is accounted for
  and a stale skip is reported. The container rig needs Docker and is not run
  here.

## Decisions log

- Clone block placed at the end of section 1, not a new heading: the rig keys
  runs to heading slugs, so a new section would renumber ids for no gain.
- Exemption is a per-rule `contentExemptPattern` that blanks the exact URL
  (optionally `.git`, followed by a non-name character) before the rule
  runs, so any other occurrence of the name on the same line still fires. It
  applies to content scope only, and only to the first-name rule. The URL is
  assembled from fragments in the gate source, as the gate's other samples are.
- The rig skips the clone block rather than running it: the rig copies the
  working tree into a container that has no network credentials, and the repo
  is private, so a real clone cannot succeed there. Skips are declared in
  `rig/install-plan.mjs` with a reason, and count as claimed in the coverage
  accounting, so a stale skip (block gone from the document) fails the rig.
- The `gh auth login` note is marked for deletion once the repo is public, as
  the issue asks. gh is not added to the prerequisites install line: the note
  only applies to private access, and adding a package there changes tested
  blocks for a temporary need.

## Follow-ups

- None yet.
