# README story: every harness, the overload story and the memory pairing

- Issue: #215
- Branch: docs/readme-story
- Started: 2026-11-18

## TL;DR

The README top read like documentation and missed the two main selling points.
It now opens with "one deck for every harness and every model" and a short
hook from the maintainer's agentic cognitive overload story, then runs as short
benefit-led sections: cards that bring decisions to you, harness support with
a plain "where it is today" table, seeing agents' work, the project board, not
just for code, built in daily use, the memory pairing with the brain, the video
under "Why I built it" as a clickable thumbnail, and a shorter name section.
Everything from "Quick install" down is byte-for-byte unchanged.

## Scope

In scope: README content above "Quick install", and this SPEC.

Out of scope: install, contributing, rules and licence sections, `AGENTS.md`,
any app behaviour, Nudges availability, the logo.

## Truth checks

- Harness table matches INSTALL.md and the README install note: Claude Code has
  setup, scaffold and persona verification; Codex and Antigravity get launch
  and inbox delivery; persona wiring for both is #214.
- ACP is described as groundwork: the merged client (#154) is fixture-only with
  no production route.
- Brain claims (survives compaction, semantic recall, per-agent silos with
  scoped recall, shared vault, filesystem-first) checked against the public
  brain README and architecture doc. Deck's quick setup does not install it;
  the scaffold can wire a built checkout (#21), so the README says "pairs with".
- Plugins are described as coming, not available.

## Test plan

- `node scripts/leak-gate.mjs`, `git diff --check`, ASCII-only scan of README
  and this SPEC, and `pnpm -C packages/deck check:dashes`.
- Diff of everything from "Quick install" down against `origin/main`: empty.

## Log

- 2026-11-18: README top rewritten as a sales page at the maintainer's request.
- 2026-11-18: the leak gate denies the memory project's repository name and the
  maintainer's name in file content, so the README names "the brain" without a
  link and the video caption carries the title only. Linking it needs a
  maintainer decision on a narrow gate exemption.

## Follow-ups

- Update the harness table when #214 lands.
- Add the logo to the header once picked.
