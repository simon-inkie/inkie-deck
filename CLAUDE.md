# inkie-deck

A local-first control room for a team of AI agents.

## Shared rules

This file is a pointer. The repository's contributing rules are in
[CONTRIBUTING.md](CONTRIBUTING.md), the workflow is in
[DEVELOPMENT.md](DEVELOPMENT.md), and the agent runtime file is
[AGENTS.md](AGENTS.md); read all three before your first change. They are the
same files every other coding-agent runtime reads, so there is exactly one copy
of the rules and no chance of drift.

**Specs live in the repo.** Every ticket (GitHub issue) gets a folder
`.specs/<issue-number>-<slug>/` holding its SPEC.md and any design notes, in the
same pull request as the code. Never keep a spec only in a chat, a ticket
comment or a wiki. Detail: [DEVELOPMENT.md](DEVELOPMENT.md) section 2.

The one thing worth repeating here, so a session that reads only this file is
not blind: sign off every commit (`git commit -s`).
