# #220: Allow the public Brain repository through the leak gate

- Issue: #220
- Branch: leak-gate-allow-brain
- Started: 2026-11-19

## TL;DR

The Brain is public, so Deck can name it and link to its repository. The leak
gate permits the two canonical repository URLs, including links to pages
within them, while still denying internal checkout names and the maintainer's
name elsewhere in file content outside the existing licence notice.

## Scope

In scope:
- Allow the public memory-layer name and its canonical GitHub URL, with or
  without `.git`, without changing the existing Deck URL exemption's behaviour.
- Cover the allowed and still-denied cases in the leak gate self-test.
- Name and link the Brain in the README's memory section.

Out of scope:
- Installing or configuring the Brain; Deck's existing setup is unchanged.
- Changing any other leak rule, scan scope or the history cut-off.

## Test plan

- `node scripts/leak-gate.mjs --self-test`: check canonical and deeper links,
  clone commands, memory paths, MCP config and messages, and verify that
  unrelated URLs, bare names and internal names are still denied.
- `node scripts/leak-gate.mjs`, `node scripts/leak-gate.mjs --history` and
  `node scripts/leak-gate.mjs --messages`: check all three scan scopes.
- `pnpm check:leaks`, `pnpm check:boundaries`, `pnpm check:licence`,
  `pnpm -C packages/deck check:dashes` and `git diff --check`.

## Follow-ups

None for this change.

## Log

### 2026-11-19: Allow the public Brain name and repository link
- What changed: Removed the public memory-layer name from the internal repository rule, extended the URL exemption, added regression checks and linked the Brain from the README.
- Why: Deck should be able to point readers to its public memory companion without permitting private checkout names or unrelated URLs.
- Supersedes: The decision in #215 to name the memory project without linking to it.
- Commits: c42986d feat(leak-gate): allow naming and linking the public Brain repo (#220)
