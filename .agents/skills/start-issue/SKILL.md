---
name: start-issue
description: Start work on a GitHub issue in this repository. Use when the user says "start issue N", "pick up issue N", "start #N", or asks to begin a new piece of work that needs an issue, a branch and a SPEC. Creates the branch and the .specs/<issue>-<slug>/SPEC.md skeleton, pre-filled from the issue, and commits it signed off as the branch's first commit.
---

# start-issue

Creates the branch and the SPEC skeleton for one GitHub issue, so the first
commit on a branch is the SPEC rather than the code. The convention this
implements is in [DEVELOPMENT.md](../../DEVELOPMENT.md) at the repository root;
read that, and [CONTRIBUTING.md](../../CONTRIBUTING.md), if you have not.

## What it produces

For issue number `N` with title `T`:

- A branch off an up-to-date `origin/main`, named `N-<slug>`, where `<slug>`
  is the issue title lowercased, with anything that is not a letter or digit
  replaced by a hyphen, collapsed and trimmed of leading and trailing hyphens,
  truncated to keep the whole branch name under about 60 characters.
- `.specs/N-<slug>/SPEC.md`, filled from the template below with the issue
  number, title and link.
- One signed-off commit on the new branch:
  `docs(spec): start #N <slug> (#N)`.

It does not write any code, does not push, and does not open the pull request.
Those are yours, and the SPEC's Log records when they happen.

## How to run it

The mechanical steps, in order:

1. Check the working tree is clean (`git status --porcelain` is empty). If it
   is not, stop and tell the user; starting a branch on top of uncommitted work
   mixes two changes into one review.
2. Read the issue with the GitHub CLI, so the SPEC carries the real title:

   ```sh
   gh issue view <N> --json number,title,body
   ```

   If `gh` is not available or not authenticated, ask the user for the issue
   title and continue; the SPEC still needs one.
3. Fetch and branch:

   ```sh
   git fetch origin main
   git switch -c <N>-<slug> origin/main
   ```

4. Create the folder and the SPEC:

   ```sh
   mkdir -p .specs/<N>-<slug>
   ```

   Write `.specs/<N>-<slug>/SPEC.md` from the template below, substituting the
   issue number, title and link. Leave the sections that only the work can fill
   in (Scope, Test plan, Follow-ups) as the skeleton text plus a single
   `- To be decided.` line, or fill them from the issue body if it already
   states scope and acceptance criteria clearly.
5. Commit:

   ```sh
   git add .specs/<N>-<slug>/SPEC.md
   git commit -s -m "docs(spec): start #<N> <slug> (#<N>)"
   ```

   The `-s` adds the `Signed-off-by:` trailer that
   [CONTRIBUTING.md](../../CONTRIBUTING.md) requires of every commit (the
   Developer Certificate of Origin). Do not omit it; an unsigned commit fails
   the DCO gate.

6. Tell the user the branch name and the SPEC path, and that the next step is
   to fill in Scope and Test plan as the approach settles, in the same commits
   as the code.

## SPEC template

```markdown
# #<N>: <title>

- Issue: #<N>
- Branch: <N>-<slug>
- Started: <YYYY-MM-DD>

## TL;DR
One or two sentences: what is changing and why. This becomes the pull request
description, so keep it true as the work moves.

## Scope
In scope:
- To be decided.

Out of scope (and where it goes instead):
- To be decided.

## Test plan
To be filled in as the approach settles: the automated tests added or changed,
and any manual check with the exact command.

## Follow-ups
Anything found but deliberately not done here, each with an issue link once
filed.

## Log

### <YYYY-MM-DD>: branch and SPEC skeleton
- What changed: started the branch from `origin/main` and created this SPEC.
- Why: every change starts from an issue, and the SPEC is the first commit.
- Supersedes: nothing, additive.
- Commits: (this commit)
```

## Notes

- If a branch named `<N>-<slug>` already exists locally or on `origin`, do not
  create a new one. Say so, and offer to check it out and read its SPEC, which
  is the "picking up someone else's work" path in DEVELOPMENT.md section 6.
- If a SPEC already exists for this issue on another branch, say so rather than
  creating a second one; one issue has one SPEC.
- The SPEC is public text and goes through the same leak gate and dash check as
  the code. Link issues by number (`#<N>`), and keep the file ASCII.
