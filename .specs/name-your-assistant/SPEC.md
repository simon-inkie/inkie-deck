# #TBD: Name your assistant at first run

- Issue: TBD
- Branch: feat/name-your-assistant (renamed to `<issue>-name-your-assistant`
  once the issue exists)
- Started: 2026-11-18

## TL;DR

A new user runs one command, names two agents (an assistant they talk to and a
platform agent that changes the setup), and opens Deck to find the assistant
pinned at the top of the agent list. The command wraps `create-agent.sh`, so
each agent is still created in both homes, and each newly created agent uses
the existing boot-phrase check by default (it proves the persona reached the
probe; the role brief and peer stamp have separate checks). Today every agent is created one at a time by hand, all agents
are siblings in alphabetical order, and nothing marks which one to start with.

## Origin

Deck super-assistant MVP roadmap, M3 (8 November 2026), following the maintainer's
direction to let users name their assistant and platform agent during setup.
The roadmap calls for both names, an assistant pinned above the other agents,
and the existing scaffold and persona proof. No matching original Linear ticket was found in a bounded check.

## Scope

In scope:
- `packages/base/bin/first-run.sh` (new): asks for the two names, checks both
  before creating either, then calls `create-agent.sh` twice and reports both
  verdicts. Flags for non-interactive use: `--assistant <name>`,
  `--platform <name>`, `--model <id>`, `--no-verify`, `--agents-home`,
  `--inbox-root`.
- `packages/base/bin/create-agent.sh`: three additions.
  - `--kind assistant|platform`: writes `<agent home>/.kind` and stamps a
    short role brief from `templates/kinds/<kind>.md` into the agent's
    `CLAUDE.md`.
  - `--peer <name>`: the other shipped agent's name, stamped into the brief so
    each knows who to hand work to, and saved as `<agent home>/.peer` so a
    re-run binds to it.
  - `--check-name <name>`: validate the name and that both homes are free,
    print the existing complaint, write nothing. Exit 0 or 1.
- `packages/base/templates/kinds/assistant.md` and `platform.md` (new). The
  platform brief carries the absolute path to `create-agent.sh`, stamped the
  same way the inbox CLI path already is in `TOOLS.md`.
- `packages/deck/app/lib/agent-kind.server.ts` (new): reads
  `<AGENTS_ROOT>/<agent>/.kind` with the same root resolution and
  degrade-to-null rule as `agent-model.server.ts`.
- `packages/deck/app/routes/shell.tsx`: the sidebar view-model gains
  `pinned`; agents whose kind is `assistant` sort first.
- `packages/deck/app/components/Sidebar.tsx`: pinned rows render above the
  "Agents" label; the empty-state copy changes to name the first-run command
  (the only change to a setup with no agents).
- Docs: INSTALL.md section 5 leads with `first-run.sh`;
  `docs/adding-an-agent.md` and `packages/base/README.md` gain the new flags.

Out of scope (and where it goes instead):
- An in-app first-run screen, model keys, connecting mail or calendar: the
  clean-machine setup flow, a later issue.
- Renaming an agent after creation. A name is a folder, a tmux window and a
  message address; rename is its own change.
- Display names distinct from the machine name.
- Any new permission system for the platform agent. It runs with its
  runtime's normal permission prompts.
- Workflows, intake, a runs view, plugins, workspace, Brain or Vault
  switching or changes, model keys, backup.
- Changing `boot-agents.sh`. The existing first-boot prompt already tells each
  agent to read its persona files, which now carry the role brief.

## Design

```
first-run.sh
  find existing agents by .kind in AGENTS_HOME (assistant, platform)
  both present?  -> report, exit 0 (a clean no-op, no verification claim)
  one present?   -> the missing one takes the present agent's saved .peer
                    name, not a newly typed one; the present agent is untouched
  ask or take names for the missing kinds only
  names must be valid and different; check-name each MISSING destination
      any refused -> exit 1, nothing written
  create-agent.sh <name> --kind <kind> --peer <other> [--model ...]
      for each missing kind only
  created agents get probe verdicts; existing agents are reported as skipped,
  never as verified; preflight failures report the validation error; exit with
  the worst
```

- `.kind` is a single-line marker beside `.runtime` and `.model`, the same
  contract Deck already reads for the model selector. No env var, no new
  config file, and it travels with the agent.
- Deck sorts and pins only; it never writes `.kind`. A missing or unreadable
  `AGENTS_ROOT` means no pin, never an error, and the list is the same
  alphabetical list as today.
- Exit code of `first-run.sh`: 1 if either creation hit a scaffold error,
  else 3 if either verification failed, else 4 if either could not be
  verified, else 0. Created agents get probe verdicts; existing agents are reported as skipped.
- `.peer` is a second single-line marker, written by `create-agent.sh --peer`.
  It is what makes recovery bind to the surviving agent's brief.
- Re-running is safe: existing agents are recognised first and skipped, and
  names are validated only for agents that are actually missing, so a
  same-name rerun is a no-op. The exit code of a rerun that created nothing is
  0 and says so; it is not a fresh verification result.

## Acceptance

- `first-run.sh --assistant ada --platform forge` on a machine with a working
  Claude CLI ends with two agents, each in both homes, each `VERIFIED`, with
  `.kind` set and the other agent's name in its brief.
- An invalid name, two identical names, or a taken name for a missing agent
  stops the run with the existing name complaint, and nothing is created.
- A completed matching pair run again is a no-op: nothing is created, both are
  reported as existing, exit 0, no verification claim.
- A matching partial pair resumes: only the missing agent is created, under the
  existing agent's saved peer name. When a newly typed name differs, the saved
  name is used and a warning is printed. If no peer marker exists, the name is
  asked for or accepted as usual.
- Without a usable Claude CLI, or when verification is skipped, both agents
  are created and report `CANNOT VERIFY`, exit 4.
- Deck shows the assistant first, above the "Agents" label, whatever its name
  sorts to, when the assistant is visible in Deck's existing
  inbox roster and the persona and inbox roots match the configured
  `AGENTS_ROOT` and `INBOX_ROOT` (an unset `AGENTS_ROOT` uses the default
  home). An ordinary populated list with no assistant
  keeps its alphabetical order; the empty state's copy changes. A missing or
  unreadable `.kind` marker means no pin.
- The role brief and peer name each have their own check: the stamped text is
  asserted in each agent's `CLAUDE.md` by test, and the manual interactive
  check below stays.

## What the persona proof does not cover

`create-agent.sh` proves persona loading with `claude -p`, so another model CLI
alone does not satisfy it. The boot phrase proves `IDENTITY.md` reached that
one non-interactive probe. It does not prove the role brief or peer stamp
(loaded through `CLAUDE.md`, whereas the first-boot prompt names `IDENTITY.md`
and `SOUL.md`), nor an interactive session. Those are checked by test and by
the manual step.

## Test plan

Core behaviour only.

- `packages/base/test/first-run.test.ts`, reusing the sandbox and stub
  runtime from `create-agent.test.ts`:
  - happy path, stub that answers with the boot phrase: two agents, `.kind`
    files, role and peer text asserted in each `CLAUDE.md`, exit 0;
  - bad name, identical names, taken name: exit 1, both homes untouched;
  - same-name rerun: no-op, nothing changes;
  - one agent present: only the other is created, under the saved peer name;
  - no runtime on PATH: both created, exit 4.
- `packages/base/test/create-agent.test.ts`: `--kind` with an unknown value
  is refused with nothing written; `--check-name` writes nothing.
- `packages/deck/test/sidebar-pinned.test.tsx` (or an extension of the
  sidebar test): an assistant named `zed` renders first and pinned; no
  `.kind` gives today's alphabetical order.
- Manual: run `first-run.sh` in a sandbox with a real model CLI, reload Deck,
  confirm the pin and that each agent's first reply knows its role.

## Decisions log

- First run is a script, not a Deck page. Deck has no authentication, and a
  page that creates agents and runs a model turn is a new write path on an
  open server. The in-app flow belongs with the clean-machine setup issue.
- `.kind` marker file rather than an env var in Deck's `.env`: a script
  should not edit Deck's config, and the marker matches `.runtime` and
  `.model`.
- The role brief goes in `CLAUDE.md`, not `SOUL.md` or `IDENTITY.md`, so the
  self-authored files keep their day-one placeholders and the first-boot
  prompt still fires.
- Defaults offered as editable defaults: `inkie` and `doctor`. The platform
  brief says to ask before changing anything outside the agents folder and does
  not mention auto-mode. The assistant brief makes the assistant the main
  orchestrator; the platform brief makes the platform agent the "brain surgeon" that
  edits Deck, makes plugins and creates agents. The guard covers anything
  outside the agents folder and Deck's own workspace.
- Recovery binds to the saved peer name rather than requiring new input to
  match it: the surviving agent's brief already names its peer.
- Both names are checked before either agent is created, so a typo in the
  second name never leaves a lone assistant behind.

## Follow-ups

- In-app first-run screen, as part of the clean-machine setup flow.
- Next issue: conversational onboarding. On first run Inkie asks the user what
  they do and has the platform agent create agents to match. It belongs with
  the clean-machine setup flow and is not built here.
- `rename-agent.sh` and `remove-agent.sh`.
- Deck reads `AGENTS_ROOT` and the scripts read `AGENTS_HOME`; when they
  differ the pin silently does not appear. `create-agent.sh` already warns;
  a single variable would remove the trap.

## Log

### 2026-11-18: plan and SPEC
- What changed: wrote this SPEC and the issue text from a read of
  `create-agent.sh`, `claude-session.sh`, the shell loader and the sidebar.
- Why: the issue comes first; the design is grounded in the files it changes.
- Supersedes: nothing, additive.
- Commits: none yet.

### 2026-11-18: built
- What changed: `create-agent.sh` gained `--kind`, `--peer` (saved as `.peer`)
  and `--check-name`, with role briefs in `templates/kinds/`; new
  `first-run.sh`; Deck reads `.kind` (`agent-kind.server.ts`) and the sidebar
  pins the assistant; INSTALL.md, `docs/adding-an-agent.md` and the base README
  updated. Tests: `first-run.test.ts`, additions to `create-agent.test.ts`,
  `sidebar-pinned.test.tsx`.
- Why: build steps 1 to 6, plus review corrections (existing agents are
  recognised before names are checked; recovery binds to the saved peer; the
  proof's limits are stated; Origin added).
- Supersedes: the earlier Design flow that required both names to be free,
  which would have failed a same-name rerun.
- Commits: see `git log` on the branch.
