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

On Windows, start with [Windows (via WSL)](#windows-via-wsl).

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
Do the first four subsections below first, up to and including Install the
tools, then follow the rest of the document from inside Ubuntu. The later
subsections (the model CLI, opening Deck, keeping it running) are for when
section 4 or 5 sends you back here. Every Linux step is the same step as for any
Ubuntu machine, and this section only covers what is different on Windows. The blocks marked
`powershell` run in Windows PowerShell. Every other block runs in the Ubuntu
window.

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

### Keep it running

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
[Keep it running](#keep-it-running). After a Windows restart, Deck is back as
soon as Ubuntu starts, which is when you first open an Ubuntu window; it does
not start with Windows.

## 1. Prerequisites

Deck needs Node on a current LTS line, pnpm (via corepack), and a **git
clone**. A downloaded ZIP or a release tarball is not enough: two of the test
suites and the leak gate shell out to git against the repository root.

Four more tools matter for one thing each, and are easy to miss because every
machine that has run this so far already had them:

| tool | needed for | without it |
| --- | --- | --- |
| ripgrep (`rg`) | `pnpm check:dashes`, and the test suite | four test failures, which do at least name ripgrep |
| python3 | the `inbox` CLI, which is how an agent replies | Deck runs fine; your agents cannot answer |
| tmux | tier 3, the live agent sessions | Deck degrades to a viewer over files |
| xxd | the `inbox` suite only, nothing at runtime | one test stops with `xxd: command not found` |

On Ubuntu or Debian, as root. If you are not root, type `sudo -i` for a root shell first, paste the block, `exit`, and set the `export` line again in your own shell (`sudo` in front of single lines breaks the Node line and `export`):

```sh
apt-get update
apt-get install -y ca-certificates curl git ripgrep python3 tmux xxd
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

If you want to run the checks the project runs on itself (`pnpm typecheck`,
`pnpm test` and the three gates), the README covers them. They are not needed
to run Deck.

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
against it gets nothing); and it has no tmux, no agents and no clock that
moves. For those, keep going.

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

Exit 4 means created but unproven, and it is not a pass. Once you have a model
CLI installed and signed in, `packages/base/bin/create-agent.sh --verify-only
inkie` re-runs only the proof. It exits 0 only if the phrase comes back, which
is a stronger statement than any check of the files: a persona that never
reached the model leaves behind exactly the same directory tree as one that
did.

Reload Deck and the agent is there. Nothing needs restarting; the agent list
is the set of directories under `INBOX_ROOT`.

### Start the sessions

```sh
packages/base/bin/boot-agents.sh
```

That starts a tmux session named `agents` with one window per agent home,
named after the agent, and launches each agent's runtime in its window. Run it
again and an agent whose pane already has its runtime running in it is left
alone; one whose runtime has exited is relaunched, which is what makes this
safe to fire on boot.

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

Current, verified, and written down rather than discovered later.

**No authentication.** Repeated here because it belongs on any list of this
kind. See the top of this document.

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
guessed at on read.

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
than a setting.

**Nothing proves that a message typed into a READY pane lands.** This is the
coverage gap named at the end of tier 3, repeated here because this is where a
reader looks for it. The refusals are covered from every angle, and one of them
(`no-window`, described above) is exercised on every rig run, with the exact
wording recorded in the report - it declines before a pane is ever inspected,
since the walkthrough's recipient is you rather than an agent. The other outcome, where the
gate decides the pane is ready and types, has no test behind it anywhere: the
delivery suite runs its cases against pane text the test itself supplies, with
every real keystroke suppressed, and the rig has no agent to be typed at. So
"the message arrived in the pane, and arrived whole" is a belief. It is
probably a correct one, since `inbox-push` sends the text and the Enter as
separate keystrokes and then re-reads the pane to confirm the paste landed, and
none of that is the same as having measured it.

Worth knowing while you are here: that careful path is the CLI's. Typing into a
pane from Deck's own terminal view is a different one
(`packages/deck/app/routes/api.tmux-send.tsx` into `sendKeysToWindow`), whose
gates are the window name and the live window list, with no idle check and no
read-back. It was written for a person watching the pane they are typing into.

Closing the gap means a stub agent that can be started in a pane, typed at, and
asked what it received. That is a named follow-up and deliberately not part of
this phase, because it wants the container and process-supervision groundwork
recorded in `rig/container-image-note.md` first.

**The browser test suite is not a guarantee.** `pnpm -C packages/deck e2e`
runs Playwright journeys that have real, currently un-diagnosed flakes. It is
not in CI. Treat a green e2e run as encouraging and a red one as worth
reading, and rely on `pnpm test` for the claim that the tree is sound.

**`boot-agents.sh` always uses a tmux session named `agents`.** The session
name is not configurable in the launcher, while the application reads
`MC_TMUX_SESSION` (defaulting to the same name). If you already run something
in a session called `agents`, Deck's launcher will add its windows to your
existing session rather than starting its own. There is no flag for this yet;
until there is, either rename your session (`tmux rename-session`) or run Deck
on a machine or user account that does not have one. Pointing Deck at a
differently-named session with `MC_TMUX_SESSION` works for the application,
but the launcher will not follow it.

**Typography needs the internet at runtime.** The page links a stylesheet for
three fonts from Google Fonts, so a browser with no route to it renders in
fallback fonts with no explanation. That is the browser's connection, not the
server's. Until #32 was fixed the fonts never loaded even when online, because
the `@import` that was meant to fetch them was dropped; if you see fallback
fonts on a connected browser now, that is a regression worth reporting. Nothing
else about the application depends on egress.

**Optional subsystems are unverified here.** Voice dictation (Deepgram),
image descriptions (Gemini) and web push all need keys, are off without them,
and are not exercised by the rig. They degrade rather than fail: the voice
proxy starts without a key and tells the client it has none.

Voice is a SECOND listener, on its own port, and a few of its settings are not
the app's. See [Voice dictation](#voice-dictation-optional) for the working
setups. The short version: on the machine Deck runs on, `DEEPGRAM_API_KEY` is
enough; anywhere else the proxy needs `VOICE_ALLOWED_ORIGINS` and
`VOICE_PROXY_URL` (and `VOICE_PROXY_HOST` if it is to be reached directly), all
three documented in `.env.example`. A rejected upgrade is logged by the proxy
and looks, in the browser, like a microphone that does nothing.

**Everything here has only ever been measured as root.** The rig's containers
run as root, and not by oversight that could be fixed in passing: the
Dockerfiles it generates carry no `USER`, `docker run` is called with no
`--user`, and the tier-3 stage records `id -un` in its own evidence, where it
reads `root`. So every directory this document creates, the four roots and the
agent homes included, has been created root-owned on every run anyone has
measured. Nothing in Deck needs root, and nothing here has been measured
without it either, which is a different sentence from "it works fine as a
normal user" and is the honest one. Following this document on your own desktop
already puts you outside what has been measured, in the direction that is
almost certainly fine. The case where it stops being fine is a container with a
bind-mounted state directory handing you back files you do not own, and that is
worked through in `rig/container-image-note.md`.

**macOS and Windows are unverified.** The rig runs Linux containers. The
Ubuntu path in this document is executed on every run, apart from the
`sh-manual` blocks in Keep it running; the macOS block is not. The Windows
section follows Microsoft's WSL documentation. Nobody, neither the rig nor a
person, has followed it from start to finish on a Windows machine.

**`MC_USER` defaults to `alex`.** Set it deliberately, as above. It is not
only a display name: it is a filename in your inbox root.

## Where to go next

- `README.md`: the layout, the checks the project runs on itself, and the
  rules the machines enforce.
- `packages/base/README.md`: the persona-file pattern, the `inbox` CLI, and
  `create-agent.sh` in full.
- `packages/base/docs/protocol.md`: the normative message format, if you are
  writing your own client.
- `rig/README.md`: how the claims in this document are measured, and what a
  red run means.
