# #29: Deck dies when you close the terminal it was started in

- Issue: #29
- Branch: 29-deck-survives-terminal-91csgr
- Started: 2026-10-07

## TL;DR

INSTALL.md starts Deck in the foreground, so closing that terminal stops it.
This adds a "Keep it running" option to INSTALL.md's start section: a detached
tmux session for the quick case, and an example systemd user unit
(`deck.service`, `Restart=always`, `EnvironmentFile=.env.production`) with the
`loginctl enable-linger` step a user unit needs to outlive logout. Start on
boot is out of scope and tracked elsewhere.

## Scope

In scope:
- INSTALL.md: a "Keep it running" subsection after "Build, and start", with the
  tmux option and the systemd user unit option.
- An example unit, `deck.service`, in the repository.
- Whatever the rig needs so INSTALL.md still passes its shape stage.

Out of scope (and where it goes instead):
- Starting Deck at boot as a hard requirement: tracked separately per the issue.
- Changes to `start-production.mjs` or `deploy.mjs`.

## Acceptance

- INSTALL.md's "start Deck" section offers a "keep it running" option.
- The example unit is in the repo and starts Deck on an Ubuntu 24.04 box with
  `systemctl --user start deck`.

## Test plan

Automated:
- `node rig/run.mjs --self-test`, and the shape stage's coverage check run
  directly against INSTALL.md: no unclaimed or unknown-language blocks, and the
  long-running prose probes still match.
- The repository checks in CONTRIBUTING.md. On 2026-10-07 typecheck,
  boundaries, leaks, licence, lib-version, dashes and the deck suite
  (2168 passed) were green. Two base tests fail identically on `main` in the
  environment this was done in, so they are not this change's:
  `create-agent.test.ts` "reports CANNOT VERIFY" (a model CLI is on `PATH`
  there) and `shell-suites.test.ts` "inbox.test.sh". `check:leaks:messages`
  flags only commits already on `main`.

Manual, because the rig cannot run a systemd user manager (2026-10-07):
- `systemd-analyze --user verify` on the unit with the placeholders filled in.
- An `ubuntu:24.04` container booted with systemd as PID 1, Node and a built
  clone copied in, a normal user `you`. As that user, from the clone root, the
  INSTALL.md blocks run byte for byte: the four roots and `.env`, then the unit
  install block. `systemctl --user start deck` came up active and
  `GET /` showed "No agents yet" and "Nothing needs you".
- Without linger, logging out stopped Deck (connection refused). With linger,
  Deck still answered 15 seconds after logout.
- `loginctl enable-linger "$USER"` as the user was refused ("Access denied")
  in that container, which has no polkit; root enabling it stood in for the
  documented `sudo` fallback.
- `kill -9` of the main process: systemd restarted it (`NRestarts=1`) and it
  answered again. `systemctl --user stop deck` left no node process behind.
- The tmux block run from the clone root; Deck answered from a later, separate
  shell, and `tmux kill-session -t deck` stopped it.

## Decisions log

### 2026-10-07: work picked up
- What changed: SPEC created.
- Why: first commit on the branch, per DEVELOPMENT.md. The folder uses the
  branch name as given.
- Supersedes: nothing, additive.
- Commits: docs(install): start SPEC for keeping Deck running (#29)

### 2026-10-07: tmux and systemd options, rig language
- What changed: INSTALL.md gains "Keep it running" after "Build, and start",
  with a detached tmux session and a systemd user unit at
  `packages/deck/deploy/deck.service`, plus `loginctl enable-linger`. The
  rig's plan learns a non-executed `sh-manual` block language.
- Why:
  - Unit with `@DECK_DIR@` and `@NODE_DIR@` placeholders, filled by a `sed`
    in the document: the clone can be anywhere, and a user unit cannot use a
    relative `WorkingDirectory`. `%h/inkie-deck` would assume a path the
    document never sets.
  - Node by absolute path, and first on the unit's `PATH`: the launcher spawns
    the voice proxy as `node` from `PATH`, and its own comments record a
    service manager resolving the wrong Node once.
  - `EnvironmentFile=-.../.env.production`, optional: INSTALL.md already has
    the reader write `.env`, which the launcher reads anyway. Requiring a
    second file would duplicate the four roots. This keeps the existing claim
    true that the EnvironmentFile wins over `.env`.
  - `Restart=always`, `RestartSec=5`, `WantedBy=default.target`, default
    `KillMode`: the launcher's SIGTERM handler does not kill the app server
    (rig/container-image-note.md), and killing by control group covers that.
  - tmux session named `deck`, not `agents`, so it stays out of tier 3's
    session.
  - New `sh-manual` language rather than `sh`: every `sh` block must be
    claimed by a rig run, a container has no user systemd, and a detached
    second Deck would collide with the run's own on 4242. Adding a new rig
    stage is out of scope; listed as a follow-up. The document says these
    blocks are not executed.
  - The WSL and start-on-boot sentences say "unverified" or "not checked"
    because neither was measured here.
- Supersedes: nothing, additive.
- Commits: docs(install): keep Deck running after the terminal closes (#29)

## Follow-ups

- `packages/deck/scripts/deploy.mjs` defaults `MC_SERVICE` to
  `inkie-deck.service`, while the example unit is `deck.service` as the issue
  asks. Not changed here: deploy.mjs also needs a tailnet front and is not part
  of the documented install. Needs an issue.
- Have the rig execute the Keep it running blocks, which needs a container
  stage that boots systemd. Needs an issue.
- Start on boot: tracked elsewhere, per #29.
