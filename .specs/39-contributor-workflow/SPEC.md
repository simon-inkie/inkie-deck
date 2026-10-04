# #39: Contributor workflow: AGENTS.md, DEVELOPMENT.md, .specs/ and a start-issue skill

- Issue: #39
- Branch: 39-contributor-workflow
- Started: 2026-09-27

## TL;DR

Adds a written contributor workflow that works on any coding-agent runtime, not
just one: a `DEVELOPMENT.md` describing the issue, branch, SPEC and review flow,
the `.specs/<issue>-<slug>/SPEC.md` convention, and a `start-issue` skill that
scaffolds the branch and the SPEC skeleton from an issue number. `AGENTS.md` and
`CLAUDE.md` are pointers to [CONTRIBUTING.md](CONTRIBUTING.md), which is the
single source of the contributing rules, the checks and the Developer
Certificate of Origin; they do not restate those rules. The skill lives once in
`.agents/skills/` and is reachable from Claude Code through a symlinked
`.claude/skills/`. A fresh agent on either runtime, asked to "start issue N",
produces the branch and the SPEC skeleton without reading anything outside the
repo.

## Scope

In scope:
- Root `AGENTS.md` and `CLAUDE.md` reduced to pointers to `CONTRIBUTING.md` and
  `DEVELOPMENT.md`; the contributing rules (branch naming, issue-first, DCO)
  stay in one place and are not restated.
- `DEVELOPMENT.md`, adapted from the draft in the issue brief.
- The `.specs/<issue>-<slug>/SPEC.md` convention for non-trivial work,
  documented and scaffolded.
- `.agents/skills/start-issue/SKILL.md` plus `.claude/skills/start-issue` as a
  symlink to it; the skill signs off its first commit and uses the
  `type(scope): summary (#issue)` commit-title style.
- README cross-links so a reader arrives at the workflow from the front door.
- The two small in-repo fixes needed to keep the repo's own gates green with
  this change: the leak-gate rule that would block a `.agents/` path, and the
  `check:dashes` scope. Both are now already on `main`, so this branch does not
  repeat them; the branch is documentation only.

Out of scope (and where it goes instead):
- Mirroring this into the memory-layer repository. Filed as a follow-up issue;
  the issue text says so explicitly.
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

- Mirror `AGENTS.md`, `DEVELOPMENT.md` and the skill into the memory-layer
  repository. Filed as an issue on that repo, linked from here once it exists.

## Log

### 2026-09-27: branch and SPEC skeleton
- What changed: started the branch from `origin/main` and created this
  SPEC.
- Why: every change starts from an issue, and the SPEC is the first commit.
- Supersedes: nothing, additive.
- Commits: (this commit)

### 2026-10-04: rework against CONTRIBUTING.md, with DCO sign-off
- What changed: rebased the branch on `main` (which now carries
  `CONTRIBUTING.md` from #45) and signed off every commit. `AGENTS.md` and
  `CLAUDE.md` are now pure pointers to `CONTRIBUTING.md` and
  `DEVELOPMENT.md`, with the branch-naming and issue-first rules stated in one
  place only (`CONTRIBUTING.md`). Added the Developer Certificate of Origin to
  `DEVELOPMENT.md` and to the `start-issue` skill's commit step
  (`git commit -s`). The skill's first commit is now
  `docs(spec): start #N <slug> (#N)`, matching `CONTRIBUTING.md`'s
  `type(scope): summary (#issue)` convention. The SPEC rule is scoped to
  non-trivial work, matching `CONTRIBUTING.md`.
- Why: model-diverse review found DCO violations, a split source of truth
  between `AGENTS.md` and `CONTRIBUTING.md`, a commit-title conflict in the
  skill, and an unconditional SPEC rule that disagreed with `CONTRIBUTING.md`.
- Supersedes: the "shared rules file" framing of `AGENTS.md` in the 2026-09-27
  entry.
- Commits: (this commit)
