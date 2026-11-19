# #242: Clarify Deck's first impression

- Issue: https://github.com/simon-inkie/inkie-deck/issues/242
- Branch: `first-impression-fixes`
- Started: 2026-11-19

## TL;DR
Make Deck's authentication boundary visible up front and describe the harnesses
that the repository actually supports. Replace legacy product wording without
changing behaviour or compatibility identifiers.
Also fix nested links in the home page Needs you rows, and make the demo and
public repository install guidance clear.

## Scope
In scope:
- README and install guidance for loopback and external access control.
- README claims about CLI harnesses and the experimental ACP client.
- Legacy shorthand and tailnet-only wording in copy, comments and matching tests.
- Valid, independently usable row and ticket links in the Needs you queue.

Out of scope:
- Authentication, runtime wiring, compatibility identifiers, artwork and
  unrelated cold-read findings.

## Test plan
- Run the affected Vitest tests without live agents or listening ports.
- Run `pnpm typecheck`, `pnpm check:boundaries`, `pnpm check:licence`,
  `pnpm check:lib-version`, the direct dash scan and `git diff --check`.
- Run the leak gate, supplying an explicit file list if automatic discovery fails.

## Follow-ups
None.

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

### 2026-11-19: Pick up fresh-clone findings
- What changed: extending the existing branch with a focused Needs you link fix,
  a regression test and Quick install documentation corrections.
- Why: the row nests a ticket anchor inside its thread link, causing invalid
  markup and hydration mismatches. The demo path and public clone instructions
  also need to be clear to new readers.
- Supersedes: the copy-only scope above; this also fixes row markup.
- Commits: pending

### 2026-11-19: Fix row links and public install guidance
- What changed: replaced the wrapping row anchor with a covering native link
  beside the ticket anchor, preserving layout, independent navigation and
  keyboard access. Added a rendered-row regression test. Quick install now
  offers the fixture demo without an AI CLI, repeats the access-control warning
  with the existing install anchor, and distinguishes live-agent prerequisites.
  Removed the obsolete private-repository sign-in paragraph.
- Why: valid sibling links avoid the hydration mismatch while retaining native
  link behaviour. New readers can try Deck without configuring an agent or
  signing in to clone a public repository. The remaining private wording in
  the searched documentation describes file permissions and implementation
  details, not repository visibility.
- Validation: all 52 affected tests passed, along with typecheck, boundaries,
  licence, library-version, direct dash, ASCII and whitespace checks. The
  working-tree leak scan passed. History and commit-message leak scans failed
  on existing reachable history; no Git history was changed by this work.
- Supersedes: nothing, additive.
- Commits: pending
