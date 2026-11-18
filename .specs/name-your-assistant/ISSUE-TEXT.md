Title: Name your assistant at first run

## Origin

Deck super-assistant MVP roadmap, M3 (8 November 2026), following the maintainer's
direction to let users name their assistant and platform agent during setup.
No matching original Linear ticket was found in a bounded check.

## Problem

After install, a new user has to create every agent one at a time with
`create-agent.sh`, choosing names and roles with no guidance. Deck then lists
all agents as equals in alphabetical order, so nothing tells the user which
agent to start talking to, and no agent knows it is expected to help set up
the others.

## Proposed behaviour

- A single first-run command asks for two names: an assistant (the main
  orchestrator the user talks to first) and a platform agent (the
  "brain surgeon" that edits Deck, makes plugins and creates agents when the
  assistant asks). The defaults are `inkie` and `doctor`, both editable.
- Both names are checked before anything is created. Each agent is made with
  `create-agent.sh`, so it exists in both homes and each newly created agent
  uses the existing boot-phrase check by default.
- Each agent gets a short role brief and knows the other's name.
- Deck pins the assistant to the top of the agent list.
- The command can run without prompts (`--assistant`, `--platform`) and is
  safe to run again.

## Acceptance

- With a working Claude CLI, running the command with two valid names produces
  two agents, each verified, each knowing its role and the other agent's name.
- An invalid, duplicate or taken name stops the run and creates nothing. A
  name is only checked for an agent that is actually missing.
- A completed matching pair run again is a no-op (exit 0, no verification
  claim). A matching partial pair resumes: only the missing agent is created,
  under the peer name the existing agent already holds. If a different name
  is supplied, the saved name is used and a warning is printed.
- Without a usable Claude CLI, or when verification is skipped, both agents
  are created and reported as not verified (exit 4), not as a pass.
- The boot phrase proves persona loading only. The role brief and peer name
  are checked separately by test, plus a manual interactive check.
- Deck shows the assistant first, whatever its name, when it is visible in Deck's existing
  inbox roster and the persona and inbox roots match the configured `AGENTS_ROOT` and `INBOX_ROOT`. A populated list
  with no assistant keeps its alphabetical order; a missing or unreadable
  `.kind` means no pin. The empty-state copy changes to name the first-run
  command.

## Out of scope

- An in-app setup screen, model keys, connecting mail or calendar, intake.
- Conversational onboarding, the next issue: on first run Inkie asks the user
  what they do and has the platform agent create agents to match.
- Renaming or removing agents.
- Any new permission system for the platform agent.
- Workflows, a runs view, plugins, workspace, Brain or Vault changes, backup.
