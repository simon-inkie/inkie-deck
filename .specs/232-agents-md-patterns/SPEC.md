# #232: Point AGENTS.md to testing, eval and UI patterns

- Issue: [#232](https://github.com/simon-inkie/inkie-deck/issues/232)
- Branch: `agents-md-patterns`
- Started: 2026-11-19

## TL;DR

Add a short Patterns and tests section to `AGENTS.md` so agents can find the
testing, proposed eval and UI guidance. Link to the existing guides rather
than restating procedures.

## Scope

In scope:
- Summarise test priorities, safe shell and Nudges tests, the proposed eval
  workflow and reuse of existing UI components and theme tokens.
- Add both guides to the opening pointers in `AGENTS.md`.

Out of scope:
- Changes to the guides, application code or test tooling.
- Running live agents, starting servers or using the network.

## Test plan

- Verify each summary against the guides and the repository's tests and UI.
- Run `COREPACK_ENABLE_NETWORK=0 COREPACK_DEFAULT_TO_LATEST=0 pnpm check:leaks`
  and `node scripts/leak-gate.mjs`.
- Run the direct dash scan and expect no matches:
  `rg --hidden --pcre2 -n '[\x{2014}\x{2013}]' --glob '!node_modules' --glob '!build' --glob '!.git' --glob '!.react-router'`.
- Run `git diff --check` and
  `git diff --no-index --check /dev/null .specs/232-agents-md-patterns/SPEC.md`.
- Check both edited files for non-ASCII characters and verify the guide links.
  No automated tests added for this documentation-only change.

## Follow-ups

None.

## Log

### 2026-11-19: Link the existing patterns from the orientation
- What changed: Added a compact section and links to both guides in `AGENTS.md`.
- Why: Agents need a quick pointer to safe tests and UI conventions without
  mistaking the proposed eval workflow for existing tooling.
- Supersedes: nothing, additive
- Commits: pending

### 2026-11-19: Check the documentation offline
- What changed: Verified the links and guidance, and ran the direct dash scan,
  ASCII scan and diff whitespace checks. They reported no issues.
- Why: Both leak gate commands were blocked by `spawnSync git EPERM` in the
  sandbox. The leak gate still needs a run in an environment that permits it.
- Supersedes: nothing, additive
- Commits: pending
