Title: Clean-machine install with a setup flow

## Origin

Deck super-assistant MVP roadmap, M17 (8 November 2026): a clean-machine
install path with a setup flow. Shaped by the maintainer's direction that a
new user's first conversation is with the assistant, which asks what they do
and has the platform agent set up agents to match. This issue covers the name
and model-key parts of M17; connecting intake is left for the intake work. No
matching original Linear ticket was found in a bounded check.

Builds on the name-your-assistant change and consumes its final contract:
`first-run.sh`, the editable defaults `inkie` (assistant) and `doctor`
(platform agent), and its recovery of a partial pair.

Related: #21 (memory installation, not done by setup) and #26 (Windows via
WSL; setup assumes those prerequisites).

## Problem

Getting from a fresh clone to a working assistant takes about fifteen manual
steps across INSTALL.md sections 2 to 5: install, four directories, a `.env`,
`MC_USER`, build, start, create agents, boot them. Model keys have no setup
step at all; the only mechanism, a per-agent `.env.secrets`, is undocumented
for users and is not seen by the persona check. Once everything is running,
nothing asks the user what they want, so they meet two agents and an empty
thread.

## Proposed behaviour

- One command after the prerequisites and the clone, `scripts/setup.sh`. It
  checks the tools and the configuration first and writes nothing until both
  pass. Then it installs, creates the roots, writes `packages/deck/.env` only
  if there is none, builds, creates the two starter agents, optionally stores
  an API key, verifies both agents, starts Deck, and starts the agents only
  if both verified.
- It refuses to run as root. It resolves every setting the way Deck's
  launcher does (the environment first, then an existing `.env`) and refuses
  an effective `HOST` that is not loopback, naming which of the two it came
  from. Deck is started bound to loopback. An existing `.env` is never edited.
- It never answers a model CLI's sign-in, folder-trust or key-approval prompt.
  Those stay with the user.
- An API key is optional. It is read without echo (or from stdin with an
  explicit flag) and validated before anything is installed or built. It is
  never passed as an argument and never handed to the other programs setup
  runs; it is stored only in the two starter agents' `.env.secrets` (mode
  0600), which the agent check and the agent's terminal read. An existing key
  is replaced only with an explicit flag. Setup warns that a key takes
  precedence over a subscription sign-in and that each agent asks once to
  approve it.
- Two files cannot be renamed as one step, so the key write is guarded by a
  pending marker rather than a claim of atomicity. Setup works through private
  staging and backup copies (mode 0600, in the two agents' homes, removed
  afterwards), puts the first file back if the second write fails, and keeps
  the marker if that fails too or setup is interrupted. A later run that finds
  the pair resolved (the same key in both, or in neither) clears the marker;
  one that finds the pair different or unreadable stops before any check or
  launch. A different readable pair is reconciled with `--replace-key`, bound
  to the two agents the marker names; malformed or unreadable files need manual
  repair, and identical malformed values are not detected. Starting agents by hand
  is outside the marker's protection.
- Without a terminal, it needs explicit flags for the names and the key
  choice, or it stops before doing anything.
- Clear exit codes: usage error (a flag is missing), failed, agent check
  failed, verification could not run (no model CLI: Deck running, agents not
  started), waiting on you (agents started, prompts to answer), ready.
- In Deck, the assistant's first message asks what the user does and what
  they want help with first. It passes the answer to the platform agent,
  which proposes agents. As proposed (pending a maintainer decision), the
  proposal is capped at three and the user approves it on a decision card
  before the platform agent creates and starts them.
- Before creating an approved agent, the platform agent checks its state with
  a read-only code check that fails closed. An agent counts as complete only
  when its kind marker (written last) and the intended kind and peer are
  there and so is the whole scaffold: persona files, settings, boot phrase,
  role brief and inbox directory. A foreign, malformed, unreadable or partly
  built home, including an empty home directory, reads incomplete (absent means
  no home or inbox entry of any kind), is reported for the user to repair and is never
  recreated or deleted. Complete agents are skipped, and creation and launch
  results are reported separately; only complete approved agents are launched,
  and if none remain nothing is launched. The approval, the cap and the order
  of these steps are instructions to the agents, not enforced permissions.
- No new Deck endpoint: the conversation uses the existing thread and push.

## Acceptance

- On a bare Ubuntu 24.04 with no model CLI (measured by the install rig), one
  unattended run from INSTALL.md creates the roots, `.env` and both agents,
  starts Deck on loopback, does not start the agents, and exits with the
  "no model CLI" code. A pre-existing `.env` missing a required root stops
  the run, names it, and nothing is written.
- With a signed-in Claude CLI, the run is expected to end with exit 5,
  "waiting on you", when the agents wait solely on native prompts, naming
  them. Real signed-in Linux and WSL acceptance is pending, not done. After the user answers
  them, the assistant's first message asks what the user does.
- A non-loopback effective `HOST`, a root user, an invalid key, or a missing
  flag without a terminal stops the run before anything is written.
- A key entered at setup is stored in the two agents' `.env.secrets`, plus
  private 0600 staging and backup copies in the same homes while it is written,
  and is visible to the agents' own runtime (probe and panes) and its private
  raw probe capture. Printed diagnostics are redacted on a best-effort basis;
  split or encoded leakage is deferred.
- A failed key write that can be undone leaves both files as they were. One that
  cannot be undone, or an interrupted one, leaves a marker; the next run clears
  it if the pair matches, and otherwise stops before any check or launch.
- A second run changes no configuration or credential file.
- In the guided flow, no agent beyond the two starters exists until the user
  approves; approved agents then appear in Deck without a restart. Acting on
  the same approval again, using the saved approval and the status check,
  reports the agents as already complete, and an incomplete agent is reported
  for repair rather than recreated. There is no guarantee against a repeat in
  a new session. These are
  checked on the guided path; they are instructions to the agents, not
  enforced by code, and the documentation says so.

## Out of scope

- Connecting intake, mail or calendar.
- An in-app setup page (a new write path on a server with no login).
- Installing system packages; setup names what is missing.
- Memory installation (#21) and Windows-specific steps (#26).
- Keys for runtimes other than Claude, and OpenAI-compatible endpoints.
- An approval gate enforced in code.
- Workflows, a runs view, plugins, Brain changes, embedders, backup.
