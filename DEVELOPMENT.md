# Development workflow

How changes get made in this repository. It applies to everyone: human
contributors, and AI coding agents of any runtime. If you are an agent, read
this file in full before your first commit; your tool's own instructions file
(`AGENTS.md`, `CLAUDE.md` or similar) only points here.

[CONTRIBUTING.md](CONTRIBUTING.md) is the entry point and the single source for
the branch-naming and issue-first rules, the required check suites, and the
Developer Certificate of Origin. This file does not restate those; it describes
the workflow around them (the SPEC, review and handover).

For setting up a machine and running the checks, see [README.md](README.md)
("Development") and [INSTALL.md](INSTALL.md).

## The short version

1. Start from an issue, on a branch: see
   [CONTRIBUTING.md](CONTRIBUTING.md) for those two rules.
2. Non-trivial work keeps a SPEC at `.specs/<issue>-<slug>/SPEC.md`. The
   branch's first commit creates it, using
   the branch name as the folder name.
3. Keep the SPEC current in the same commits as the code: decisions, dead
   ends, and why.
4. Open a pull request whose description comes from the SPEC's TL;DR. CI and a
   review must pass before merge.
5. Anyone picking the work up starts by reading the SPEC.

`start-issue` does steps 1 to 2 for you: see
[.agents/skills/start-issue/SKILL.md](.agents/skills/start-issue/SKILL.md).

## 1. Start from an issue, on a branch

An issue comes before the work. Search open and closed issues first; if one
exists, comment that you are taking it, or ask the assignee. If none exists,
open one: what is wrong or missing, how you saw it, and what "done" looks like.
Keep one issue to one coherent fix; split anything that would make a reviewer
read two unrelated changes.

The naming rule, the kebab-case shape and the "no issue, no branch" line are in
[CONTRIBUTING.md](CONTRIBUTING.md). The mechanics, once you have the number:

```sh
git fetch origin
git switch -c <issue>-<slug> origin/main
```

Trivial changes (a typo, a one-line config tweak, a broken link) can go
straight to a pull request without an issue or a SPEC. If you are unsure
whether something is trivial, it is not.

## 2. The SPEC folder

The first commit on the branch creates:

```
.specs/<issue>-<slug>/SPEC.md
```

using the branch name as the folder name. Anything else the work needs
(notes, captured output, small diagrams) can live in the same folder. The
folder is committed and merged with the code; it is the permanent record of
why the change looks the way it does.

Before an issue number exists the folder is `.specs/<slug>/`. The moment the
issue is created, rename it with `git mv` and record the number in the SPEC
header. A spec is never kept only outside the repository (in a chat, a ticket
comment or a wiki), and external maintainers follow the same rule.

A starting SPEC can be ten lines. Use this skeleton:

```markdown
# #<issue>: <issue title>

- Issue: <link>
- Branch: <issue>-<slug>
- Started: <YYYY-MM-DD>

## TL;DR
Two or three sentences: what is changing and why. This becomes the pull
request description, so keep it true as the work moves.

## Scope
In scope:
- ...
Out of scope (and where it goes instead):
- ...

## Test plan
To be filled in as the approach settles. What proves this works: automated
tests added or changed, and any manual check with the exact command.

## Follow-ups
Anything found but deliberately not done here, each with an issue link once
filed.

## Log
(append-only; see below)
```

The SPEC is scanned by the same repository checks as everything else (leak
gate, dash check, ASCII only). Write it as public text, and link issues by
number (`#39`) rather than by URL if the URL would carry anything private.

## 3. The SPEC is a running commentary

The SPEC records the work as it happened, not a tidy summary written at the
end. A retrospective SPEC loses exactly what the next person needs: the pivots,
the approaches that failed and why, and the constraints that were only
discovered halfway through.

Rules:

- **Update it in the same commit as the code it describes.** A commit that
  changes the approach also changes the SPEC. No end-of-branch "update docs"
  commit.
- **Append to the Log; do not rewrite history.** Earlier entries stay as they
  were written. If a decision is reversed, add an entry that says so and
  names what it supersedes. You may keep TL;DR, Scope and Test plan current,
  because those describe the present state; the Log carries how it got there.
- **Record dead ends.** "Tried X, failed because Y" saves the next person the
  same afternoon.
- **Record review outcomes.** For each review finding: fixed (which commit),
  declined (why), or deferred (to which issue).
- **Put anything that is live and wrong where a reader will meet it.** If you
  ship a known limitation or defer a known bug, state it in the TL;DR, in the
  pull request description, and in a comment next to the code. A note at the
  bottom of the Log is not enough on its own.
- **Comments state what the code guarantees, not what you meant it to do.** If
  a comment claims a property of a language or library feature, check that the
  feature really has it.
- **Do not invent entries.** If you add a missed entry later, date it from
  `git log` and mark it `(retrospective)`. Leave a gap rather than guess.

Log entry format:

```markdown
### <YYYY-MM-DD>: <short description>
- What changed: <one or two sentences>
- Why: <decision, discovered constraint, review finding, dead end>
- Supersedes: <earlier entry or section, or "nothing, additive">
- Commits: <short sha> <subject>
```

What earns an entry: a commit that moves the work forward, a change of scope
or approach, a review finding and how it was resolved, a follow-up filed.
What does not: typo and formatting fixes.

## 4. Pull requests and review

Before opening:

- Merge or rebase the latest `main` into your branch, so the review diff is
  only your change.
- Sign off every commit (`git commit -s`), as
  [CONTRIBUTING.md](CONTRIBUTING.md) requires. To add the trailer to commits
  you have already made, run `git rebase --signoff main`.
- Run the full check list locally from a clean tree (commit or stash first;
  some suites report the state of the tree, not your change):

  ```sh
  pnpm install
  pnpm typecheck
  pnpm test
  pnpm check:boundaries
  pnpm check:leaks
  pnpm check:licence
  pnpm check:lib-version
  ```

  The dash check lives in the deck package rather than the root, so run it
  from there: `pnpm -C packages/deck check:dashes`.

- Make sure the SPEC's TL;DR, Test plan and Follow-ups are current.

Opening:

- Title: a short imperative sentence, with the issue number, e.g.
  `fix: resume agents by pinned session id (#42)`.
- Description: the SPEC's TL;DR, a link to the SPEC file, the test plan, and
  `Closes #<issue>`. Call out anything live and wrong (section 4) at the top.
- One pull request per issue, scoped to one change. Large or unrelated
  changes go in separate pull requests; if one is growing past reviewable,
  split it and say so in the SPEC.

Review:

- CI must be green. CI runs the same list as above, so a green local run and a
  green CI mean the same thing.
- At least one approving review from someone other than the author. An agent
  cannot approve its own work, and a second agent run by the same person
  reviewing the same diff is not independent review; give the reviewer the
  change and the issue, not your justification for it.
- Reviewers look at scope, intent and design as well as line-level
  correctness: does the change do what the issue asked, and nothing else?
- Resolve every review thread with a reply: fixed in a named commit, declined
  with a reason, or deferred to a named issue. Record the same in the SPEC Log.
- Squash or merge per the maintainers' preference; do not force-push over
  commits a reviewer has already commented on without saying so.

After merge: file any follow-ups listed in the SPEC as issues and link them
from it.

## 5. Picking up someone else's work

The SPEC is the handover. Whether you are a new contributor, the same person a
week later, or an agent starting a fresh session, begin here:

1. Read the issue, then the whole SPEC, top to bottom, including the Log.
2. Compare the SPEC against the branch: `git log --oneline origin/main..HEAD`
   and `git diff origin/main...HEAD`. The last Log entry should match the last
   meaningful commit. If there are commits the Log does not explain, the SPEC
   is stale; find out what they did before building on them.
3. Check the pull request, if one is open, for unresolved review threads.
   Read all of them, not just the most recent.
4. Run the check list on a clean tree to learn the true starting state rather
   than assuming the last session left it green.
5. Before you change anything, add a Log entry saying you have picked the work
   up, what state you found it in, and what you intend to do next.
6. If you are taking over from someone who may still be active, say so on the
   issue first.

If you stop partway, leave the SPEC in a state the next person can act on: the
last Log entry says what is done, what is in progress, and the next concrete
step.

## Notes for AI agents

- This file is the workflow; your runtime's instructions file is only a
  pointer to it. If the two disagree, this file wins and the pointer should be
  fixed.
- Sign off every commit with `git commit -s`; the Developer Certificate of
  Origin is a condition of contributing, and
  [CONTRIBUTING.md](CONTRIBUTING.md) has the full text.
- Do not push to `main`, force-push shared branches, merge your own pull
  request, or create releases unless a maintainer has asked you to in the
  issue or pull request.
- Keep the SPEC current as you go even within a single session; a session can
  end at any point, and the SPEC is all the next one gets.
