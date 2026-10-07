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

To be filled in as the approach settles.

## Decisions log

### 2026-10-07: work picked up
- What changed: SPEC created.
- Why: first commit on the branch, per DEVELOPMENT.md. The folder uses the
  branch name as given.
- Supersedes: nothing, additive.
- Commits: this one.

## Follow-ups

None yet.
