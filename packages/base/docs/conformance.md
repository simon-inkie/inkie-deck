# Conformance: how two implementations of one format are kept honest

**Status:** active. The corpus is `conformance/corpus.json`; the runners are
`conformance/run_cli.py` and `packages/deck/test/blocks/conformance.test.ts`.

## The problem this exists for

This repository contains two readers of the on-disk format specified in
[protocol.md](protocol.md):

- `bin/inbox`, a python3 CLI, which is what an agent in a terminal uses
- `packages/deck`, a TypeScript web application, which is what a human uses

That is a genuine risk and it was once used as an argument for deleting the
CLI. The argument was wrong about the requirement (an agent in a tmux pane has
no browser, so the application gives it no way to send a message) but it was
not wrong about the risk. Every tolerance or fix added to one reader and not
the other becomes a silent interoperability bug, and silent is the operative
word: both sides keep working, on their own, while disagreeing about what a
file means.

The two are in different languages. There is no parser they can share, no
common test helper, nothing that can be factored out. So the only thing that
can hold them together is **shared data**.

## The shape

One corpus of inputs and expected outputs, `conformance/corpus.json`, written
against the specification. Each implementation has a thin adapter in its own
language that projects its parse onto a canonical block shape, and nothing else
in common.

```
                     docs/protocol.md          (normative prose)
                            |
                  conformance/corpus.json      (normative, executable)
                       /            \
          run_cli.py                 conformance.test.ts
              |                              |
          bin/inbox                   packages/deck/app/lib/blocks
```

Three properties matter, and each is a decision rather than an accident.

**The corpus is keyed to the SPECIFICATION, not to agreement between the two
implementations.** A check of the form "do the two produce the same answer"
would have passed on the day it was written and certified a shared bug: three
of the deviations recorded today are the *same defect in both readers*. They
agree with each other and disagree with the spec. A corpus that only compared
them to each other would have been green over that, which is worse than having
no check, because it would carry the authority of a passing test.

**The corpus is data, and the corpus travels with the spec.** It sits in
`packages/base` beside `protocol.md`, and it is published through that
package's `exports` so the application imports it by package name rather than
by relative path. `pnpm check:boundaries` therefore sees a legal
application-depends-on-base edge, and the corpus keeps working if `base` is
ever spun out into its own repository, which is a property that package is
required to preserve.

**The compared value is `bodyRaw`, not each implementation's display body.**
The two clean bodies for presentation in ways that legitimately differ: the CLI
strips every standalone `---` line, while the application preserves
body-internal ones (it lost message content twice by doing otherwise) and lifts
a YAML metadata region out of the body. Comparing display bodies would bury
real boundary drift under differences that are intended. `bodyRaw` is
everything after the header line up to the start of the next block, trimmed. It
is derivable from both without touching either's cleaning, and it is precisely
the value that moves when block boundaries drift.

## Deviations, and why a waiver has to be able to expire

Both implementations deviate from the specification today. If the corpus simply
failed, it would stay red, and a permanently red check is one that everyone
learns to ignore.

So a case may carry a `deviations` record, per implementation:

```json
{
  "id": "unparseable-timestamp-still-a-block",
  "expect":     [ ... what the protocol requires ... ],
  "deviations": {
    "deck": { "reason": "...", "expect": [ ... what it actually does ... ] }
  }
}
```

A deviation is **a defect with a name, not a permission slip.** The runner
makes two assertions about it, and the second is the one that matters:

1. the implementation still produces **exactly** the recorded wrong answer, so
   a deviation that changes shape fails, because its description is now wrong
   too; and
2. the implementation does **not** produce the right answer, so a deviation
   that gets **fixed** also fails, with a message telling you to delete the
   record.

Rule 2 is the whole design. Without it, a waiver outlives the defect it
documents, the file fills with stale entries nobody dares remove, and the suite
degrades into a list of things that were once wrong. With it, the deviation
list can only shrink deliberately, and it is a true statement about the tree at
every commit. `expect` is normative and is never edited to match an
implementation; that edit is the exact failure this mechanism exists to
prevent.

## The three ways this can fail

Demonstrated by deliberate mutation, because a check that has never been seen
to go red has not been shown to work:

| Change | Result |
|---|---|
| A conforming case drifts (the `IGNORECASE` flag dropped from the CLI's header grammar) | `FAIL ... does not match the protocol`, exit 1 |
| A recorded deviation is fixed (block boundaries corrected to the spec) | `FAIL ... STALE DEVIATION RECORD`, exit 1, naming the record to delete |
| A recorded deviation changes shape | `FAIL ... no longer matches its own record`, exit 1 |

Both runners also assert their own denominator, because every predicate is true
of the empty set and a corpus that fails to load would make every case
vacuously pass.

## What the corpus does not cover

Read-side projection only. The write-side properties in `protocol.md` section
10 (the four-byte in-place status patch, the cross-process lock, symlink
preservation, concurrent appends from real processes) are mutations rather than
projections, and they stay in each implementation's own suite:
`test/inbox.test.sh` for the CLI, the application's own tests for the
application. That is a real limit and worth stating: the corpus catches
disagreement about what a file *means*, not disagreement about how it is
*changed*.

## Adding a case

1. Write it against `protocol.md`, citing the section in the `protocol` field
   and explaining in `why` what breaks if the case is not satisfied. The `why`
   is printed on failure and is the first thing the next reader sees.
2. Run both runners. If an implementation fails, that is a finding, not a
   reason to soften the case.
3. Only then decide whether the failure is a defect to fix now or a deviation
   to record. Recording one is a considered choice with a written reason, and
   the reason should say what the fix is.

```bash
python3 packages/base/conformance/run_cli.py          # the CLI
pnpm -C packages/deck test blocks/conformance         # the application
pnpm test                                             # both, via each suite
```

Never write a literal U+2014 into the corpus. The em-dash is a field separator
in this protocol, so a case that needs one uses a `\u2014` JSON escape; the
parsed value is the real character and the file holds only the escape.
