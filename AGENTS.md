# inkie-deck

A web control plane for a fleet of AI agents, copied in from the working
platform and cleaned.

This file is the runtime instruction file for AI coding agents. It is a pointer,
not a second rulebook: the contributing rules live in
[CONTRIBUTING.md](CONTRIBUTING.md), and the full workflow lives in
[DEVELOPMENT.md](DEVELOPMENT.md). Read both before your first change. Keeping
the rules in one place is deliberate, so nothing here can drift out of step with
what the other runtimes read.

If you are starting work on an issue, the `start-issue` skill does the
mechanical part: it creates the branch and the SPEC skeleton for you. See
[.agents/skills/start-issue/SKILL.md](.agents/skills/start-issue/SKILL.md).

For setting up a machine and running the checks, see [README.md](README.md)
("Development") and [INSTALL.md](INSTALL.md).

## House rules for agents

- Specs live in the repo. Every ticket (GitHub issue) gets a folder
  `.specs/<issue-number>-<slug>/` holding its SPEC.md, ISSUE-TEXT.md if used,
  and any design notes, in the same pull request as the code. Never keep a spec
  only in a chat, a ticket comment or a wiki. See
  [DEVELOPMENT.md](DEVELOPMENT.md) section 2.
- No internal material (names, hosts, paths, ticket ids, addresses) may enter
  the repository. `pnpm check:leaks` enforces it; read the rule comments before
  extending the denylist.
- ASCII only, no em-dashes or en-dashes anywhere in the tree. This is not style:
  U+2014 is the field separator in the message protocol, so a literal one in a
  file is a parsing hazard. `pnpm check:dashes` enforces it.
- Sign off every commit (`git commit -s`), as [CONTRIBUTING.md](CONTRIBUTING.md)
  requires; an unsigned commit fails the DCO gate.
- If you are an agent: do not push to `main`, force-push a shared branch, merge
  your own pull request, or create a release unless a maintainer asked you to
  in the issue or pull request.
