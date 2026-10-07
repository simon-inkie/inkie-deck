# #23: New agents never start on first boot: --resume <name> opens a picker, and the session is never named

- Issue: #23
- Branch: 23-first-boot-agents-bv0u0h
- Started: 2026-10-07

## TL;DR

`boot-agents.sh` launched claude agents with `claude --resume <name> || claude`.
On a new agent `--resume <name>` does not fail; it opens an interactive picker,
so the fallback never runs, and even a fallback session is unnamed until someone
types `/rename`. To be filled in as the fix lands.

## Scope

In scope:
- To be decided.

Out of scope (and where it goes instead):
- To be decided.

## Acceptance

From the issue:
- On a clean machine a newly created agent boots to a ready prompt with its
  name on the prompt border, no `/rename` and no picker.
- A second `boot-agents.sh` run after `tmux kill-server` resumes the same
  session.
- `boot-agents.test.sh` covers both paths plus the missing-transcript case.

## Test plan

To be filled in as the approach settles.

## Follow-ups

None yet.

## Decisions log

### 2026-10-07: branch and SPEC skeleton
- What changed: started the branch from `origin/main` and created this SPEC.
- Why: every change starts from an issue, and the SPEC is the first commit.
  The folder carries the branch name in full, suffix included, because
  DEVELOPMENT.md asks for the branch name as the folder name.
- Supersedes: nothing, additive.
- Commits: (this commit)
