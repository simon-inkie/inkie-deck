# #151: Clean-machine install with a setup flow

- Issue: #151 (https://github.com/simon-inkie/inkie-deck/issues/151)
- Branch: feat/clean-machine-install
- Started: 2026-11-18
- Depends on: the name-your-assistant change (#150), still in review. This item
  consumes its final contract after it merges and rebases onto `main`:
  `first-run.sh`, the editable defaults `inkie` (assistant, the main
  orchestrator) and `doctor` (platform agent, the brain surgeon), `.kind`,
  `.peer` written before `.kind`, and recovery that binds a missing agent to
  the survivor's saved peer. Nothing here re-implements that.
- Related: #21 (memory installation; setup does not install memory, it points
  at the optional memory step) and #26 (Windows via WSL; setup assumes those
  prerequisites are done and adds nothing Windows-specific).

## TL;DR

After the prerequisites and the clone, a new user runs one command,
`scripts/setup.sh`. It validates everything first, then installs, makes the
roots and the `.env`, builds, creates the two starter agents through
`first-run.sh`, optionally stores a model API key, verifies both agents,
starts Deck on loopback and, only if both verified, starts them. In Deck, the
pinned assistant's first message asks what the user does; the platform agent
proposes a few agents, and the user approves them on a decision card before
any is created. Today the same path is about fifteen manual steps across
INSTALL.md sections 2 to 5, and nothing after install asks the user anything.

This is part of M17: name and model keys are here; connecting intake is not.

## Origin

Deck super-assistant MVP roadmap, item M17 (8 November 2026): a clean-machine
install path with a setup flow covering name, model keys and connecting intake.
Intake is out of scope here. The maintainer's direction (18 November 2026): on
first start the user talks to the assistant, which asks what they do and asks
the platform agent to do the initial setup and create agents that fit. No
matching original Linear ticket was found in a bounded check.

## Supported targets

- Ubuntu 24.04: measured by the rig, up to the model CLI.
- Ubuntu under WSL2 after the #26 prerequisites: by hand, same script.
- macOS: unverified, as for the rest of INSTALL.md.

## Scope

In scope:
- `scripts/setup.sh` (new). Flags: `--yes`, `--deck-home <dir>` (default
  `$HOME/deck`), `--agents-home <dir>` (default `$HOME/agents`),
  `--assistant <name>`, `--platform <name>`, `--model <id>`, `--no-key`,
  `--key-stdin`, `--replace-key`, `--no-install`, `--no-build`, `--no-start`.
- `packages/base/bin/create-agent.sh`: the persona probe sources
  `<agent home>/.env.secrets` inside the probe subshell only, as
  `boot-agents.sh` does before launching the runtime. New `--person <name>`
  stamps the user's `MC_USER` into the role brief. New `--status <name>`
  prints `complete`, `incomplete` or `absent` and writes nothing, and fails
  closed: `.kind` is written last (item 1's contract) but a marker alone
  proves nothing, so complete needs the kind (the one given with `--kind`, if
  any) and the peer (the one given with `--peer`, if any) AND the whole
  scaffold: every persona file, `.runtime`, `.claude/settings.json`, the boot
  phrase in `IDENTITY.md`, the role brief in `CLAUDE.md` and the inbox
  directory, all as readable regular files and directories, none a symlink.
  A foreign, malformed, unreadable or partly built home, including an
  existing empty home directory, reads `incomplete` and is left alone for
  repair; `absent` means no observed home or inbox entry of any kind.
  Creation still scaffolds into an existing empty home without repair. `--kind` gains a third value, `member`,
  for agents the platform agent creates, with a short brief in
  `templates/kinds/member.md` naming the assistant. Deck pins only
  `assistant`, so members sort as today.
- `packages/base/bin/first-run.sh`: passes `--person` through.
- `packages/base/bin/claude-session.sh`: `claude_first_boot_prompt` appends one
  sentence for an agent whose `.kind` is `assistant`: after day one, start the
  first conversation as the role brief describes.
- `packages/base/templates/kinds/assistant.md`: "First conversation" section.
  `platform.md`: "Setup requests" section.
- Docs: INSTALL.md "Quick setup" section, which hands off to sections 2 to 5
  as the manual path and reference; README pointer; Known limitations entries.
- Rig: a declared run executing the Quick setup block, and a stage with its
  negative control.

Out of scope (and where it goes instead):
- Intake and connecting mail or calendar (M11 to M13).
- An in-app setup page (see Decisions).
- Installing system packages. Setup names a missing tool and points at
  INSTALL.md section 1 (or #26 on Windows); it never runs `sudo` or `apt-get`.
- Memory installation (#21).
- Keys for runtimes other than Claude, and OpenAI-compatible endpoints (M4).
- An enforced approval gate in code (see Decisions and Follow-ups).
- The model selector's operator gate (see Follow-ups).
- Workflow engine, runs view, plugin system, Brain switch or migration,
  pluggable embedder, anything commercial, backup.

## Design

### Order: validate everything, then write

```
A  preflight      (writes nothing)
   not root (uid 0 -> exit 1: Deck and agents would run as root)
   inside a git work tree; node, pnpm via corepack, rg, python3, tmux, xxd;
     if decision 3 picks the card, python3 can import yaml
   flags vs terminal (see Unattended use) -> usage error exits 2
B  resolve and validate the effective configuration  (writes nothing)
   every setting resolved with the launcher's precedence: process
     environment, else an existing packages/deck/.env, else setup's default
   four roots: set and absolute; AGENTS_ROOT equal to --agents-home
   MC_USER: a plain name (lowercase letters, digits, hyphens); it becomes a
     thread file name and the assistant's addressee
   HOST: anything but 127.0.0.1, localhost or ::1 -> exit 1, naming whether
     it came from the environment or .env
   PORT: a port number, default 4242; a listener already on it that is not
     setup's own `deck` tmux session -> exit 1
   names: first-run.sh's own checks (--check-name) for missing kinds only
   key state (see Model keys): a pending key marker is reconciled or the run
     stops; each starter's .env.secrets, if present, is a regular file owned
     by the user, not group or world writable; whether a key will be written
     is decided; if so the key is read now (hidden prompt or --key-stdin),
     validated, and held in memory only
C  write          (each skips what is already there)
   pnpm install                     (COREPACK_ENABLE_DOWNLOAD_PROMPT=0)
   roots; .env only if absent (four roots, AGENTS_ROOT, MC_USER)
   pnpm build
   first-run.sh --no-verify --person <MC_USER> [names] [--model]
   key commit (see Model keys)
   create-agent.sh --verify-only <assistant> and <platform>
     (never while a key marker is pending)
D  start
   Deck: tmux session `deck`, launched with HOST=127.0.0.1 and PORT from B
     in its environment, which wins over .env; ready when the pane shows the
     launcher's `app on http://127.0.0.1:<port>` line and that URL answers
   agents: only if both starters VERIFIED:
     boot-agents.sh <assistant> <platform>      (named, never all agents)
E  report         address, what is waiting on the user, exit code
```

The effective roots, `AGENTS_HOME`/`AGENTS_ROOT`, `INBOX_ROOT` and `MC_USER`
are resolved once in B, inherited overrides included, and passed explicitly
to every child (first-run, create-agent, boot and the Deck launch), so Deck,
the scaffold, boot and the inbox CLI cannot disagree.

### Exit codes and precedence

| code | meaning | agents launched? |
| --- | --- | --- |
| 2 | usage: a flag is missing for an unattended run | nothing done |
| 1 | failed: preflight, configuration, scaffold, key commit, unresolved mixed key, Deck start or agent launch | as far as it got |
| 3 | a starter's persona check failed | no |
| 4 | no usable model CLI, or verification could not run | no; Deck is running |
| 5 | launched, waiting on the user at native prompts (trust, key approval) | yes |
| 0 | Deck running on loopback, both starters verified and ready | yes |

Precedence when several apply: 2, 1, 3, 4, 5, 0. Because boot runs only after
both starters verify, a missing CLI always ends as 4 and is never hidden by a
boot result. Inside setup, `first-run.sh --no-verify` returning 4 (created,
unverified) or 0 (nothing to do) is success; any other code is 1. Boot's own
pending status becomes 5, its failure 1.

The 4 outcome is explicit: "Deck is running at <url>. Your agents exist but
were not started: install and sign in to the model CLI, then run setup again."

### Unattended use and reruns

- `--yes` accepts the defaults for names (`inkie`, `doctor`) and directories.
  It never chooses a key, never replaces anything, and never answers a model
  CLI's sign-in, trust or key-approval prompt. Setup answers none of those.
- With no terminal on stdin, setup needs names (`--yes` or both name flags)
  and a key choice (`--no-key` or `--key-stdin`); otherwise it exits 2 naming
  the missing flag, before anything is written.
- A healthy rerun repeats preflight, validation, `pnpm install` and
  `pnpm build` (idempotent, no user state) and skips everything else: `.env`,
  roots, starter agents, keys, a running `deck` session, running panes. It
  changes no configuration or credential file.
- Repair is the same command. A starter that is not yet launched (an earlier
  3 or 4) is verified again and, if both now pass, launched. A partial starter
  pair is recovered by `first-run.sh`'s own contract.

### Model keys

- A sign-in belongs to the model CLI; setup only checks the CLI is on PATH.
- The key is optional. With a terminal, setup asks sign-in or key; with
  `--key-stdin` it reads one line from stdin. Both happen in B, before install
  or build, and so does the replacement check: an existing key is kept unless
  `--replace-key` was given, and `--replace-key` without a terminal or
  `--key-stdin` is a usage error.
- Validation, also in B: characters from `[A-Za-z0-9_-]` only, bounded length.
  Anything else is refused, so the shell-sourced file needs no quoting rules.
- The key is never an argument, never echoed or logged, and never exported to
  the incidental children setup runs (pnpm, git, tmux, first-run). It is
  unset after the commit. Its only intended consumers are the two below.
- Written as `export ANTHROPIC_API_KEY=<key>` (the launcher sources the file,
  so an unexported assignment would not reach the CLI) into each starter's
  `.env.secrets`. Other lines are kept. A symlink, directory or unsafe
  existing file is refused in B.
- An existing key is never replaced by a rerun, with or without `--yes`.
- The key reaches only the persona probe (sourced in its subshell) and the
  starter runtime (sourced in its pane), the same two places as today.

Key commit. Two renames cannot be atomic together, so there is no
unconditional both-or-neither claim. The rule is: both files hold the new key,
or both are as they were, or a pending marker records that the pair may be
mixed and no later setup run verifies or launches until that is resolved. The
staging and backup copies are private (mode 0600, in the agents' homes) and
are removed afterwards.

```
1  write <AGENTS_HOME>/.setup-key-pending   (agent names only, no key)
2  stage both files as 0600 temps; keep a backup of each original
3  rename file 1, rename file 2
4  remove the marker                        -> committed
   rename 2 fails -> restore file 1 from its backup
     restored      -> remove marker, exit 1, neither changed
     restore fails -> keep marker, exit 1, report "mixed key state"
   interrupted at any point -> the marker stays
```

On the next run, B finds the marker and compares the two key lines in
memory, printing neither. Same key in both (or in neither): remove the
marker in C and continue. Different readable keys: exit 1, "mixed key state", nothing verified or
launched, unless `--replace-key` was given and the run selects the same two
distinct starters the marker names, in which case the new key is committed to
both through the same steps. An unreadable or malformed marker or key file,
or a marker that does not name two distinct agents, exits 1 and needs manual
repair; `--replace-key` does not address it. The limit, stated in
Known limitations: `boot-agents.sh` run by hand does not read the marker, so
starting agents outside setup while it exists can use a mixed pair.
- Both documents carry the warning: `ANTHROPIC_API_KEY` takes precedence over
  a subscription sign-in even when signed in, and each interactive pane asks
  once to approve it. Setup does not answer that question.

### The first conversation

No new Deck code and no new write path. The conversation runs in the
assistant's existing thread: the assistant writes with the `inbox` CLI, the
user answers in Deck's composer, and Deck's existing push wakes the idle pane.

```
assistant -> user        hello, then "what do you do, and what would you
                         like help with first?" (one message, at most 3 qs)
user      -> assistant   answers in Deck
assistant                records the answers in its USER.md
assistant -> platform    setup request: a short summary of the user's work
platform  -> assistant   proposal: at most 3 agents, each name, one-line
                         role, model; nothing created
assistant -> user        the proposal as a decision card: approve, change, skip
user      -> card        approve
assistant -> platform    the approved list, quoting the card
platform                 per approved name: create-agent.sh --status <name>
                           --kind member --peer <assistant>
                           absent     -> create-agent.sh <name> --kind member
                                         --peer <assistant> --role --model
                           complete   -> skip creation
                           incomplete -> do not create, do not delete; report
                         then, only if at least one complete approved name
                         remains, boot-agents.sh <those names>; with none,
                         no boot call at all (with no names it starts every
                         agent in the folder)
                         reports two lists: provisioning (created, already
                         complete, incomplete, failed) and launch (ready,
                         waiting on prompts, failed)
assistant -> user        both lists, the repair step for anything
                         incomplete, and that each new agent's first-boot
                         prompts wait in its terminal view
```

The approval card and the cap of 3 are the proposed interaction, pending the
maintainer's decision 3. Either way they guide the agents; they do not
enforce a permission. A retry consults the saved approval (the answered card)
plus `--status`; there is no per-session replay guarantee.

Three separate things, each with its own record:
- First-message trigger: the assistant's first-boot prompt, guarded by the
  existing `.first-boot-done` marker. The marker is written at launch, so a
  launch that dies first does not retry; deleting the marker resends it, as
  INSTALL.md already says.
- Approval record: the answered card in the user's thread file, which
  survives restarts and is what the platform agent quotes.
- Provisioning state: the agent homes, read through `create-agent.sh
  --status`, which is deterministic and written in code, not judged by the
  model. It fails closed (see Scope): a home with both directories but no
  `.kind`, or with a `.kind` but a foreign, altered, unreadable or partly
  built scaffold, reads as `incomplete`, never as done. An incomplete name is reported to the user
  with the removal step from `docs/adding-an-agent.md`, after which a new
  request can create it; nothing deletes it automatically. A failed name does
  not stop the others. If the platform agent stops part way, its next session
  resumes from the card and `--status`, not from memory.
- Launch state: reported separately from provisioning. A complete agent whose
  launch failed or waits on prompts is retried with `boot-agents.sh <name>`,
  which leaves running panes alone.

The limit, stated in INSTALL.md's Known limitations: whether the platform
agent waits for approval, keeps to the cap and calls `--status` first are
instructions in its role brief, not enforced by code. The brief confines it,
for a setup request, to creating and starting exactly the approved names
under the configured roots; it grants no plugin, Deck-editing, memory or
Brain authority for this request. Its runtime's own permission prompts still
apply and the user sees them. Acceptance below covers the guided path only.

Without `--person` (a standalone `first-run.sh` with no `MC_USER`), the
First conversation section is omitted with a warning: the assistant cannot
address a user it cannot name.

### What this does not change about the open server

Deck still has no authentication. Anyone who can reach the port can write to
any agent's thread, so they could hold this conversation and answer the card;
the card is guidance for the agents' own conduct, not a control against
someone at the port. That is why B refuses a non-loopback host and D pins
`HOST=127.0.0.1` for the launch. Loopback stays the whole security model.

## Acceptance

Rig lane (bare Ubuntu 24.04, no model CLI), proves the path up to the CLI:
- Setup run from INSTALL.md with `--yes --no-key` exits 4: four roots, `.env`
  with `MC_USER` and `AGENTS_ROOT`, both starter homes with `.kind`, Deck
  answering inside the container on `127.0.0.1:4242` with the launcher's
  loopback banner, and no `agents` tmux session.
- Negative control: a planted `.env` missing `INBOX_ROOT` exits 1 naming it;
  the file is byte-identical and nothing was written (no `node_modules`, no
  roots, no agent homes).

Test lane (sandbox, stub runtime):
- `HOST=0.0.0.0` in the environment, or in an existing `.env`, exits 1 before
  any write, naming where it came from.
- Non-TTY without `--no-key`/`--key-stdin` or names exits 2, nothing written.
- Run as uid 0 exits 1, nothing written.
- Key replacement stays bound to the marker's two distinct agents: a run
  selecting a different pair, or a marker naming one agent twice, is refused
  before any write and the marker is preserved.
- An invalid key, or `--replace-key` without a terminal or `--key-stdin`,
  stops the run before install or build: nothing written.
- A key via `--key-stdin` is stored in each starter's `.env.secrets` (0600) as
  an exported line, other lines kept. Beyond that it appears only in private
  0600 staging and backup copies in the same homes while it is written, in the
  agents' own runtime credential environments (the probe and the panes, which
  legitimately see it), and in the probe's private raw capture; never in an
  argument list, setup's own output or any other file. Diagnostic redaction of
  printed output is best-effort for the shell-assignment forms handled and key
  shapes; split or encoded leakage is deferred. A rerun with `--yes` leaves both files
  byte-identical.
- Second rename fails, restore succeeds: both files as they were, no marker,
  exit 1.
- Second rename fails, restore fails: marker kept, exit 1 reporting a mixed
  key state; mixed or unreadable state stops before any probe or launch. Stored-key
  parsing covers the shell-assignment forms handled (last `ANTHROPIC_API_KEY=`
  line, `export`, quotes); identical malformed values are not detected.
  Different readable states are what `--replace-key` addresses; unreadable or
  malformed state needs manual repair.
- Interrupted commit (marker planted with two different key lines): the next
  run exits 1 before verification, verifies and launches nothing; with
  `--replace-key` it commits the new key to both and clears the marker.
  Marker with matching lines: cleared, run continues.
- Boot is called with exactly the two starter names, and not at all on 3 or 4.
- `create-agent.sh --status`: `absent` with no homes, `incomplete` with both
  homes and no `.kind`, `complete` for a whole scaffold with the intended kind
  and peer; `incomplete` for a lone `.kind`, a different or unknown kind or
  peer, a malformed peer, a missing persona file, settings or inbox, no boot
  phrase, a foreign brief, a symlinked marker and an unreadable file; it
  writes nothing.
- The platform brief skips boot when no complete approved name remains.

Real-CLI lane (by hand, Linux and WSL):
- Real signed-in Linux/WSL acceptance is PENDING: it has not been done. With
  a signed-in Claude CLI, setup should end with exit 5 (reported only when the
  boot output reports prompts and nothing else is waiting) and names what is
  waiting (folder trust in each pane, and key approval if a key was given);
  setup has answered none of them. Once the user answers them in Deck's
  terminal view, the assistant's first message asks what the user does.
- In the guided path, no agent beyond the two starters exists until the user
  approves the card; approved agents then appear in Deck without a restart.
  Asked to act on the same approval again, the platform agent reports the
  agents as already complete and creates nothing. A planted incomplete home
  for an approved name is reported for repair, not recreated or deleted.
  These are observations of the guided path, not enforced guarantees.

## Test plan

Core behaviour only.

- `packages/base/test/setup.test.ts`, with `--no-install --no-build`, a stub
  runtime and a stub `boot-agents.sh` that records its arguments: the test-lane
  acceptance above, plus a fresh run reaching exit 0 and a rerun changing
  nothing.
- `create-agent.test.ts`: the probe sees an exported variable set only in
  `.env.secrets`; `--person` text is in the assistant's `CLAUDE.md`;
  `--status` for the three states and each fail-closed case; `--kind member`
  stamps the member brief; the platform agent checks a member with
  `--status <name> --kind member --peer <assistant>`.
- `boot-agents.test.sh`: the onboarding sentence is in the first-boot prompt
  for `.kind` assistant only, and still only once.
- Rig: the rig lane above as a declared run and stage.
- Manual: the real-CLI lane, once on Linux and once under WSL.

## Decisions log

Planner's calls:
- `scripts/setup.sh`, not a pnpm script: `pnpm setup` is pnpm's own command,
  and setup runs `pnpm install` itself.
- At the repository root, not in `packages/base/bin`, because it writes
  Deck's `.env` and base scripts do not edit Deck's config.
- Validation before any write, so a refused run leaves the machine as it was.
- A non-loopback host is refused rather than silently overridden: the user's
  next manual start would read the same `.env`.
- Boot only after both starters verify, so the no-CLI outcome is always 4.
- Its own exit code 5 for "waiting on you", because `first-run.sh` already
  uses 3 for a failed check and boot uses 3 for pending.
- An existing key is never replaced except by `--replace-key`.
- The key pair is guarded by a recorded pending marker that the next run
  reconciles, rather than a claim of atomicity two renames cannot give.
- Provisioning completeness is a code check (`--status`, item 1's `.kind`
  last), not two directories existing and not the model's judgement.
- Onboarding is prompt text plus one first-boot sentence: testable as stamped
  text, no runtime component. Its limits are stated rather than promised.

For the maintainer (recommendation first):
1. Where the "what do you do?" conversation happens. Recommended: the
   assistant's existing Deck thread, no new endpoint. Alternative: an in-app
   setup page, a new write path that creates agents and runs model turns on a
   server with no login; defer it until authentication exists.
2. Model keys at MVP. Recommended: sign-in check plus an optional Anthropic
   API key, stored only in the starter agents' `.env.secrets`, with the
   billing-precedence warning. Alternative: sign-in only, no key handling.
3. How new agents are approved. Recommended for MVP: a decision card (needs
   PyYAML for the `inbox` CLI, so `python3-yaml` joins INSTALL.md section 1's
   apt line), a cap of 3, guided only, with the limit stated. Alternatives: a
   plain "yes" reply (no new dependency, weaker act to accept), or an enforced
   gate now (`create-agent.sh` refuses a name absent from a recorded approval),
   which is a larger build.

## Follow-ups

- An enforced approval gate, if decision 3 keeps it out of MVP.
- The model selector and cron admin are gated on the default `MC_USER`, and
  setup sets `MC_USER` to the login name, so a clean install never sees the
  model selector. Needs its own gating decision.
- Every agent the platform agent starts stops at its own folder-trust prompt.
- An in-app setup page once Deck has authentication.
- Keys for other runtimes, after M4. Connecting intake, after M11 to M13.

## Log

### 2026-11-18: plan and SPEC
- What changed: wrote this SPEC and the issue text from a read of INSTALL.md,
  the rig, `create-agent.sh`, `boot-agents.sh`, `claude-session.sh`, the
  instance gates and the name-your-assistant change.
- Why: the issue comes first; the design is grounded in the files it changes.
- Supersedes: nothing, additive.
- Commits: none yet.

### 2026-11-18: review corrections
- What changed: validation moved before every write; effective `HOST` refused
  if not loopback and pinned for the launch; exit codes defined with
  precedence (new 5, boot only after both verify); key never replaced on a
  rerun (`--replace-key` only), exported line, input validated, two-file
  write all or nothing; unattended, root and non-TTY behaviour; boot gets the
  starter names; approval, trigger and provisioning given separate records
  and recovery, with acceptance scoped to the guided path; acceptance split
  into rig, test and real-CLI lanes; #21 and #26 linked; item 1's final
  defaults and recovery contract consumed.
- Why: plan review, three contradictions and the gaps around them.
- Supersedes: the first draft's order (install before validation), its exit
  precedence (pending over cannot-verify) and `--yes` replacing a key.
- Commits: none yet.

### 2026-11-18: review corrections, round 2
- What changed: key read, validated and checked for replacement in B, before
  install and build; key commit given a pending marker, a defined rollback,
  a "mixed key state" exit 1 and reconciliation on the next run, with
  interrupted and failed-rollback tests; the key is kept from incidental
  children, with the probe and pane as its stated consumers; provisioning
  uses `create-agent.sh --status` on item 1's `.kind`-last contract, keeps
  incomplete homes for repair, and reports launch separately; new `member`
  kind so created agents carry the marker; card and cap marked as proposed
  guidance; all settings resolved with the launcher's precedence, `MC_USER`
  validated and passed to every child; PyYAML in preflight if the card is
  chosen.
- Why: second plan review.
- Supersedes: the round-1 entry's "two-file write all or nothing" and the
  provisioning skip on two existing homes.
- Commits: none yet.

### 2026-11-18: build
- What changed: built steps 1 to 6. `create-agent.sh` gained `--status`
  (fail-closed, optionally told the intended `--kind` and `--peer`),
  `--person`, `--kind member` and the `.env.secrets` source in the probe;
  `first-run.sh` passes `--person` (default `MC_USER`); the assistant's
  first-boot message gains one sentence; role briefs gained the First
  conversation and Setup requests sections and a member brief;
  `scripts/setup.sh`; INSTALL.md Quick setup and Known limitations; the rig
  stage `install-setup` with its negative control.
- Review corrections applied: `--status` fails closed on the whole scaffold;
  the platform brief never runs `boot-agents.sh` with no names; key and
  approval wording aligned in this SPEC and the issue text.
- Deviations: `python3-yaml` joined the apt line because the decision card
  needs PyYAML in the `inbox` CLI. `--status` takes optional `--kind` and
  `--peer` so the platform agent can require the intended ones. The
  `name-your-assistant-first-run/sh#1` block, unclaimed by the rig on the
  stacked base, is declared skipped with a reason (it would collide with the
  create-an-agent block in the one-container run); first-run itself is
  executed by the quick-setup run. `setup.sh` accepts a `SETUP_BOOT_AGENTS`
  override, used by the tests. The rig's `EXPECTED_TESTS` and the README's published test
  counts were already stale on the base (deck 2023 against 2346 measured) and
  are left for their own change.
- Why: the plan's round-2 steps and the revision review.
- Supersedes: nothing.
- Commits: see the branch log.

### 2026-11-18: review round 1
- What changed: `--replace-key` now needs a key source even with `--yes`
  (usage error 2 otherwise) and an unresolved marker always stops before
  verification; the key transaction takes a `.setup-key-lock` directory lock
  and a second run refuses while it is held; the persona probe redacts every
  value in the agent's `.env.secrets` and anything shaped like a key from the
  runtime output it prints; setup refuses to store a key through a symlinked
  agents home, agent folder or `.env.secrets`, or into an agents home inside a
  git work tree; `HOST` and the other settings are parsed like dotenv (spaces,
  quotes, `export`, trailing comment); `--status` parses settings as JSON,
  requires non-empty `.runtime` and settings, checks the role brief matches
  the kind and reads a dangling home symlink as `incomplete`; `first-run.sh`
  and `setup.sh` decide that an agent exists by `--status` complete, not a
  bare `.kind`; `boot-agents.sh` prints a `waiting-detail: prompts=N other=M`
  line and setup exits 5 only when every waiting agent is at a prompt (else
  1); `--model` is validated before any write; `--no-start` no longer reports
  Deck as running; the tmux stub test asserts the loopback and root
  environment passed to Deck.
- Deviation: `.peer` is required by `--status` only when the caller names the
  intended `--peer` (an agent made before `.peer` existed is still whole, and
  first-run's recovery relies on that); if present it must be valid.
- Not covered by tests: the hidden-prompt paths (they need a terminal).
- Why: review of the first build.
- Supersedes: nothing.
- Commits: see the branch log.

### 2026-11-18: review round 2
- What changed: setup re-reads the key and marker state under the lock before
  deciding to write or clear, so a decision taken before another run finished
  is never applied; destination checks compare the real path with its spelling
  (a trailing `/.`, a symlinked parent or home all refuse), run again after the
  lock and again before staging and renaming, and Git is asked with discovery
  limits removed, where only "not a git repository" counts as safe; the
  persona probe decides its verdict on the raw reply and redacts only what it
  prints, reading `.env.secrets` as shell assignments and leaving values under
  8 characters or equal to the boot phrase alone; `--status` requires exactly
  one role heading and it must be the kind's own; boot classifies the API key
  approval prompt as a prompt, and a monitor wait whose reason is a prompt
  counts as one; `HOST` strips a trailing comment as Deck's loader does; the
  stale-lock message names the lock and the safe manual step.
- Not tested: a monitor-recheck wait that ends on a prompt (the code counts it
  as a prompt; the boot fixtures only cover the launch-time wait); a SIGKILL
  mid-write (the lock is released on normal exit, INT and TERM, and a stale one
  is explained, never removed automatically).
- Why: delta review of the first hardening commit.
- Supersedes: nothing.
- Commits: see the branch log.

### 2026-11-18: review round 3
- What changed: `--status` reads absent only when neither the agent home nor
  its inbox folder exists as any kind of entry (a dangling symlink counts);
  an empty home, foreign files only, or an inbox alone read incomplete. A
  mixed `--replace-key` repair is bound to the pair named in the pending
  marker: a run selecting a different pair is refused before any write and the
  marker is left intact. The member status example reads
  `--status <name> --kind member --peer <assistant>`; real signed-in
  Linux/WSL acceptance is marked pending.
- Also: marker binding covers the two names being distinct; wording now
  separates stored-key parsing from malformed-value detection, names the
  intended runtime credential environments and private staging and capture,
  calls printed redaction best-effort, and states that exit 5 depends on the
  boot output reporting prompts. Creation still scaffolds into an existing
  empty home, which `--status` reads as incomplete.
- Not tested: real signed-in acceptance (pending).
- Docs-only follow-up: replacement is limited to a readable mixed pair
  matching the marker's two distinct starters. "Removal" in the marker-binding
  rule means removal of the marker, not a key-removal command (setup has none).
  INSTALL.md states exit 5 only conditionally.

### 2026-11-18: review round 4 (quiet output, no-CLI text, runtimes)
- Setup sends `pnpm install` and `pnpm build` output to
  `<deck home>/logs/setup-install.log` and `setup-build.log`, shows one status
  line with the log path, and prints the last 30 lines on failure. Nothing is
  hidden: the exit status is the command's own.
- With no `claude` on PATH setup skips the two verify calls, still exits 4,
  and prints one plain block: a supported agent CLI must be installed and
  signed in, which are supported, the verified link, that Codex and
  Antigravity are not yet scaffolded or verified by Quick setup, and what the
  first conversation will look like (the assistant opens by asking what the
  user does, then is expected to propose up to three agents on a card).
  `create-agent.sh`'s own CANNOT VERIFY text names the same.
- Links come from the CLIs' own official docs (read with ctx7): Claude Code
  `https://github.com/anthropics/claude-code`, Codex
  `https://github.com/openai/codex`, Antigravity
  `https://antigravity.google/docs/install?tab=cli`.
- Naming (`ask_name` and its wording) is untouched.

Runtimes, read from the code (not memory):

| runtime | scaffold | boot | verify | live inbox | gaps |
| --- | --- | --- | --- | --- | --- |
| claude | yes (CLAUDE.md, imports) | yes: pinned session, first-boot prompt, `.env.secrets` sourced | yes: `claude -p` probe from the agent home | yes | none known |
| codex | partial: `--runtime codex` writes `.runtime`, but only CLAUDE.md-style persona files; no AGENTS.md | yes: resume by workspace session, update-dialog dismissal, AGENT_NAME/ROLE env | no: the probe always runs `claude`, so a codex agent is not verified | yes (paste-collapse and approval-dialog handling) | persona not delivered to Codex; not verified; Quick setup is Claude only |
| agy (Antigravity) | partial: same as codex; no GEMINI.md | generic only: `agy` is launched plainly, no resume, no readiness-specific handling beyond the shared pane check | no | yes (runtime gate admits it) | persona not delivered; no resume; not verified; Quick setup is Claude only |

Docs claim only the Claude Code support above and say "not yet" for the rest.

### Follow-up (scoped, not built): agent CLI detection in Deck
- Fit: a banner in the app shell, shown when no supported CLI is found.
  Server side, a new `packages/deck/app/lib/runtime-detect.server.ts` runs
  `command -v` for the three fixed names only (no arbitrary binaries, no
  execution of anything found, no `--version`), cached for about a minute
  because the shell loader revalidates every 3 seconds. `routes/shell.tsx`
  adds the result to its view-model; `components/AppShell.tsx` renders a small
  `RuntimeBanner`, dismissible, linking to the install pointers.
- Caveat: it reports Deck's own PATH, not the agents' panes' PATH, and cannot
  know that a CLI is signed in without running it.
- Size: about 50 lines for the module, 15 in the shell loader and 30 for the
  banner and its test, so roughly 150 to 200 lines across four files, in the
  shell that every page uses. Over the 150-line, risk-free bar, so it is not
  built; it needs approval.
