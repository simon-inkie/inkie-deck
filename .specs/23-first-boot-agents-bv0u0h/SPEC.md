# #23: New agents never start on first boot: --resume <name> opens a picker, and the session is never named

- Issue: #23
- Branch: 23-first-boot-agents-bv0u0h
- Started: 2026-10-07

## TL;DR

`boot-agents.sh` and `workspace.sh` launched claude agents with
`claude --resume <name> || claude`. On a new agent `--resume <name>` opens an
interactive picker instead of failing, so the fallback never ran, and a session
started any other way had no name until someone typed `/rename`. Both launchers
now pin each agent's session id in `<agent home>/.session-id`: a first boot
mints an id and runs `claude --session-id <id> -n <name>`, later boots run
`claude --resume <id> -n <name>`, and a pinned session whose transcript is gone
or holds no messages starts a fresh named session instead. An agent with no pin
but a session named by hand is migrated to that session once.

## Scope

In scope:
- `packages/base/bin/claude-session.sh` (new, sourced): the pin, the
  conversation check and the one-off migration.
- `boot-agents.sh` and `workspace.sh`: launch claude through it; stale comments
  replaced.
- `boot-agents.test.sh`: new, resumed, missing-transcript, metadata-only
  transcript, corrupt pin, migration and project-directory cases.
- `packages/base/README.md` and the pane sample in `INSTALL.md`.

Out of scope (and where it goes instead):
- Recovering from a resume that fails for another reason (a corrupt transcript):
  see Follow-ups.
- Codex and other runtimes: unchanged.

## Acceptance

From the issue:
- On a clean machine a newly created agent boots to a ready prompt with its
  name on the prompt border, no `/rename` and no picker.
- A second `boot-agents.sh` run after `tmux kill-server` resumes the same
  session.
- `boot-agents.test.sh` covers both paths plus the missing-transcript case.

## Test plan

Automated: `bash packages/base/test/boot-agents.test.sh` (also run by
`pnpm test` through `shell-suites.test.ts`), cases C1 to C7. They never run
claude: `CLAUDE_CONFIG_DIR` points at a scratch tree and the cases write
transcripts where Claude Code would.

Manual, done once on this branch against a real Claude Code 2.1 in tmux, with a
scratch `AGENTS_HOME` and `CLAUDE_CONFIG_DIR` and `BOOT_STAGGER_SECS=0`:
1. New agent, `bin/boot-agents.sh`: ready prompt, agent name on the prompt
   border, no picker, no `/rename`, `.session-id` written.
2. Sent one message, `tmux kill-server`, booted again: same id, the earlier
   exchange on screen, one transcript file.
3. Transcript left with metadata only, booted again: stderr note, new id,
   fresh named session at a ready prompt.
4. Removed `.session-id`, created a session with `claude -p -n wren` in the
   agent home, booted: that session pinned and resumed.

`workspace.sh` was not run live (it attaches to tmux); it calls the same
function and passes `bash -n`.

## Follow-ups

- A pinned session whose transcript has messages but that `--resume` still
  rejects (corrupt file, incompatible CLI version) leaves a shell in the pane,
  as before this change. Codex has a verify-and-fall-back step for this
  (`codex_verify_resume_or_fallback`); claude does not. Not filed yet.

## Decisions log

### 2026-10-07: branch and SPEC skeleton
- What changed: started the branch from `origin/main` and created this SPEC.
- Why: every change starts from an issue, and the SPEC is the first commit.
  The folder carries the branch name in full, suffix included, because
  DEVELOPMENT.md asks for the branch name as the folder name.
- Supersedes: nothing, additive.
- Commits: 3fa3e90 docs(spec): start #23 first-boot-agents (#23)

### 2026-10-07: pin claude sessions by id in both launchers
- What changed: added `claude-session.sh`, sourced by `boot-agents.sh` and
  `workspace.sh`; the launch line is now `claude --resume <id> -n <name>` or
  `claude --session-id <id> -n <name>`. Tests C1 to C7, README and INSTALL
  updated.
- Why:
  - Pin by id, as the issue proposes. Checked against Claude Code 2.1.292:
    `--session-id` and `-n/--name` exist, `-n` with `--resume <id>` keeps the
    same transcript, and `--resume <unknown id>` exits 1 with "No conversation
    found" rather than opening the picker.
  - `workspace.sh` included: it had the identical launch line and the same bug,
    so leaving it would keep the failure on the other launcher. Shared through
    one sourced file so the two cannot drift.
  - `-n <name>` on every launch, not only the first, so the name on the border
    does not depend on how the session was created.
  - Missing transcript mints a new id rather than reusing the pinned one, so a
    stray file under the old id can never collide with `--session-id`.
  - "Has a conversation", not "file exists": found live that Claude Code
    rewrites a metadata-only transcript when a session is closed, including one
    nobody typed into, and `--resume` on that exits "No conversation found".
    First version checked existence only and left a dead pane in manual step 3.
  - No `|| claude` fallback on the resume: it would also fire whenever a
    resumed session later exits non-zero for any reason, starting a surprise
    fresh session in a live agent's pane. Recorded under Follow-ups instead.
  - Migration matches the latest `customTitle` in each transcript, which is
    what `/rename` and `-n` write, and takes the newest by mtime.
  - Transcript directory derived from the physical path (`pwd -P`), because the
    claude process records its resolved working directory.
- Supersedes: the "To be filled in" TL;DR, Scope and Test plan.
- Commits: e4c3043 fix(base): pin claude agent sessions by id on first boot (#23)

### 2026-10-07: checks before the pull request
- What changed: ran the CONTRIBUTING.md check list. typecheck, boundaries,
  leaks, licence, lib-version and dashes pass; the deck suite passes.
  Dropped a session-link trailer from this branch's commit messages, which
  `check:leaks:messages` rejects; its remaining findings are on commits
  already on `main`.
- Why: four base tests fail, identically on `main` in this environment, so
  they are not this change: `create-agent.test.ts` "CANNOT VERIFY when there
  is no runtime on PATH" (a real claude is on PATH here) and the
  `inbox.test.sh`, `inbox-push.test.sh` and `pane-idle.test.sh` suites
  (busy-pane and context-gate cases). `boot-agents.test.sh` passes, 45 of 45.
- Supersedes: nothing, additive.
- Commits: (this commit)
