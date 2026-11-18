# inkie-deck

A local-first control room for a team of AI agents: a chat-style inbox, decision
and action cards, projects and drafts, backed by a file-based message protocol.
This file is the short orientation for AI coding agents. The rules live in one
place each, so read these before your first change:
[CONTRIBUTING.md](CONTRIBUTING.md) (rules), [DEVELOPMENT.md](DEVELOPMENT.md)
(workflow), [README.md](README.md) and [INSTALL.md](INSTALL.md) (setup).

## Map

- `packages/deck`: the React Router web app, with vitest unit tests and
  Playwright journeys.
- `packages/base`: the agent protocol (`packages/base/docs/protocol.md`), persona templates and
  the `inbox` CLI. It never imports from `packages/deck`; `pnpm check:boundaries`
  enforces that.
- `.specs/<issue-number>-<slug>/`: one SPEC per ticket, written first and updated
  as the work happens.
- `scripts/`: the root gates (leak, licence, lib-version) and `setup.sh`. The dash check is `packages/deck/scripts/check-dashes.mjs`.

## How to work

1. Start from a GitHub issue. `start-issue`
   ([skill](.agents/skills/start-issue/SKILL.md)) creates the branch and the SPEC
   skeleton.
2. Write or update the SPEC in the same pull request as the code. Never keep a
   spec only in a chat, a ticket comment or a wiki.
3. Keep changes small and focused, follow the patterns in the files you touch, and
   add tests for core behaviour and for anything that can lose data or leak.
4. Before pushing, run the checks listed in CONTRIBUTING.md ("Checks a pull
   request must pass"). Commit first: two suites assert the tree is clean.
5. Branch off `main`, keep each pull request to one change, and title commits
   `type(scope): summary (#issue)`. Never push to `main`.

## House rules

- No internal material (names, hosts, paths, ticket ids, addresses) in the
  repository. `pnpm check:leaks` enforces it.
- ASCII only, no em-dashes or en-dashes anywhere in the tree: U+2014 is the field
  separator in the message protocol. `pnpm -C packages/deck check:dashes` enforces it.
- Sign off every commit (`git commit -s`); an unsigned commit fails the DCO gate.
- Agents: do not push to `main`, force-push a shared branch, merge your own pull
  request, or create a release unless a maintainer asked you to in the issue or
  pull request.
