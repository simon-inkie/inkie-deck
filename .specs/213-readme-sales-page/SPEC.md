# README sales-style rewrite, name section, screenshots and a short AGENTS.md

- Issue: [#213](https://github.com/simon-inkie/inkie-deck/issues/213)
- Branch: docs/readme-sales-page
- Started: 2026-11-18

## TL;DR

The README opened with a plain description. It now opens by saying what Deck is
and showing it: a pitch paragraph, four screenshots (Needs you queue, an agent
thread with decision and action cards, the review panel with generated images
and code files, and the five-stage project board), a short "The name" section
(all hands on deck, and a deck of cards), and a capabilities list limited to what
the code ships. Everything from "Quick install" down, including the contributing
and rules sections, is unchanged. `AGENTS.md` goes from a pointer to a short
orientation (repo map, how to work, house rules); `CLAUDE.md` gets the matching
one-line tagline.

The screenshots come from richer fictional demo fixtures (a small paper-goods
shop scenario) added under `packages/deck/fixtures/demo-inbox`,
`demo-attachments` and `demo-projects`; `scripts/dev-paths.mjs` seeds them into
the sandbox when present. The existing e2e fixtures are untouched.

## Scope

In scope: README opening and name section, four images in `docs/images/`,
`AGENTS.md`, the `CLAUDE.md` tagline, the demo fixtures and the sandbox seeding.

Out of scope: install and contributing text, any app behaviour, the logo
(pending a pick), and Nudges availability (issue #212).

## Test plan

- `node scripts/leak-gate.mjs`, `git diff --check`, ASCII-only scan, and
  `pnpm -C packages/deck check:dashes` on the branch.
- Full `pnpm test` on the committed tree (the dirty-tree guard fails on an
  uncommitted tree by design).
- Each README claim checked against the code by an independent reviewer; four
  inaccuracies found and fixed (see log).

## Log

- 2026-11-18: README opening, screenshots and AGENTS.md written.
- 2026-11-18: review fixes: dropped an advertised capability that is off on a
  normal install, corrected two script and protocol paths, aligned `CLAUDE.md`.
- 2026-11-18: richer screenshots and demo fixtures added at the maintainer's
  request.
- 2026-11-18: SPEC and issue added after the automated review pointed out their
  absence (retrospective; the work above predates this file).

## Follow-ups

- Add the chosen logo to the README header and favicon once picked.
- On a fresh load the reply box renders oversized until it is re-measured; worth
  its own issue.
