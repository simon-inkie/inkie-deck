# Installing Inkie Deck

Deck is a web control plane for a fleet of AI agents: inboxes, decision cards,
projects, and tmux-backed agent sessions over a file-based message protocol.

There are three tiers here, and they are deliberately separate because they
promise different things.

| tier | what you get | what it costs you |
| --- | --- | --- |
| [1. Try it](#1-try-it) | the whole interface, on throwaway fixture data | a few minutes, no configuration |
| [2. Run it for real](#2-run-it-for-real) | Deck over your own files, production build | four directories and a `.env` |
| [3. Bring your agents to life](#3-bring-your-agents-to-life) | actual agents in tmux sessions | a model CLI that you install, sign in to and pay for |

On Windows, start with [Windows (via WSL)](#windows-via-wsl). For one command
instead of the steps below, see [Quick setup](#quick-setup).

Tiers 1 and 2 are executed from this document on every rig run (see
[How this document is tested](#how-this-document-is-tested)). Tier 3 is
verified as far as a machine with no model subscription can go, which is
further than you might expect and stops well short of a working agent. That
boundary is marked where you reach it.

## Read this before you put Deck on a network

**Deck has no login, no password, and no authentication of any kind.** There
is no user model, no session, no access control in the application at all.
Anyone who can reach the port can read every message in your inbox, answer
decision cards as you, and type into your agents' terminal sessions.

That is a reasonable trade for the deployment it was written for: one person,
one machine, bound to loopback or reachable only over a private network with
authentication in front of it. It is not a defensible position anywhere else,
and it will not become one by accident. There is no decision yet about
building an authentication layer, so treat "who can reach this port" as the
entire security model, because today it is.

The production launcher binds loopback by default and says so at boot. Every
step below that widens that bind says this again, in the place where you would
be about to do it.

## How this document is tested

The shell blocks in this file are not illustrations. They are extracted from
this markdown by `rig/lib/fenced.mjs` and executed, byte for byte and in
document order, inside a fresh `ubuntu:24.04` container that starts with no
Node, no pnpm, no git, no ripgrep, no python3 and no tmux. Nothing is
re-typed into a script that could drift from the prose: if a block here is
wrong, the rig goes red.

- Blocks tagged `sh` are executed. Every one of them is claimed by a declared
  run, and a block that no run claims fails the rig, so an example cannot
  quietly stop being tested.
- Blocks tagged `text` are recorded output, printed here so you can compare.
- Blocks tagged `zsh` are the macOS path. Containers are Linux, so **the macOS
  instructions in this document are unverified**: there you are reading a
  belief rather than an observation.
- Blocks tagged `sh-manual` are not executed either: a container has no
  systemd user manager, and a second Deck would collide with the one the run
  already started. They were run by hand when written, and can drift without
  the rig going red. They are in [Keep it running](#keep-it-running), and in
  the [Windows section](#windows-via-wsl), where the ones that only make sense
  under WSL were not run by hand at all, because nothing here runs Windows.
- Blocks tagged `powershell` are the Windows side of that section. A Linux
  container cannot run them, so they are neither executed nor measured.

`rig/README.md` describes the harness. `node rig/run.mjs` runs it.

## Windows (via WSL)

Deck runs on Linux. On Windows 11 you run it inside WSL2, which is a real Ubuntu
that Windows starts for you, and you use it from your normal Windows browser.
Do the first five subsections below first, up to and including Line endings,
then follow the rest of the document from inside Ubuntu. The later subsections
(the model CLI, opening Deck, keeping Deck running) are for when section 4 or 5
sends you back here. Every Linux step is the same step as for any Ubuntu
machine, and this section only covers what is different on Windows. The blocks
marked `powershell` run in Windows PowerShell. Every other block runs in the
Ubuntu window.

### Install WSL2 and Ubuntu

Open the Start menu, type PowerShell, right-click it and choose Run as
administrator. Then:

```powershell
wsl --install -d Ubuntu-24.04
```

Restart Windows if it asks. After the restart an Ubuntu window opens and asks
you to choose a username and a password. Use a short lowercase username, and
type it in that window: Ubuntu only offers to create your user when you start
it by hand, from the Start menu. The password is for `sudo` and does not show
as you type.

If a script or a remote session started Ubuntu for you instead, no user was
created and you are the all-powerful `root` user. You can tell by the prompt:

```text
root@PC:/mnt/c/Users/you#
```

To fix it, create your user from that prompt (replace `you`):

```sh-manual
adduser you
usermod -aG sudo you
```

Then open the file with `nano /etc/wsl.conf` and make sure it contains the
lines below, adding the section if it is not there and editing it if it is:

```text
[user]
default=you
```

Save with Ctrl-O, Enter, then Ctrl-X. Close the window, run `wsl --shutdown` in
PowerShell, and open Ubuntu again. The prompt should now read `you@PC:~$`.

### Make sure Ubuntu is the one that opens

Some Windows tools, Docker Desktop among them, add their own small Linux and
can quietly become the default, so typing `wsl` lands you somewhere that is not
Ubuntu. Look at the list. The star marks the default, and the version column
should say 2:

```powershell
wsl --list --verbose
```

```text
  NAME              STATE           VERSION
* Ubuntu-24.04      Running         2
  docker-desktop    Stopped         2
```

If the star is on something else:

```powershell
wsl --set-default Ubuntu-24.04
```

From now on, open Ubuntu with the Ubuntu-24.04 entry in the Start menu, or from
PowerShell with `wsl --cd ~`, which starts in your Linux home folder instead of
in your Windows one.

### Keep everything in the Linux home folder

Everything below, the clone included, goes under your Linux home folder,
`/home/you`, which `~` stands for in the commands. Do not put it under
`/mnt/c`, which is your Windows drive seen from Linux. That path is the default
if you start Ubuntu from a Windows folder, and it is the wrong place for three
reasons: file access across the boundary is much slower, so installs and test
runs take many times as long; Windows files do not carry Linux permissions, so
scripts lose the right to run; and Windows tools that touch the files can
change their line endings (below).

Check where you are before you clone:

```sh-manual
pwd
```

```text
/home/you
```

If it starts with `/mnt/c`, run `cd ~` first. You can still browse the files
from Windows: type `\\wsl.localhost\Ubuntu-24.04\home\you` into the File
Explorer address bar. Open them to read or copy. Do not edit the scripts with a
Windows editor that saves Windows line endings.

### Install the tools

Run the Ubuntu commands in [1. Prerequisites](#1-prerequisites) in the Ubuntu
window. They are written for the root user, and you are not root, so first
type `sudo -i` and enter your password; that gives you a root shell. Paste the
block, type `exit` to come back to your own prompt, and then run the
`export COREPACK_ENABLE_DOWNLOAD_PROMPT=0` line again, because it only applied
inside the root shell. Do not put `sudo` in front of the lines one by one: it
does not carry across the `|` in the Node line or work with `export`. Then
carry on with section 2 and onwards. tmux is in that list and you need it on
Windows too.

Check that Node is the Linux one. WSL adds your Windows programs to the end of
the search path, so a Node installed on Windows can answer if the Linux one is
missing:

```sh-manual
command -v node
```

```text
/usr/bin/node
```

A path starting `/mnt/c` means the Linux install did not happen, and Deck will
fail in confusing ways until it does.

### Line endings

Windows ends each line with two characters and Linux with one. A shell script
with the Windows ending fails at its very first line:

```text
/usr/bin/env: 'bash\r': No such file or directory
```

The repository forces the Linux ending in every file it checks out
(`.gitattributes`), whatever your git settings say, so a fresh clone made
inside Ubuntu is already right and you do not need to change anything. It
matters when the files come from somewhere else: a clone made with Windows git
and then copied across, or a ZIP unpacked by Windows. If you see the error
above, make a new clone inside Ubuntu rather than repairing the files.

### The model CLI

This is for [5. Bring your agents to life](#5-bring-your-agents-to-life). Two
traps are worth avoiding before you get there.

Install the CLI inside Ubuntu, with the Linux instructions from its own
documentation, not the Windows ones. A Windows copy is visible from Ubuntu
because of the path rule above, and it starts but runs half-configured: it
looks for its settings in the wrong place and cannot see your Linux files. Ask
Ubuntu which one it will run:

```sh-manual
command -v claude
```

```text
/home/you/.local/bin/claude
```

A path starting `/mnt/c` is the Windows copy. The cure is to stop Ubuntu seeing
Windows programs at all. Open the file with `sudo nano /etc/wsl.conf` and make
sure it contains:

```text
[interop]
appendWindowsPath = false
```

Save with Ctrl-O, Enter, then Ctrl-X. Run `wsl --shutdown` in PowerShell and
open Ubuntu again. The side effect is that Windows programs such as `code` and
`explorer.exe` no longer answer by name from Ubuntu. If you need them, leave the
setting alone and make sure `command -v claude` is the Linux path.

The first time the CLI runs it asks you to sign in. Ubuntu has no browser, so it
prints a web address: select it, copy it, paste it into your Windows browser,
approve the sign-in there, and paste the code the page gives you back into the
Ubuntu window. Do this from an empty throwaway folder, not from wherever you
happen to be:

```sh-manual
mkdir -p ~/scratch && cd ~/scratch
```

The CLI also asks whether you trust the folder it was started in, and a yes
covers everything inside it. If Ubuntu was started from your Windows home, that
folder is your whole Windows home, and the right answer there is no.

### Open Deck from Windows

Start Deck inside Ubuntu as in [4. Run it for real](#4-run-it-for-real), then
open <http://localhost:4242> in your Windows browser. WSL2 passes `localhost`
through to Ubuntu, so Deck can stay bound to loopback and nothing else on your
network can reach it. Do not set `HOST=0.0.0.0` to get around a page that does
not load: it publishes a Deck with no login to your whole network, and the
warning at the top of this document applies in full. If the page does not load,
check that the launcher is still running (below), then try
<http://127.0.0.1:4242>. If that fails too, run `wsl --shutdown` in PowerShell,
open Ubuntu again, start Deck again and retry. Do not change anything else.

### Keep Deck running on Windows

Closing every Ubuntu window can stop Linux, and Deck with it, however you
started it. Minimise the window instead of closing it. Of the two ways in
[Keep it running](#keep-it-running), the tmux one is the simplest to start: it
keeps Deck alive when you close the terminal tab. Whether it survives Windows
stopping Ubuntu when no window is open has not been checked, so treat the
systemd service below as the dependable option. Start tmux from the root of your
clone, after `pnpm build`.

For a service that Linux starts for you, WSL needs systemd switched on. Check
first, because recent Ubuntu images often have it already:

```sh-manual
ps -p 1 -o comm=
```

```text
systemd
```

If that prints anything else (usually `init`), open `sudo nano /etc/wsl.conf`
and add:

```text
[boot]
systemd=true
```

Save, run `wsl --shutdown` in PowerShell, open Ubuntu again and repeat the
check. Then follow the systemd user service steps in
[Keep it running](#keep-it-running), and add two commands to them. Starting the
service does not bring it back after a restart, so also run:

```sh-manual
systemctl --user enable deck
loginctl enable-linger "$USER"
```

`enable` makes the service start whenever your user's services start.
`enable-linger` keeps them running without an Ubuntu window open, which is what
you want under WSL. Without it, Deck comes back only when you next open an
Ubuntu window. Either way it does not start with Windows itself: nothing runs
until Ubuntu is started, and opening any Ubuntu window does that.

## 1. Prerequisites

Deck needs Node on a current LTS line, pnpm (via corepack), and a **git
clone**. A downloaded ZIP or a release tarball is not enough: two of the test
suites and the leak gate shell out to git against the repository root.

**Prerequisites for the agents:** an agent CLI, installed and signed in. Quick setup uses [Claude Code](https://github.com/anthropics/claude-code). The agent scaffold, the launchers and the persona check also support [Codex](https://github.com/openai/codex) and [Antigravity](https://antigravity.google/docs/install?tab=cli) (`agy`), per agent, with `create-agent.sh --runtime codex` or `--runtime agy`; see "Codex and Antigravity agents" below for what differs.

Four more tools matter for one thing each, and are easy to miss because every
machine that has run this so far already had them:

| tool | needed for | without it |
| --- | --- | --- |
| ripgrep (`rg`) | `pnpm check:dashes`, and the test suite | four test failures, which do at least name ripgrep |
| python3 | the `inbox` CLI, which is how an agent replies (PyYAML, `python3-yaml`, for decision cards) | Deck runs fine; your agents cannot answer, or cannot send a card |
| tmux | tier 3, the live agent sessions | Deck degrades to a viewer over files |
| xxd | the `inbox` suite only, nothing at runtime | one test stops with `xxd: command not found` |

On Ubuntu or Debian, as root. If you are not root, type `sudo -i` for a root
shell first, paste the block, `exit`, and set the `export` line again in your
own shell. (`sudo` in front of single lines breaks the Node line and `export`.)
The block is:

```sh
apt-get update
apt-get install -y ca-certificates curl git ripgrep python3 python3-yaml tmux xxd
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
corepack enable
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
```

`curl` comes first on purpose. It is absent from a bare Ubuntu image and the
Node install is fetched with it, so on a truly clean machine you cannot follow
the Node instructions until you have it.

On macOS, unverified here, the equivalent is roughly:

```zsh
brew install node@22 ripgrep python3 tmux
corepack enable
```

`xxd` is missing from that line because macOS already ships it in `/usr/bin`,
and Homebrew has no formula for it. If yours has somehow gone, `brew install
vim` brings it back. This is the belief half of the document, not the observed
half.

Check Node. Anything on the `22.13` line or above, or 24 and above, is inside
the supported range; pnpm refuses to install on anything else and tells you
why. Do not check pnpm yet: that happens in section 2, inside your clone,
because outside it corepack has no `packageManager` field to read and fetches
the latest pnpm instead of the pinned one.

```sh
node --version
```

```text
v22.23.2
```

One last thing, and only if your shell has no locale set, which is normal
inside a container and on some minimal server images:

```sh
export LANG=C.UTF-8
```

That is not cosmetic. Live delivery into an agent's terminal decides whether
the model is busy by reading the spinner and counter glyphs in its pane, and
in the C locale that classification breaks: ten of the seventy cases in the
delivery suite fail there, and what a failure means at runtime is a message
that was never typed into a pane which was perfectly ready for it. Put it in
your shell profile rather than in one terminal, since the agents inherit the
environment of whatever launched them. A desktop machine almost certainly
already has this and can skip it.

Last, get the code. This is the step that makes the clone the prerequisites
above ask for:

```sh
git clone https://github.com/simon-inkie/inkie-deck.git && cd inkie-deck
```

While the repository is private, that clone needs you signed in to GitHub.
Install the GitHub CLI (`gh`) and run `gh auth login` inside the same Linux
environment you are installing in, which on Windows means inside Ubuntu, not in
PowerShell. Delete this paragraph once the repository is public.

This block is the one exception to "executed from this document": the rig
copies the tree into its container instead of cloning it, so it is declared
as skipped in `rig/install-plan.mjs`, with the reason.

## Quick setup

With section 1 done and the clone in place, one command does sections 2 to 5
for you. Run it as your own user, not as root (it refuses root), from the root
of your clone:

```sh
scripts/setup.sh
```

It checks everything first and writes nothing until the checks pass. Then it
installs, makes the four roots and `packages/deck/.env` (only if there is none),
builds, creates the two starter agents through `first-run.sh` (an assistant,
default `inkie`, and a platform agent, default `doctor`), optionally stores a
model API key, verifies both agents, starts Deck on loopback in a tmux session
called `deck`, and starts the two agents only if both verified. It asks for the
two names and whether you want to use an API key; both questions come before
anything is installed.

It does not install system packages (it names what is missing and points at
section 1, and never runs `sudo`), does not install, sign in to or pay for your
model CLI, and never answers that CLI's own prompts (sign-in, folder trust, key
approval). Those stay with you. It does not connect mail or a calendar, and it
does not install the memory loop (see [Optional: give the agent a memory
loop](#optional-give-the-agent-a-memory-loop)). On Windows, finish the [WSL
prerequisites](#windows-via-wsl) first; setup adds nothing Windows-specific.

For no prompts, accept the defaults and skip the key:

```sh
scripts/setup.sh --yes --no-key
```

On a machine with no model CLI that command exits 4: your roots, `.env` and
both agents exist, Deck is running at `http://127.0.0.1:4242`, and the agents
are not started. Install and sign in to the model CLI, then run it again. That
is also the rig's measured case (see [How this document is
tested](#how-this-document-is-tested)).

The flags are `--yes`, `--deck-home <dir>` (default `$HOME/deck`),
`--agents-home <dir>` (default `$HOME/agents`), `--assistant <name>`,
`--platform <name>`, `--model <id>`, `--no-key`, `--key-stdin`, `--replace-key`,
`--no-install`, `--no-build` and `--no-start`; `scripts/setup.sh --help` has
the rest. With no terminal on stdin it needs names (`--yes`, or both name flags)
and a key choice (`--no-key` or `--key-stdin`), and otherwise exits 2 before
writing anything.

Exit codes, in order of precedence when more than one applies:

| code | meaning |
| --- | --- |
| 2 | a flag is missing for an unattended run; nothing was done |
| 1 | failed: a check, the configuration, the scaffold, a key write, Deck, or the agent launch |
| 3 | a starter agent's persona check failed; the agents were not started |
| 4 | no usable model CLI, or verification could not run; Deck is running, the agents are not started |
| 5 | the agents are started and are waiting on you at their own prompts |
| 0 | Deck is running on loopback, both agents verified and started |

### What setup checks first

It resolves each setting the way Deck's launcher does: your environment first,
then an existing `packages/deck/.env`. It refuses a `HOST` that is not
loopback (and tells you whether it came from the environment or the file), a
port something else is listening on, a root that is missing from an existing
`.env`, and an `MC_USER` that is not a plain name. It never edits an existing
`.env`. Deck is started with `HOST=127.0.0.1` in its own environment, which
wins over the file, because Deck has no authentication (see the warning at the
top of this document).

### Model keys

A sign-in belongs to your model CLI, and setup only checks the CLI is there. A
key is optional. If you want one, setup reads it without echo (or one line from
stdin with `--key-stdin`), checks it contains only letters, digits, hyphens and
underscores, and stores it as an `export ANTHROPIC_API_KEY=` line in each
starter agent's `.env.secrets` (mode 0600), which is where the agent's terminal
and its persona check read it. It is never an argument and never printed.

A stored `ANTHROPIC_API_KEY` takes precedence over a subscription sign-in even
when you are signed in, and each agent's terminal asks you once to approve it.
Setup does not answer that question. An existing key is never replaced by a
rerun, with or without `--yes`; `--replace-key` (with a terminal or
`--key-stdin`) changes it.

Two files cannot be renamed as one step, so setup records the pair in
`.setup-key-pending` in the agents home first, works through private (0600)
staging and backup copies in the two agent homes, and removes the marker and the
copies when both are done. If a write fails it puts the first file back. If that
fails too, or setup is interrupted, the marker stays: the next run compares the
two stored keys without printing them, clears the marker if they match, and
otherwise stops with "mixed key state" before it verifies or starts anything, so
you run it again with `--replace-key` and enter the key once more. A lock directory (`.setup-key-lock`, same place) keeps two setup runs from writing keys at once; a run killed mid-write can leave it behind, and the message says to remove it. Setup refuses to store a key if the agents home, an agent's folder or its `.env.secrets` is a symlink, or if the agents home is inside a git work tree.

### The first conversation

When the agents start, the assistant's first message asks what you do and what
you would like help with first. It happens in the assistant's existing thread in
Deck, with no new page or endpoint: it writes with the `inbox` CLI and you answer
in the composer. It then asks the platform agent for a proposal of up to three
agents that fit, and puts that to you as a decision card (approve, change or
skip) before anything is created. The platform agent then checks each approved
name with `create-agent.sh --status` and creates only the ones that are absent,
as `member` agents that name the assistant. It starts only the ones that are
complete, and reports what was created and what was launched as two separate
lists.

The card and the cap of three are guidance in the agents' role briefs, not a lock
in code, and the agents' own runtime permission prompts still apply. Each new
agent stops at its own first-run prompt (folder trust) in its terminal view in
Deck, where only you should answer it. The decision card needs PyYAML for the
`inbox` CLI, which is why `python3-yaml` is in section 1's package line.

### Running it again

A healthy rerun repeats the checks, `pnpm install` and `pnpm build`, and skips
everything else: the `.env`, the roots, the agents, any stored key, a running
`deck` session and any running agent pane. If an earlier run ended at 3 or 4,
running it again is the repair: the agents are verified again and, if both now
pass, started. A half-created pair is completed by `first-run.sh`'s own recovery.

The manual path is sections 2 to 5 below, which are also the reference for
every step setup takes.

## 2. Install the dependencies

Everything from here runs from the root of your clone.

Check pnpm now, and not earlier. The pnpm version is pinned by the
repository's `packageManager` field, so corepack fetches that exact version the
first time you run it inside the clone, whatever you have installed globally.
Outside the clone there is no pin and corepack fetches the latest release,
which is not the one this repository was measured with. The first run is slower
than it looks like it should be, because of that download.

```sh
pnpm --version
```

```text
10.34.5
```

By default corepack asks `Y/n` before it downloads pnpm, and that prompt hangs a
script or a container. The `COREPACK_ENABLE_DOWNLOAD_PROMPT=0` line in section 1
switches it off, for that shell only. If you open a new terminal, either set it
again or answer `Y` when asked.

```sh
pnpm install
```

One warning is expected and harmless:
`Ignored build scripts: esbuild@0.27.7, esbuild@0.28.0`.

The README covers the project's checks, including `pnpm typecheck` (native
TypeScript), `pnpm typecheck:tsc` (the `tsc` fallback), and `pnpm test`.
They are not needed to run Deck.

## 3. Try it

```sh
pnpm dev
```

That keeps running until you stop it with Ctrl-C. Leave it, and open
<http://localhost:4242>.

The dev command is a sandbox, not a bare dev server. It wipes and reseeds
`.runtime/` from `fixtures/demo-inbox`, points all four required roots at that
directory, and pins the clock so the "Overdue" and "in 5h" labels on the demo
cards are a deliberate mix rather than whatever today happens to make them. It
touches nothing outside the repository, and it starts from scratch every time,
so anything you do in this tier is thrown away on the next start. Three
fictional agents (`quill`, `scribe` and `atlas`) are waiting in the queue with
cards to answer.

From another terminal, if you would rather check it than look at it:

```sh
curl -sS http://localhost:4242/ | grep -Eo 'scribe|atlas' | sort -u
```

```text
atlas
scribe
```

That is the check worth running, and a status code on its own is not. A dev
server started without the sandbox wiring also starts and also answers, with a
500 and an error page, and a 200 would still not tell you whether the fixtures
were seeded. "Something is listening" and "Deck is working" are different
questions, and only the second one matters.

Two things this tier does not do. It is reachable only from the machine it
runs on (the dev server binds loopback, and a container port map published
against it gets nothing); and it has no tmux, no agents, no Nudges and no
clock that moves. For those, keep going.

## 4. Run it for real

On Windows, the [Windows section](#windows-via-wsl) covers opening Deck in your
browser and keeping it running.

Deck reads and writes plain files. Four directories are required, they must be
absolute, and **the application creates none of them**: it refuses to boot
against a root that does not exist, on purpose, because the alternative is
silently creating an inbox somewhere you did not mean and then looking empty.

| variable | holds |
| --- | --- |
| `INBOX_ROOT` | the message threads, one directory per agent |
| `ATTACHMENTS_ROOT` | files uploaded through the interface |
| `PROJECTS_ROOT` | the kanban board's cards |
| `DATA_ROOT` | Deck's own state, such as queue positions |

They can be four directories under one parent. Nothing requires them to be
separate.

```sh
mkdir -p ~/deck/inbox ~/deck/attachments ~/deck/projects ~/deck/data
```

The launcher reads `packages/deck/.env`. Write it:

```sh
cat > packages/deck/.env <<EOF
INBOX_ROOT=$HOME/deck/inbox
ATTACHMENTS_ROOT=$HOME/deck/attachments
PROJECTS_ROOT=$HOME/deck/projects
DATA_ROOT=$HOME/deck/data
EOF
```

`packages/deck/.env.example` is the annotated reference for that file and lists
the optional settings (a port, the activity panel, an agent allowlist). Copy
from it if you would rather start there. Two notes on it that have cost people
time:

- The file to write is `.env`. `.env.production` is read by nothing in this
  repository; it exists for a systemd `EnvironmentFile`, and a value you put
  there will not reach the application when you start it by hand.
- Anything already set in your environment beats the file. That is what makes
  a systemd unit's `EnvironmentFile` authoritative, and it is also how you
  override one value for one run.

### Who Deck thinks you are

Deck writes your side of every thread to `<agent>/inbox/<your name>.md`, and
`MC_USER` is that name. It defaults to `alex`, which is a leftover and not a
sensible default for anyone. Set it now rather than later: changing it after
you have used Deck leaves the old thread files behind under the old name, and
the agents keep writing to them.

```sh
echo "MC_USER=$(id -un)" >> packages/deck/.env
```

That writes the name into the file rather than into your shell, on purpose.
The next tier has you opening terminals, and a name that only exists as a
shell variable does not survive one.

### Reaching it from another machine

When `HOST` is not loopback, anyone who can open this page can message your
agents and, if enabled, create scheduled jobs on this machine.

Skip this unless you need it. Deck binds loopback by default and that default
is doing real work: **there is no authentication in front of the thing you are
about to publish**, so read the warning at the top of this document again
before you run this, and put access control (a reverse proxy, or a private
network that authenticates its own members) in front of it.

```sh
echo "HOST=0.0.0.0" >> packages/deck/.env
```

This is also the line a container image needs. A published port against a
loopback bind is silent: you get a connection refused from a launcher that is
still reporting a healthy start.

### Build, and start

```sh
pnpm build
```

```sh
(cd packages/deck && node scripts/start-production.mjs)
```

That keeps running too. The subshell is deliberate: the launcher must run with
`packages/deck` as its working directory (it resolves the build and the `.env`
relative to it), and the brackets mean your own shell stays where it was.
It also stops when you close that terminal; [Keep it running](#keep-it-running)
below has two ways round that.

It prints every root it resolved, and whether it found a `.env`, before it
listens. A missing or relative or nonexistent root is fatal at that point and
names itself, rather than starting and returning errors for every request.

```text
[prod] .env loaded from /home/you/inkie-deck/packages/deck/.env (process environment wins)
[prod] INBOX_ROOT=/home/you/deck/inbox
[prod] app on http://127.0.0.1:4242
[prod] HOST=127.0.0.1 is loopback, so ONLY this machine can reach the app.
```

Check it, from another terminal:

```sh
curl -sS http://localhost:4242/ | grep -Eo 'Nothing needs you|No agents yet' | sort -u
```

```text
No agents yet
Nothing needs you
```

An empty Deck is the correct first screen here, and those two lines are it.
Agents appear once something writes into `INBOX_ROOT`, which is tier 3.

**Do not use `pnpm start` for this.** It exists, it starts, and it then answers
500 for every request until you configure it, because it goes straight
to the web server and skips the launcher that validates the roots and loads
the `.env`. `node scripts/start-production.mjs` is the supported way in.

### Keep it running

Started as above, Deck is a child of your terminal and dies with it. Two ways
to keep it up, from the root of your clone, after `pnpm build`. Use one, not
both: they want the same port.

**In a detached tmux session.** Quick, needs nothing but tmux, and survives
closing every terminal. Nothing restarts it if it crashes, and nothing starts
it again after a reboot.

```sh-manual
tmux new-session -d -s deck -c "$PWD/packages/deck" node scripts/start-production.mjs
```

`tmux attach -t deck` shows its output; `Ctrl-b d` leaves it running again.
`tmux kill-session -t deck` stops it. The session is called `deck` so it stays
out of the `agents` session tier 3 creates.

**As a systemd user service.** `packages/deck/deploy/deck.service` is an
example unit: `Restart=always`, so a crash is restarted, and logs go to the
journal. Install it with your clone and your Node filled in:

```sh-manual
mkdir -p ~/.config/systemd/user
sed -e "s|@DECK_DIR@|$PWD/packages/deck|g" -e "s|@NODE_DIR@|$(dirname "$(command -v node)")|g" \
  packages/deck/deploy/deck.service > ~/.config/systemd/user/deck.service
systemctl --user daemon-reload
systemctl --user start deck
systemctl --user status deck
```

It reads the same `packages/deck/.env` as a hand-run start, so nothing else
needs configuring. `packages/deck/.env.production` is the unit's optional
`EnvironmentFile`: a value there beats `.env`.

A user service still stops when you log out, unless your user lingers:

```sh-manual
loginctl enable-linger "$USER"
```

If that is refused, run it with `sudo`. After a rebuild, `systemctl --user
restart deck` serves the new build, and `journalctl --user -u deck` shows the
launcher's output. `systemctl --user enable deck` also starts it when your
user manager starts, but starting Deck on boot is a separate piece of work and
has not been checked here. On WSL, systemd has to be switched on first; see
the [Windows section](#windows-via-wsl).

### Voice dictation (optional)

Skip this unless you want the microphone in the compose box. Voice needs a
Deepgram API key and nothing else when the browser runs on the same machine as
Deck. None of the blocks in this section is executed by the rig (see
[How this document is tested](#how-this-document-is-tested)), and they are
tagged `text` for that reason.

**On the machine Deck runs on.** Put the key in `packages/deck/.env`:

```text
DEEPGRAM_API_KEY=your-key-here
```

Start Deck as above and open `http://localhost:4242/`. The launcher prints
`[prod] DEEPGRAM_API_KEY present`. Voice is a second listener on port 5176,
bound to loopback, and it accepts WebSocket upgrades from
`http://localhost:$PORT` (4242 unless you set `PORT`) and the dev port
`http://localhost:5174` with no further settings.

Without a key the microphone is disabled and reads "voice disabled: no
DEEPGRAM_API_KEY". The launcher prints `ABSENT - voice disabled` too.

**From another machine over Tailscale.** The browser sends the address bar's
origin with every WebSocket upgrade, and the proxy rejects any origin it was
not told about. Browsers also refuse the microphone on a page that is not a
secure context, which `http://` over a tailnet address is not, and refuse a
plain `ws://` connection from an `https://` page. So the working shape is
HTTPS for Deck and `wss://` for the proxy, both terminated by `tailscale
serve`, with Deck and the proxy left on loopback:

```text
tailscale serve --bg --https=443 http://127.0.0.1:4242
tailscale serve --bg --https=8443 http://127.0.0.1:5176
```

Then tell the proxy about the origin and the browser about the proxy, where
`<tailnet-host>` is your machine's full tailnet name, as `tailscale status` and
the admin console show it:

```text
VOICE_ALLOWED_ORIGINS=https://<tailnet-host>
VOICE_PROXY_URL=wss://<tailnet-host>:8443/voice
```

Restart the launcher and open `https://<tailnet-host>/`. Note the origin
has no port, because the page is on 443. `VOICE_ALLOWED_ORIGINS` replaces the
default rather than adding to it, so list `http://localhost:4242` as well
(comma-separated) if you also use Deck on the machine itself.
`VOICE_PROXY_HOST` stays unset here: `tailscale serve` reaches the proxy over
loopback. Set it (to `0.0.0.0`, or a specific address) only if something
that is not on this machine must connect to the proxy directly, and remember
the proxy spends your Deepgram key for anyone who is allowed in.

The `tailscale serve` flags vary between Tailscale versions; check `tailscale
serve --help` against the lines above. They have not been run here.

**If the microphone does nothing.** Look at the proxy's output. A line reading
`rejected upgrade from origin "..."` names the exact origin to put in
`VOICE_ALLOWED_ORIGINS`. No line at all means the browser never reached the
proxy, which points at `VOICE_PROXY_URL` or at the proxy's bind address.

## 5. Bring your agents to life

On Windows, read [The model CLI](#the-model-cli) in the Windows section before
you install the CLI.

**This tier is manual, and cannot be otherwise from here.** An agent is a
model CLI running in a terminal. You have to install that CLI, sign in to it,
and pay for it, on the machine Deck runs on. Nothing in this repository can do
any of those three for you, and a container cannot be handed a subscription.

The tooling here is deliberately built so that the boundary is visible rather
than assumed: everything below runs and reports honestly on a machine with no
model CLI at all, and the step that requires one refuses to claim success.

### Name your assistant (first run)

On a new install, start here. One command asks for two names, an assistant you
talk to (default `inkie`) and a platform agent that changes the setup (default
`doctor`), and creates both with `create-agent.sh`:

```sh
export AGENTS_HOME=$HOME/agents
export INBOX_ROOT=$HOME/deck/inbox
packages/base/bin/first-run.sh
```

For no prompts, pass `--assistant <name> --platform <name>`; `--model <id>` and
`--no-verify` go through to `create-agent.sh`. Both names are checked before
either agent is created. Each agent is told its role and the other's name, and
Deck pins the assistant above the agent list. Re-running is safe: an agent that
already exists is skipped, and a run that stopped after one agent creates the
other under the peer name the first one already holds.

Verification is as below: with a working `claude` CLI each agent is `VERIFIED`;
without one, or with `--no-verify`, both are created and report
`CANNOT VERIFY` (exit 4). The proof shows the persona loaded, not that the role
brief is right, so ask each agent what its job is once.

### Create an agent

An agent lives in two places that have to agree: a home directory holding its
persona files, and an inbox directory under `INBOX_ROOT`. Miss the second and
you get an agent your launcher can see and Deck cannot.

```sh
export AGENTS_HOME=$HOME/agents
export INBOX_ROOT=$HOME/deck/inbox
packages/base/bin/create-agent.sh inkie --role "keeps the notes"
```

`inkie` is only an example: any lowercase name works (letters, digits and
hyphens).

**Choose a model, because it is a cost decision.** Without `--model <id>` the
agent uses your model CLI's own default, which on a paid plan can be a more
expensive model, and several always-on agents add up. Pass
`--model <id>` (for example `--model claude-sonnet-5-5`) to write the agent's
`.model` file; `boot-agents.sh` and `workspace.sh` launch the runtime with
`--model <id>` from it. You can also edit `$AGENTS_HOME/<name>/.model` by
hand at any time. It must be a plain id (letters, digits, dots, colons and
hyphens); the launchers ignore anything else and say so.

That writes both, links the `inbox` CLI onto your `PATH`, and then tries to
prove the persona actually reached the model by asking the agent, in one
non-interactive turn, for a boot phrase that exists nowhere but its own
identity file. **With no model CLI installed, that last step cannot run**, and
the script says so and exits 4:

```text
create-agent: CREATED inkie
  persona files  /home/you/agents/inkie
  inbox          /home/you/deck/inbox/inkie/inbox
  boot phrase    boot-6ed9a08da2961594

create-agent: CANNOT VERIFY inkie
  No `claude` on PATH, so there was nothing to ask.
```

#### Codex and Antigravity agents

`--runtime` picks the agent CLI per agent: `claude` (the default), `codex` or
`agy`. The shared persona files are the same for all three; what differs is
the file each CLI reads, because neither Codex nor Antigravity follows the `@`
imports in `CLAUDE.md`:

```text
packages/base/bin/create-agent.sh quill --runtime codex --model gpt-5.5
packages/base/bin/create-agent.sh fern --runtime agy
```

- **Codex** gets `AGENTS.md`, which Codex reads on its own, and
  `.codex/hooks.json`. Its SessionStart hook (`bin/codex-persona-inject`) puts
  `IDENTITY.md`, `SOUL.md`, `USER.md` and `TOOLS.md` into the session at every
  start, resume and compaction, with a count of unread messages; its
  per-prompt hook (`bin/codex-user-prompt-submit`) mentions new unread
  messages. Codex runs a folder's hooks only after you trust them: on the
  agent's first launch, attach and approve them. Creation refuses a symlinked
  `.codex` directory or an existing `hooks.json` (including a symlink),
  leaving it untouched.
- **Antigravity** gets `GEMINI.md`, with the persona files copied into it
  between generated fences by `bin/sync-gemini-includes.sh`. The launchers run
  the sync before every start, so edit the source files, never the fences.
- Both get `.inbox-root`, which the launchers pass to the CLI as
  `INBOX_ROOT`, since neither reads `.claude/settings.json`.

The proof is different too. For these two, `create-agent.sh` runs local checks
that call no model. For Codex, they validate the hooks JSON and compare the
commands for both events to the exact scaffolded commands without running
them, even with `--no-verify`. For Antigravity, they refresh `GEMINI.md` in
place and check that the file carries the boot phrase. Passing these checks
still exits 4, because no model was asked. A live probe uses a turn of your
plan or API credit, so it is opt-in: add `--live-probe` (or set `CREATE_AGENT_LIVE_PROBE=1`) to run
`codex exec` or `agy -p` from the agent's home. For Codex, approve the hooks
on a first interactive launch before the live probe, or it reports FAILED.
Memory hooks are Claude Code only and stay off for the other two.

| | Claude Code | Codex | Antigravity |
| --- | --- | --- | --- |
| Persona file it reads | `CLAUDE.md` with imports | `AGENTS.md` plus a SessionStart hook | `GEMINI.md`, persona inlined |
| Resume on relaunch | pinned session id | newest session for its home | newest conversation for its home |
| Check without a model | imports resolve | both hook commands match the scaffold | refreshed `GEMINI.md` carries the boot phrase |
| Live proof | default | `--live-probe` | `--live-probe` |
| Memory hooks | when configured | no | no |
| Day-one first message | yes | no | no |

Exit 4 means created but unproven, and it is not a pass. Once you have a model
CLI installed and signed in, `packages/base/bin/create-agent.sh --verify-only
inkie` re-runs only the proof. It exits 0 only if the phrase comes back, which
is a stronger statement than any check of the files: a persona that never
reached the model leaves behind exactly the same directory tree as one that
did.

Reload Deck and the agent is there. Nothing needs restarting; the agent list
is the set of directories under `INBOX_ROOT`.

### Optional: give the agent a memory loop

Memory is optional, and Deck works the same without it. If you have the
separate memory-layer project checked out and built (its own README covers
that, and its basic loop needs only the model CLI you already have: no extra
key, no Docker), tell `create-agent.sh` where it is, before creating agents:

```sh-manual
export MEMORY_LAYER_ROOT=$HOME/src/memory-layer   # any name, any place
export USER_NAME=$(id -un)                        # optional, names you in memory prompts
packages/base/bin/create-agent.sh wren --role "keeps the notes"
```

For each agent that wires the memory hooks into that agent's own
`.claude/settings.json` (not your global one, see the checks below), records `USER_NAME` there, and
seeds the agent's memory silo, by running the checkout's own non-interactive
install command. The silo is picked by the `AGENT_NAME` Deck already writes
into that file. The last line of the output (printed after any verification) says which way it went:

```text
create-agent: memory on (hooks wired in /home/you/agents/wren/.claude/settings.json, silo seeded)
```

Memory is wired last, after the persona check, so that check's own turn is not
recorded as the agent's first memory. When it is not wired, the last line reads
`create-agent: memory off (reason)`, a warning explains why, and the agent is
created exactly as before. Memory never changes the exit code. The reasons:

- no checkout configured, `--no-memory`, or a checkout that is not built and
  installed (settings are not touched);
- the agent's `.claude/settings.json` already says `env.AGENT_NAME` is another
  agent, which would seed one memory silo and send the hooks to a different
  one (settings are not touched; fix the name and run the checkout's install
  command with `--agent <name>`);
- the persona check failed or the model CLI errored, so a broken agent is not
  wired (once fixed, run the checkout's install command with `--agent <name>`);
- the checkout's install command failed. Deck puts the agent's previous
  settings back, so no hooks are left active, and says so. If it cannot put
  them back the line starts `off (PARTIAL: ...)`: open the agent's
  `.claude/settings.json` and remove the memory hooks, or fix the cause and
  re-run the install command. The silo may be partly seeded; the command is
  idempotent;
- the run was interrupted (Ctrl-C, SIGTERM, SIGHUP). The last line always says
  what state that left: before wiring nothing is wired; during the install the
  settings are restored; after the install returned it says `on (interrupted
  before USER_NAME was stamped)` or `PARTIAL`, and names what to check;
- the agent's `.claude` directory is not inside the agent's own directory (the
  agent home is a symlink, or `.claude` resolves elsewhere), or it holds a
  symlink or a hard link (a regular file with more than one link). The
  checkout's install command writes a temporary file and a backup beside
  `settings.json` and follows links, so a planted link could redirect a write
  onto another file, such as a global settings file. Nothing is written;
  remove the link and run the install command with `--agent <name>`;
- the agent's `.claude` already holds files named `settings.json.<something>`
  that this run did not create. A new agent has none, and that is where a
  planted link would hide. Remove them and run the install command.

Deck checks again after the install and, if a link appeared meanwhile, reports
`PARTIAL` rather than `on`. That later check runs after the install's write, so
it reports a link planted in the instant between the first check and the write;
it cannot prevent it. The protection is against links already in place, not
against another process on your account racing the install.

Separately, `create-agent.sh` refuses to create an agent (a scaffold error,
before anything is written) when the agent home, its `.claude` directory or its
`.claude/settings.json` is a symlink, resolves outside `<agents home>/<name>`,
or when `settings.json` is a hard link (link count above one); when the agent's
settings are the same file as your own global settings
(`$HOME/.claude/settings.json`, or `$CLAUDE_CONFIG_DIR/settings.json` when
set), by resolved path or by inode; and when `AGENTS_HOME` contains a `..`
component, because the shell and the check can resolve that differently when a
symlink comes before it. These checks run in node and fail closed: if they
cannot run, nothing is written.

What the checks do not promise. They look at one moment, they know only the
two global locations above, and they trust everything on your account:

- a link planted between the check and the write (see the note on timing above);
- a global settings file that is a dangling symlink pointing at the agent's
  not-yet-created settings is not recognised as the same file;
- the agent's own `settings.json` is still merged in place by `create-agent.sh`
  (the check comes first, and a name that was checked is not re-checked at the
  write), whereas the memory step's `USER_NAME` write goes through a new file
  and a rename.

This is a same-user threat model: it protects against mistakes and links that
are already there, not against another process on your account.

After a successful memory install the checkout's installer leaves a one-time
backup of the previous settings next to `settings.json` (a `settings.json.*.bak`
file in the agent's `.claude`). It is the installer's own file and is kept on
success; delete it when you no longer want it. After a failed install Deck
restores the settings and removes any backup or temporary file the failed run
created. If Ctrl-C reaches the installer itself, Deck restores the settings and
reports it, and its temporary copy of the settings is deleted.

Not covered here: semantic search (it needs a vector database and a paid
embeddings key), the background watcher, and a persona file for the memory
layer's session-start hook. Those are tracked as follow-ups on issue #21.

### Start the sessions

```sh
packages/base/bin/boot-agents.sh
```

That starts a tmux session named `agents` with one window per agent home,
named after the agent, and launches each agent's runtime in its window. Run it
again and an agent whose pane already has its runtime running in it is left
alone; one whose runtime has exited is relaunched, which is what makes this
safe to fire on boot.

On an agent's first launch, `boot-agents.sh` starts a new session and gives it
a first message: do your day-one steps from your persona files, then say hello.
Expect it to fill in `IDENTITY.md` and `SOUL.md`, and it may ask you questions
about itself. The message is sent once per agent: the launcher leaves a
`.first-boot-done` file in the agent's home, and an agent whose `IDENTITY.md`
is already written never gets it. If a launch dies before the agent has
recorded the message, delete `.first-boot-done` to send it again. An agent
armed with `.auto-arm-watcher` is not told to arm its monitor on that first
boot, because it is busy with day one. Once its first turn is done, exit the
agent's runtime and run `boot-agents.sh` again to relaunch and arm it. (Running
it while the runtime is still up leaves the agent alone and arms nothing.)

`boot-agents.sh` and `workspace.sh` also run `tmux set -g focus-events on`
before starting any pane, which stops Claude Code showing its focus-events
hint. It is a tmux server option with no per-session form, so it applies to
the whole tmux server, including any other sessions on it. Add
`tmux set -g focus-events off` after a boot if you want it off.

Each agent runs the CLI named in its `.runtime`. A Codex agent looks up the
newest session for its workspace in the home it launches with: exported
`CODEX_HOME` first, then the agent's configured provider home, then `~/.codex`.
It starts fresh if that home has no matching session or boot detects a failed
resume. An Antigravity agent resumes the newest conversation started in its
own home (`agy --conversation <id>`, never the global `--continue`), after its
`GEMINI.md` is re-synced. Neither has its own approval prompts switched off.

On first boot, attach to the session and answer any runtime setup prompts
manually. Folder trust defaults to No: do not press Enter while No is
preselected. Choose Yes manually only if you trust the folder. Claude Code
uses its default permission mode (currently auto) unless you configure it.
The resume picker and fullscreen offer also need a manual answer.
The launcher reports ready launches and confirmed monitors separately; a
live process alone does not prove a fresh launch is ready. Readiness waits
up to 45 seconds per fresh launch; set `BOOT_READY_SECS` to a positive integer
for slower machines. Recognised setup prompts stop the wait early.

Exit statuses:

- `0`: fresh launches are ready and requested monitors are confirmed.
- `1`: a launch failed.
- `3`: readiness or monitor confirmation is pending.

Callers that treat non-zero statuses as failures, including a default systemd
boot unit, will report failure even when a healthy first boot only needs a
manual trust answer. A unit that accepts this pending state can set `SuccessExitStatus=3`.
After answering prompts, run the launcher again to check known setup dialogs.
Existing sessions, including busy conversations, are left running and are
not automatically re-armed. If a fresh launch exceeds the readiness budget
or stops at a setup prompt, its opted-in monitor is not armed on that run or
on a later re-run: once the composer is ready, type `arm your monitor` manually.
Monitor instructions are sent once, with confirmation polled from bounded
pane history to avoid duplicate watcher requests.

```sh
tmux list-windows -t agents -F '#{window_name}'
```

```text
inkie
```

The window is real whether or not a model CLI is installed. With none, the
pane holds the shell and the error, which is exactly what you should see at
this point on a machine with no subscription:

```sh
tmux capture-pane -t agents:inkie -p | grep -v '^$' | tail -5
```

```text
you@host:~/agents/inkie$ printf '\033]0;inkie\007'; [ -f /home/you/agents/inkie/.env.secrets ] && . /home/you/agents/inkie/.env.secrets; claude --session-id 0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d -n inkie
-bash: claude: command not found
you@host:~/agents/inkie$
```

(The blank lines are dropped because a tmux pane is padded to its full height,
and `tail` on the raw capture returns the padding rather than the text.)

Deck reads that pane live. Open the agent's thread and switch to the terminal
view, or `curl -sS "http://localhost:4242/threads/inkie?view=tmux"`, and the
contents of the pane are in the page. That is the one check in this area worth
trusting. Deck's tmux surface is switched on by an environment variable that
defaults to on and never looks for the binary, so the terminal view being
offered in the navigation is not evidence that tmux exists on the machine. The
contents of a pane cannot be produced that way.

### Send a message, and answer it as the agent

From the browser, open the agent's thread and type. Without a browser, this is
the same request the interface makes:

```sh
curl -sS -X POST http://localhost:4242/threads/inkie \
  --data-urlencode 'intent=compose' \
  --data-urlencode 'body=Welcome aboard. What do you make of the protocol doc?' \
  -o /dev/null -w '%{http_code}\n'
```

```text
200
```

That writes a block into `$INBOX_ROOT/inkie/inbox/<your MC_USER>.md`. An agent
reads and answers with the `inbox` CLI, which is the half of the protocol that
lives in the terminal, where the agent is. Standing in for the agent by hand:

```sh
export AGENT_NAME=inkie
export INBOX_ROOT=$HOME/deck/inbox
ME=$(sed -n 's/^MC_USER=//p' packages/deck/.env | tail -1)
: "${ME:?is empty. No MC_USER in packages/deck/.env; set it in tier 2 first.}"
packages/base/bin/inbox unread
packages/base/bin/inbox read
packages/base/bin/inbox reply "$ME" --subject "re: welcome" --body "Read it. The block header is the whole protocol."
```

```text
<you>: 1 unread
from <you> @ 2026-08-13T21:18:18Z - Message
Welcome aboard. What do you make of the protocol doc?

replied to <you>
  push: skip:no-window (persisted, not pushed)
```

(`<you>` is your `MC_USER` name. The CLI prints the real one.)

`AGENT_NAME` and `INBOX_ROOT` are what the CLI refuses to run without, and a
real agent gets both from the `.claude/settings.json` that `create-agent.sh`
wrote for it. You are setting them by hand only because you are typing on its
behalf. Nothing above needs anything installed beyond `python3`; sending a
message whose body opens a card metadata region additionally needs PyYAML, and
the CLI says so rather than sending the card unchecked. See the base package
README for that and for the optional bare-reference check.

The name is read back out of `packages/deck/.env` for a reason worth stating,
because it is the one step here that fails quietly. This tier is followed
across several terminals, and a variable exported in tier 2 is gone in a new
one. `inbox reply` with an empty correspondent does not complain: it exits 0,
prints `replied to ` with nothing after it, and writes a thread file that
belongs to no one, which Deck then never shows you. Deriving the name from the
file that Deck itself reads is the only version of this step that cannot be
half-done.

That `push: skip` line is the live-delivery half declining, and declining
correctly. `inbox reply` writes the message to disk first and only then tries
to type a notification into the recipient's terminal, so a refused push is
never a lost message. `no-window` here means the recipient is you, and you are
not an agent with a tmux window; when the recipient is an agent whose pane
holds a bare shell rather than a model CLI waiting for input, the reason reads
`unknown-format` instead. Typing into something it cannot recognise is not a
guess it is willing to make.

The reply is now in the thread, which you can see from Deck:

```sh
curl -sS http://localhost:4242/threads/inkie | grep -c 'the whole protocol'
```

### Scheduled nudges

The Nudges page (`/scheduler`, linked from the top bar) sends an agent a
prompt, or runs a shell script, on a cron schedule. Each nudge is a line in the
system crontab of the user Deck runs as, tagged `# MC-CRON:<id>`, plus a script
in `~/agents/<agent>/bin/`. Lines without that tag are never touched. It needs
`crontab` on `PATH`; without it the page says so and saves nothing. An agent
nudge is pasted into the agent's window in the `agents` tmux session, and if
that session is not running when it fires, the run is skipped and the page
shows it as fired but not delivered.

Nudges is on by default. To edit nudges, connect directly from the Deck
machine over loopback (`127.0.0.1`, `::1` or `::ffff:127.0.0.1`). Other
visitors can view the page but cannot change anything. Deck uses the socket
address, never a forwarded address; requests carrying forwarding headers
are read-only by default. If a reverse proxy connects over loopback, make
sure it adds a forwarding header such as `X-Forwarded-For`, or disable
Nudges: without that header Deck cannot distinguish the proxy from a local
visitor.

To allow remote writes deliberately, set `MC_CRON_ALLOW_REMOTE_ADMIN=1` in
the server environment (or `packages/deck/.env` for the documented launcher)
and restart Deck. Only do this behind access control you trust: anyone who
can reach Deck can then schedule jobs as the user running it.

To turn Nudges off entirely:

```sh
echo "MC_CRON_ADMIN_ENABLED=0" >> packages/deck/.env
```

That removes the nav entry, makes the page and `api/cron` answer 404, and
refuses every write. `pnpm dev` already turns it off for the sandbox.

### What is still missing, and it is the important part

Everything above works with no model CLI. What none of it proves:

- that a real agent boots, loads its persona and knows who it is;
- that a message pushed into a live pane arrives in a model's context;
- that the agent replies without being typed for.

Those need the CLI installed, authenticated and billed, and that is the actual
front door to this tier. The rig measures everything up to it and stops,
rather than reporting a green run over the half that is not there.

The middle one of those three is not only waiting on a subscription, and it is
worth separating out rather than leaving it inside a sentence about billing.
Live delivery into a pane is proven in the REFUSING direction and only there.
The gates refuse a recipient with no window, a runtime they do not recognise, a
pane with someone's half-typed text already in it, and a pane whose shape they
cannot read at all; you saw one of those refusals a moment ago, as
`push: skip:no-window`. The delivering direction has no test behind it. The
delivery suite classifies pane text the test itself supplies, with every real
keystroke suppressed, so nothing anywhere establishes that a pane the gate
called READY receives the keys and receives them whole. That needs a stub agent
sitting in a pane to be typed at and to report back what it got, and there is
not one here yet. It is on the limitations list below, where a coverage gap
belongs, rather than being carried by the sentence about model subscriptions,
which would put it down to the wrong cause.

## Known limitations

Written down rather than discovered later. Each entry says what was measured,
by whom (the rig, or by hand) and when. "Checked" means someone read the code
or ran the command by hand on 2026-10-12, not that the rig covers it.

**No authentication.** Repeated here because it belongs on any list of this
kind. See the top of this document. Checked: the application has no login or
session routes (`packages/deck/app/routes`).

**On WSL, `claude` can resolve to a Windows binary.** PATH often includes
Windows directories, so `command -v claude` may return a path under `/mnt/c/`
or ending in `.exe` or `.cmd`. The boot, workspace and create-agent scripts
print a warning naming that path and carry on; they do not stop, because a
Windows binary can still work through WSL interop. If agents fail to start,
install the Linux build inside WSL or put its directory earlier in `PATH`.

**A complete, valid header quoted inside a message body splits that message
in two.** Fixed on 2026-08-14, and this is what is left of it. Both readers,
the python3 CLI and the web application, used to take a block boundary off
every line starting with `## `, so an ordinary markdown heading someone typed
ended their message there and everything after it disappeared on read. Only
lines that actually parse as a header bound a block now, in both, and the
corpus records that used to hold the wrong answer are gone.

What remains is narrower and is not data loss: a line carrying a real
timestamp, sender, status and subject parses as a header wherever it appears,
including inside a code fence. Quote one in a message and the text after it is
shown as a separate message from whoever the quoted header names. Nothing is
lost, it is attributed to the wrong sender, and no reader-side rule can
separate a quoted header from a real one with certainty. Closing it means
changing what writers put on disk, so it stays on this list rather than being
guessed at on read. Checked: the `inbox` parser still splits a message at a
quoted header inside a code fence, and does not split at a plain `## heading`.

**The two readers of the protocol do not agree everywhere, and the list of
where is a file rather than this paragraph.** The python3 CLI and the web
application both implement `packages/base/docs/protocol.md`, and every place
either one departs from it is recorded as a deviation on a case in
`packages/base/conformance/corpus.json`, with the reason written out. Both
suites run that corpus, so a deviation that gets fixed without its record being
removed goes red, and so does a new one that arrives without a record. Read
that file for the current set rather than trusting a count in prose. Every
deviation on it today is in the application, and each is the same kind of
thing: its header grammar and the protocol's disagree, in one direction or the
other. A header the protocol admits and the application rejects means a message
that is on disk and never renders, which is the direction worth knowing about
if you are writing your own client.

**Sending to an agent with the CLI does not reach the file Deck reads.** The
CLI is symmetric: `inbox reply <them>` writes into the SENDER's own thread
file, `$INBOX_ROOT/<you>/inbox/<them>.md`, on the assumption that each pair's
two files are one file with two names. Nothing here creates that pairing. So
the agent-to-human direction works, because an agent writes into its own inbox
which is exactly where Deck looks, and the human-to-agent direction with the
CLI writes a file Deck never reads and the agent never sees. It fails silently
in both halves: your `inbox reply` reports success, and the agent's `inbox
unread` says there is nothing. That is why the walkthrough above sends from
Deck and replies from the terminal rather than the other way round. Pairing the
two files, at creation or on first contact, is an open design question rather
than a setting. Checked: `inbox reply quill` as `me` wrote
`me/inbox/quill.md` and `quill`'s `inbox unread` said there was nothing.

**No automated test proves that a message typed into a READY pane lands.** This
is the coverage gap named at the end of tier 3, repeated here because this is
where a reader looks for it. By hand it has been seen working: on WSL 2 with
Ubuntu 24.04, on 2026-09-27, a message sent from Deck reached a live agent, and
the agent replied within about ten seconds. That was one run, by a person, and
the rig has not measured it. The refusals are covered from every angle, and one
of them (`no-window`, described above) is exercised on every rig run, with the
exact wording recorded in the report - it declines before a pane is ever
inspected, since the walkthrough's recipient is you rather than an agent. The
other outcome, where the gate decides the pane is ready and types, has no test
behind it anywhere: the
delivery suite runs its cases against pane text the test itself supplies, with
every real keystroke suppressed, and the rig has no agent to be typed at. So
"the message arrived in the pane, and arrived whole" is, to the rig, a belief.
It is probably a correct one, since `inbox-push` sends the text and the Enter as
separate keystrokes and then re-reads the pane to confirm the paste landed, and
none of that is the same as having measured it.

Worth knowing while you are here: that careful path is the CLI's. Typing into a
pane from Deck's own terminal view is a different one
(`packages/deck/app/routes/api.tmux-send.tsx` into `sendKeysToWindow`). It
checks the window name and the live window list, refuses to type when the
composer is not clean, and after the Enter re-reads the pane and reports
"sent, could not confirm" rather than success when it cannot see the message
leave the composer. That check was added in #43, and unit tests cover it with
supplied pane text, so it has the same limit as the rest of this entry.

Closing the gap means a stub agent that can be started in a pane, typed at, and
asked what it received. That is a named follow-up (`rig/README.md` still lists
the stage as not built) and deliberately not part of this phase, because it
wants the container and process-supervision groundwork recorded in
`rig/container-image-note.md` first.

**The browser test suite is not a guarantee.** `pnpm -C packages/deck e2e`
runs Playwright journeys that have real, currently un-diagnosed flakes. It is
not in CI. Treat a green e2e run as encouraging and a red one as worth
reading, and rely on `pnpm test` for the claim that the tree is sound. Checked:
`.github/workflows/ci.yml` has no e2e step.

**`boot-agents.sh` always uses a tmux session named `agents`.** The session
name is not configurable in the launcher, while the application reads
`MC_TMUX_SESSION` (defaulting to the same name). If you already run something
in a session called `agents`, Deck's launcher will add its windows to your
existing session rather than starting its own. There is no flag for this yet;
until there is, either rename your session (`tmux rename-session`) or run Deck
on a machine or user account that does not have one. Pointing Deck at a
differently-named session with `MC_TMUX_SESSION` works for the application,
but the launcher will not follow it. Checked: the name is fixed at
`packages/base/bin/boot-agents.sh:57`.

**Typography needs the internet at runtime.** The page links a stylesheet for
three fonts from Google Fonts, so a browser with no route to it renders in
fallback fonts with no explanation. That is the browser's connection, not the
server's. Until #32 was fixed the fonts never loaded even when online, because
the `@import` that was meant to fetch them was dropped; if you see fallback
fonts on a connected browser now, that is a regression worth reporting. With the
optional subsystems below switched off and nobody subscribed to browser
notifications, nothing else in Deck itself depends on egress. The agents' model
CLIs still need their provider, as tier 3 says. With the optional subsystems
on, image descriptions call Google's API and voice connects to Deepgram; web
push, once a browser has subscribed, sends to that browser's push service.
Checked: the stylesheet is still linked from Google Fonts in
`packages/deck/app/root.tsx`.

**Optional subsystems are unverified here.** Voice dictation (Deepgram) and
image descriptions (Gemini) need keys, are off without them, and are not
exercised by the rig. As of 2026-10-12 no one has run them by hand for this
list either; only the no-key path of the voice proxy was read, in
`packages/deck/server/voice-proxy.mjs`. They degrade rather than fail: the
voice proxy starts without a key and tells the client it has none.

**Web push needs no operator key; a subscription switches it on.** Deck makes
its own VAPID keypair: the first request to `/api/push-subscribe` (a plain GET
is enough) writes `vapid-keys.json` under the data root
(`getVapidKeys` in `packages/deck/app/lib/push.server.ts`). Nothing is sent
until a browser subscribes, which stores its endpoint in
`push-subscriptions.json`. From then on, while the production launcher's
`push-watcher.mjs` is running, newly appended messages from a non-user sender
in threads the watcher has already baselined are posted to each stored
endpoint, which is the push service of that browser's
vendor, so those hosts must be reachable from the server. With no
subscription the watcher polls the inbox files and sends nothing. Like the
others it has not been run for this list; this entry was read from
`push.server.ts` and `push-watcher.mjs` on 2026-10-15.

Voice is a SECOND listener, on its own port, and a few of its settings are not
the app's. See [Voice dictation](#voice-dictation-optional) for the working
setups. The short version: on the machine Deck runs on, `DEEPGRAM_API_KEY` is
enough; anywhere else the proxy needs `VOICE_ALLOWED_ORIGINS` and
`VOICE_PROXY_URL` (and `VOICE_PROXY_HOST` if it is to be reached directly), all
three documented in `.env.example`. A rejected upgrade is logged by the proxy
and looks, in the browser, like a microphone that does nothing.

**The rig has only ever run as root.** The rig's containers run as root, and
not by oversight that could be fixed in passing: the Dockerfiles it generates
carry no `USER`, `docker run` is called with no `--user`, and the tier-3 stage
records `id -un` in its own evidence, where it reads `root`. So every directory
the rig creates, the four roots and the agent homes included, has been created
root-owned on every run it has made. By hand, a non-root run has been completed
once: on WSL 2 with Ubuntu 24.04, on 2026-09-27. Nothing in Deck needs root. The
case where a non-root user can still go wrong is a container with a bind-mounted
state directory handing you back files you do not own, and that is worked
through in `rig/container-image-note.md`.

**Only Linux is measured by the rig; Windows has run by hand under WSL 2 and
macOS is unverified.** The rig runs Linux containers. The Ubuntu path in this
document is executed on every run, apart from the `sh-manual` blocks in Keep it
running and in the Windows section (user creation, the CLI path check, the
`/etc/wsl.conf` edits), which no rig run executes. By hand, WSL 2 with Ubuntu 24.04 was run end to end on 2026-09-27, before the
Windows section existed; nobody has followed that section as written from start
to finish. Native Windows (outside WSL) is not supported, because tier 3 needs
tmux. The macOS block is not run by anyone.

**A fresh agent needs a person at its first boot.** `boot-agents.sh` starts the
session but cannot answer the runtime's own setup prompts (folder trust, the
resume picker, the fullscreen offer). It reports a launch as ready only when it
has seen the composer, exits `3` while that is pending, and does not arm an
opted-in monitor on a launch that was not ready. See tier 3 for the exact steps.
Checked: `boot-agents.sh:642` waits up to `BOOT_READY_SECS` (default 45) per fresh
launch.

**Starting Deck on boot has not been checked.** The systemd user service in
Keep it running restarts Deck if it crashes and, once enabled, is meant to start
it with your user manager, but as of 2026-10-12 neither the rig nor a person
has rebooted a machine to confirm that.

**`MC_USER` defaults to `alex`.** Set it deliberately, as above. It is not
only a display name: it is a filename in your inbox root. Checked: `mcUser` in
`packages/deck/app/lib/instance.server.ts` returns `alex` when it is unset.

**Quick setup's approval, cap and status check are instructions, not locks.**
Whether the platform agent waits for your approval on the decision card, keeps
to three agents and calls `create-agent.sh --status` before creating anything
is written in its role brief and followed by the model. Nothing in code stops
it. The status check itself is deterministic (it reads the agent's files and
fails closed: anything short of the whole scaffold, including an empty home, reads `incomplete` (`absent` means no home or inbox entry at all), and an
incomplete home is reported for you to repair, never recreated or deleted). The
agents' own runtime permission prompts still apply. Not measured by the rig.

**Quick setup's key pair is protected by a marker, not by atomicity.** Two
renames cannot be one step. Setup records a pending marker, and a run that finds
two different stored keys stops before it verifies or starts anything. Starting
agents by hand with `boot-agents.sh` does not read the marker, so doing that
while `.setup-key-pending` exists can start an agent with a mixed pair. Setup
also holds the key only in its own memory and in the two files; it cannot stop
you putting `ANTHROPIC_API_KEY` in your own environment, which every program
you start would then inherit.

**Quick setup's first-run prompts are yours.** Setup and the platform agent
answer none of the model CLI's prompts. Each agent, including each one the
platform agent creates, stops at its own folder-trust prompt (and key approval,
if a key is stored) in its terminal view in Deck. Quick setup exits 5 only when
the boot output reports recognised prompts and nothing else is waiting; answer
them in Deck, then run it again. The rig measures it up to the model CLI only
(exit 4); acceptance with a signed-in CLI on Linux and WSL is pending.

**The model selector is hidden after a Quick setup.** It, and the cron admin,
are gated on Deck's default `MC_USER`, and setup sets `MC_USER` to your login
name. Change an agent's model by editing `$AGENTS_HOME/<name>/.model`.

## Where to go next

- `docs/adding-an-agent.md`: adding a second agent once you are running:
  create, verify, start, first message, remove, and what goes wrong.
- `README.md`: the layout, the checks the project runs on itself, and the
  rules the machines enforce.
- `packages/base/README.md`: the persona-file pattern, the `inbox` CLI, and
  `create-agent.sh` in full.
- `packages/base/docs/protocol.md`: the normative message format, if you are
  writing your own client.
- `rig/README.md`: how the claims in this document are measured, and what a
  red run means.
