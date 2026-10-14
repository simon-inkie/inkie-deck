# #30: Pre-public leak sweep of comments

- Issue: #30
- Branch: 30-leak-sweep-comments
- Started: 2026-10-11

## TL;DR

The leak gate catches known patterns. This is the human-style read of every code
comment and doc string in `packages/deck` and `packages/base`, looking for
private context the pattern list cannot see: named people, internal review
process, ticket ids, dated incident stories, quotes from the owner and
commentary that only makes sense inside the original organisation. Findings are
rewritten to keep the engineering reason and lose the context, and two classes
that could recur are added to the gate.

## Scope

In scope:
- Comments, doc strings and shell comments in `packages/deck` and `packages/base`.
- Four new gate rules with self-test coverage, including negative samples.
- Three intended user-visible edits, listed under Decisions.

Out of scope (see Follow-ups): runtime defaults, identifiers and fixture
content that look like private naming but change behaviour or tests if renamed.

## Acceptance

- No named person, review-tool citation, internal reviewer credit, internal
  tracker prefix id (the `TASK-`, `FND-`, `CARD-`, `VALID-`, `QUEUE-`,
  `THRD-`, `DETECT-` families) or dated incident label remains in a
  `//`, `*`, `/*` or `{/*` comment. Ids inside ticket-URL parser test data are
  legitimate and stay. Hash comments in shell files were swept but are not
  covered by the gate rule, because a hash at line start is also a markdown
  heading.
- `pnpm check:leaks`, `check:leaks:history` pass; `check:leaks:messages` is
  unchanged by this branch (red on commits already on main).
- `typecheck`, `test`, `check:boundaries`, `check:licence`, `check:dashes` pass.

## Test plan

- Eight read-only reviewers each read a share of the files and reported
  findings; fixes were applied by comment-aware scripts plus hand edits.
- `node scripts/leak-gate.mjs --self-test` proves each new rule fires and that
  the history exemption is narrow.

## Decisions log

- Bulk edits only touch comment text, never code; verified by typecheck and the
  full deck suite on a committed tree.
- Parentheticals that held only attribution (ids, dates, names, review-tool
  citations) were removed; ones with a technical reason lost only the
  attribution.
- Provenance statements already disclosed in the README (the code was extracted
  from another repository) were left in `docs/tooling-review.md`; only
  incidents, quotes and people were removed.
- The two new gate rules are `historyExempt`: the old text lives in published
  blobs, so a history scan would stay red forever. They guard the tree and new
  changes. Rewriting history is a separate call for the maintainer.

- Intended behaviour edits that are not comments: a person's name was removed
  from the default dictation keyterm list in `voice-relay.ts` and `.mjs`; the
  error text in `root.tsx` no longer names internal agents; the web manifest
  description no longer carries a first name. Each is private context in a
  shipped string.
- A fourth runtime-visible edit: the generated crontab header in
  `cron.server.ts` lost a tracker id, and runtime error strings in
  `safe-fs`, `queue`, `avatars`, `inbox` and `start-production` lost ticket and
  requirement ids in parentheses, as did two form and error placeholders
  (`PROJ-123` replaces a tracker-style example). Messages are otherwise
  unchanged.
- Blind spot, accepted: `internal-tracker-prefix-in-comment` matches lines that
  start with a comment marker, so an id on the continuation line of a multi-line
  `{/* ... */}` block that does not start with `*` is not seen. The sweep fixed
  the known ones. Tracking block-comment state across lines would need a
  stateful scanner in a line-based gate; not worth it here.
- Maintainer decision (11 Oct 2026): keep the history as it is and keep
  the new rules `historyExempt`. No history rewrite before going public.
- Refined by the third review: the exemption is bounded to legacy blobs, i.e.
  blobs reachable from the fixed cut-off commit `e398eb22` (main when the rules
  were added). A blob introduced after it is scanned with every rule. A missing
  cut-off (shallow clone) fails the scan loudly. The self-test builds a
  throwaway repository and proves a legacy blob is exempt and a newer one is
  not. This branch is squashed to one commit so no intermediate blob from the
  sweep itself sits outside the cut-off.
- The new rules do not set `messageExempt`, so they also gate commit messages.
  That is intended.
- (Rule since removed, see the sixth review.) The person rule covered the capitalised and all-caps spellings. Lowercase
  spellings are user ids the instance code keys on, so they stay (follow-up).

## Follow-ups

- The default directory name for the live agent home appears in code defaults,
  env examples and tests. Renaming it changes runtime defaults, so it was left.
- `TASK-n` ids remain inside test fixtures and string literals; they need a
  rename with their tests rather than a comment edit.
- Demo fixtures using a default user id and a small-business theme (ad spend,
  supplier portal) may read as real. Owner to confirm or neutralise.
- Hardcoded second-user option in `projects.tsx` and `MC_USER=robin` in one e2e
  file.
- The in-tree allowlists of files in flight in four test files describe past
  work; replace with a plain git-clean baseline check.

## Review feedback

Opus review of PR 63, read-only: approve with changes, no blockers.

- Should-fix 1: about 54 comment lines still carried tracker ids. Swept them,
  extended the gate with `internal-tracker-prefix-in-comment`, and narrowed the
  criterion to comments (URL parser test data stays).
- Should-fix 2: three behaviour edits in a comment-only PR. Recorded above and
  in the PR description as intended.
- Should-fix 3: stale keyterm comment in `voice-relay`. Fixed.
- Should-fix 4: review-tool regex gaps and no rule for reviewer credits.
  Widened `review-tool-citation` (space, `MR #`, `MR!`) and added
  `internal-reviewer-fold-citation`. A bare bang number is not covered: too
  many legitimate uses.
- Nits: neutral name in the projects test instead of a lowercased one; negative
  self-test samples per new rule; message scope confirmed intended; all-caps
  person spellings added.

Second Opus review at ceb41e6: changes needed (minor).

- Four ids on continuation lines of multi-line JSX comments: swept; the blind
  spot is documented in Decisions.
- The cron header edit was unrecorded: recorded in Decisions and the PR.
- Nits: stray `. */}` fixed; the placeholder and error-string ids (including
  the two tied to a specific ticket) removed; `review-tool-citation` made
  case-sensitive so lowercase `mr #12` no longer fires.
- Remaining ticket ids in e2e test titles and fixtures are out of the narrowed
  criterion and listed under Follow-ups.

Third review at 768404f: merge after fixes.

- `historyExempt` was blind to all future history: now bounded to blobs
  reachable from a fixed cut-off, with a real-repository self-test.
- `review-tool-citation` and `person-first-name-in-prose` were too broad for a
  public repository: narrowed to attribution shapes (tool name plus a finding
  word, a finding word plus a change-request number, a name plus a possessive
  requirement noun or reporting verb, or a credit word plus a name). Negative
  samples added for bare mentions, bare names and a greeting.
- `pane-idle` usage line: the sourcing instruction (`. "$PANE_IDLE_LIB"`) was
  restored. No other leading-dot comment line was altered.
- The `voice-relay` keyterm removal is a deliberate runtime change, listed in
  the PR description. Kept.
- Comments that lost their meaning: repaired the cited ones and swept the
  whole diff for dangling fragments (orphan prepositions, empty parentheses,
  leftover labels such as a bare "amendment:"), restoring the explanation
  minus the attribution.

Fourth Opus review at a534c9f: changes needed.

- Garbled comments: the earlier pattern sweep missed many. Re-read every
  changed comment line in the diff against the base file and repaired about
  600 comments (missing subjects, orphan prepositions and labels, floating
  punctuation, lost technical detail such as which control characters are
  rejected, remaining owner quotes paraphrased, double spaces, lowercase
  starts). Comment text only; no code or test assertion changed.
- `review-tool-citation`: `catch` removed from the second shape (a language
  keyword); negative self-test sample added.
- `--history` scope: "history passes" holds for main plus this PR. A full clone
  with unmerged remote branches reports their pre-sweep blobs, which are past
  the cut-off by design. Stale branches were not deleted (a call for the
  maintainer).
- Tracker ids that remain only inside test titles (describe and it strings) are
  runtime names, not comments, and stay under Follow-ups.

Fifth Opus review at 36122d4: changes needed (minor).

- The fourth-round note "no code or test assertion changed" was wrong.
  Corrected: the sweep did rename test data. Declared here as deliberate:
  `instance.test.ts` and `projects.test.ts` use neutral user ids and display
  names in fixtures and in the values they assert (renamed consistently, tests
  pass); `blocked-on.test.ts`, `derive-needs-you.test.ts` and `activity.test.ts`
  had a person's name in fixture strings replaced with a neutral phrase, with the
  matching assertions updated. Test titles are not renamed: the
  `scroll-follow.test.ts` tracker prefixes are restored, except one reviewer-credit suffix on a title, which the new fold rule rejects and which is dropped; other ids in titles stay under
  Follow-ups.
- Nits fixed: reflow in `stuck-pane-sweep.sh`, a gendered leftover in
  `instance.server.ts`, and the `activity-sweep.sh` wording restored to
  "behavioural difference from the original deployment".
- Follow-up: `check:dashes` reportedly exits 254 on main in the reviewer's
  environment, so it may never have run there; it exits 0 here.

Sixth review at df75826: merge after fixes.

- `person-first-name-in-prose` removed: the two names are the repository's own
  neutral placeholders, so the rule fought the docs convention. The principal's
  name rule (`principal-first-name`) stays. Gate is now 33 rules.
- `review-tool-citation` narrowed again to a finding or fold word, or a review
  tool's name, followed by a change-request number. A plain mention that a
  review tool ran no longer fires; negative samples added.
- `LEGACY_CUTOFF` is pinned by a self-test assertion, so moving it is a
  deliberate edit in two places.
- Comments in `activity.server.ts`, `instance.server.ts` and `batch-durability.ts`
  rewritten to describe generic multi-instance behaviour instead of one
  deployment; "the front" and "real sample of real audio" wording fixed.
- User-visible string changes (error text, generated script header, validation
  example, placeholder, manifest description) are now listed in the PR
  description.

- Merge with main: main was merged into this branch after the host independent
  base tests change (#62) landed. One file conflicted, the inbox push test
  fixtures. Resolved keeping both sides: the byte-escape fixtures from main
  (locale independent) and this PR's neutral wording for the comments and
  sample text. The other overlapping files merged cleanly. No test was
  weakened, skipped or removed, and the leak gate cut-off is unchanged.
