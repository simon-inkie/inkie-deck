# inkie-deck

A web control plane for a fleet of AI agents: inboxes, decision cards, briefs,
projects, tmux-backed agent sessions, and the file-based message protocol that
ties them together.

**To run it, see [INSTALL.md](INSTALL.md)**: three tiers, from a five-minute
sandbox on fixture data through a real production install to live agents in
tmux. Its shell blocks are extracted from the document and executed on every
rig run, so what it tells you to type is what was measured. The rest of this
file is about the repository itself.

## How this repository got its code

Deck's application code was **copied in from the working platform and
cleaned**, not reimplemented. That platform is proven and in daily use;
rewriting it would throw away everything its testing has established and buy
nothing. What got re-authored is only the material that could not be cleaned
economically: fixtures, test data and persona files, which encode specifics of
one deployment rather than the shape of the product.

No git history crosses. The leaks are in commit messages, so the extraction
copies file contents into fresh commits and the old history stays behind. That
is the one part of this with no exceptions.

## Layout

A pnpm workspace with two packages:

- **`packages/base`**: the agent protocol package (`inkie-agents-base`). The
  normative spec of the file-based message protocol (`docs/protocol.md`),
  persona-file templates, a fully worked fictional example agent, and the
  shared multi-agent conventions. Bundled here so Deck's docs and templates
  travel with it, but independently versioned and kept separable so it can
  move to its own repository later.
- **`packages/deck`**: the application package (`inkie-deck`). The React
  Router web application plus its unit suite (vitest) and browser journeys
  (Playwright). It implements the `packages/base` protocol directly; there is
  deliberately no second implementation anywhere in the repository.

## The rules the machines enforce

- `packages/base` never imports from `packages/deck`, and `packages/deck`
  reaches `base` only through its published entry points. Enforced by
  dependency-cruiser (`pnpm check:boundaries`).
- No internal material (names, hosts, paths, tickets, addresses) may enter
  the repository. Enforced by `scripts/leak-gate.mjs` plus gitleaks in CI.
  The gate self-tests: `node scripts/leak-gate.mjs --self-test` proves each
  rule still fires, so a rule that has quietly stopped matching cannot pass
  as a clean scan.
- The `LICENSE` must name a real copyright holder rather than a placeholder.
  Enforced by `scripts/licence-gate.mjs`.

## Development

Node `^22.13.0 || >=24.0.0`, and pnpm. Both current LTS lines, in other words,
and not the odd-numbered ones in between: 23 was never an LTS line and is
already out of support. `pnpm install` refuses to run on anything else and
tells you so, rather than letting you find out later or not at all.

Further prerequisites, all easy to miss because every machine that has run this
so far already had them:

- **git**, and the tree has to be a *clone*. An unpacked release tarball or a
  "Download ZIP" will not do. Two suites shell out to `git status --porcelain`
  to prove that a test has not written into the repository, and
  `scripts/leak-gate.mjs` uses `git ls-files` as its file-selection rule. With
  no `.git` directory the suite reports dozens of failures that have nothing
  to do with the code.
- **ripgrep** (`rg`), used by `check:dashes`.
- **python3**, if you want your agents to talk to each other. The `inbox` CLI in
  `packages/base` is Python. Nothing in the web application needs it, so Deck
  runs fine without it and you will not find out you are missing it until an
  agent tries to reply and cannot. A bare Ubuntu 24.04 image does not have it.
- **xxd**, for the `inbox` suite alone, which compares the bytes of a thread
  file before and after an in-place status patch. On Ubuntu 24.04 it is its own
  package rather than part of `vim-common`, so it is absent by default and the
  suite stops with `xxd: command not found` and no other explanation.
- **a UTF-8 locale**. Not only for the suite: live delivery decides whether an
  agent is busy by reading the spinner and counter glyphs in its terminal pane,
  and in the C locale that classification breaks. Ten of the seventy delivery
  cases fail there, and at runtime the same break is a message that was never
  typed into a pane which was ready for it. A container inherits no locale at
  all, so `LANG=C.UTF-8` belongs in any deployment that is not a desktop.

The test count doubles as a diagnostic here, with git and ripgrep the two that
move it: **1810 passing** means everything above is present, **1806** means
ripgrep is missing, and **1743** means neither ripgrep nor a git repository is.
All three are measured in a container on every rig run rather than remembered;
the numbers in this paragraph were wrong by twenty for two days before anything
asserted them.

One more thing about those two suites, because it looks like your bug and is
not: **they report the state of the tree, not the state of your change.** They
fail on any modification, including the uncommitted edits you are currently
testing. So a run against a dirty tree returns dozens of failures that have
nothing to do with what you wrote. Commit first, or stash, then run the suite.
Two people lost time to this on the same day, each reading it as their own
breakage.

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm check:boundaries
pnpm check:leaks
pnpm check:licence
```

CI runs exactly this list (plus gitleaks), so a green pipeline never claims
more than a green local run.

## Licence

Apache-2.0. See `LICENSE`.
