# #242: Clarify Deck's first impression

- Issue: https://github.com/simon-inkie/inkie-deck/issues/242
- Branch: `first-impression-fixes`
- Started: 2026-11-19

## TL;DR
Make Deck's authentication boundary visible up front and describe the harnesses
that the repository actually supports. Replace legacy product wording without
changing behaviour or compatibility identifiers.

## Scope
In scope:
- README and install guidance for loopback and external access control.
- README claims about CLI harnesses and the experimental ACP client.
- Legacy shorthand and tailnet-only wording in copy, comments and matching tests.

Out of scope:
- Authentication, runtime wiring, compatibility identifiers, artwork and other
  cold-read findings.

## Test plan
- Run the affected Vitest tests without live agents or listening ports.
- Run `pnpm typecheck`, `pnpm check:boundaries`, `pnpm check:licence`,
  `pnpm check:lib-version`, the direct dash scan and `git diff --check`.
- Run the leak gate, supplying an explicit file list if automatic discovery fails.

## Follow-ups
None for this copy-only change.

## Log
### 2026-11-19: Set the copy-only scope
- What changed: documented the deployment boundary, harness claims and legacy copy to update.
- Why: the cold read found that the first screen overstated support and did not explain who could reach Deck. The CLI paths have scaffolds and launchers; ACP has only a test adapter and no production caller.
- Supersedes: nothing, additive.
- Commits: pending

### 2026-11-19: Update and verify the copy
- What changed: aligned the README and install warnings, qualified runtime support,
  and replaced the old wording in the UI, diagnostics and comments.
- Why: make the deployment and support limits clear without changing behaviour.
  All 406 focused tests passed. Typecheck, package boundaries, licence, library
  version, dash and whitespace checks passed. Git discovery in the leak gate
  was blocked by the sandbox; an explicit list of regular files passed.
- Supersedes: nothing, additive.
- Commits: ba0c957 docs: no-auth warning up front, honest breadth wording, drop pre-extraction copy (#242)
