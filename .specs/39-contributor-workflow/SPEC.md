# #39: Contributor workflow: AGENTS.md, DEVELOPMENT.md, .specs/ and a start-issue skill

- Issue: https://github.com/simon-inkie/inkie-deck/issues/39
- Branch: 39-contributor-workflow
- Started: 2026-09-27

## TL;DR

Adds a written contributor workflow that works on any coding-agent runtime, not
just one: a root `AGENTS.md` that carries the shared rules (with `CLAUDE.md`
pointing at it), a `DEVELOPMENT.md` describing the issue, branch, SPEC and
review flow, the `.specs/<issue>-<slug>/SPEC.md` convention, and a `start-issue`
skill that scaffolds the branch and the SPEC skeleton from an issue number. The
skill lives once in `.agents/skills/` and is reachable from Claude Code through
a symlinked `.claude/skills/`. A fresh agent on either runtime, asked to "start
issue N", produces the branch and the SPEC skeleton without reading anything
outside the repo.

## Scope

In scope:
- Root `AGENTS.md` (shared rules file) and `CLAUDE.md` reduced to a pointer.
- `DEVELOPMENT.md`, adapted from the draft in the issue brief.
- The `.specs/<issue>-<slug>/SPEC.md` convention, documented and scaffolded.
- `.agents/skills/start-issue/SKILL.md` plus `.claude/skills/start-issue` as a
  symlink to it.
- README cross-links so a reader arrives at the workflow from the front door.
- The two small in-repo fixes needed to keep the repo's own gates green with
  this change: the leak-gate rule that would block a `.agents/` path, and the
  `check:dashes` scope (it currently scans ignored directories, so a `.git`
  symlink under `node_modules` can fail the gate for unrelated reasons).

Out of scope (and where it goes instead):
- Mirroring this into the memory-layer repo (`inkie-the-brain`). Filed as a
  follow-up issue; the issue text says so explicitly.
- Any change to the install path, the brain integration (#21) or the other
  install-test findings.
- Changing `bin/` behaviour. This issue is the workflow, not the tooling.

## Test plan

- The repository's own gates, run on a clean tree:
  `pnpm install`, `pnpm typecheck`, `pnpm test`, `pnpm check:boundaries`,
  `pnpm check:leaks`, `pnpm check:licence`, and `pnpm check:dashes` in
  `packages/deck`.
- Acceptance check by hand: in a clone of the branch, with no other context,
  follow `.agents/skills/start-issue/SKILL.md` for a sample issue number and
  confirm the branch name, the `.specs/` folder and a filled SPEC skeleton come
  out, with no reference to anything outside the repo.
- Confirm `CLAUDE.md` and `AGENTS.md` cannot drift: the pointer is checked by a
  test rather than by convention (see Log).

## Follow-ups

- Mirror `AGENTS.md`, `DEVELOPMENT.md` and the skill into `inkie-the-brain`.
  Filed as an issue on that repo, linked from here once it exists.

## Log

### 2026-09-27: branch and SPEC skeleton
- What changed: started the branch from `origin/main` (d1767a2) and created this
  SPEC.
- Why: every change starts from an issue, and the SPEC is the first commit.
- Supersedes: nothing, additive.
- Commits: (this commit)
