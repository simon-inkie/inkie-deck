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
  instructions in this document are unverified**, and are the one place here
  where you are reading a belief rather than an observation.

`rig/README.md` describes the harness. `node rig/run.mjs` runs it.

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

On Ubuntu or Debian, as root (prefix each line with `sudo` if you are not):

```sh
apt-get update
apt-get install -y ca-certificates curl git ripgrep python3 tmux xxd
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
corepack enable
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

Check what you got. Anything on the `22.13` line or above, or 24 and above, is
inside the supported range; pnpm refuses to install on anything else and tells
you why.

```sh
node --version
pnpm --version
```

```text
v22.23.2
10.34.5
```

The pnpm version is pinned by the repository's `packageManager` field, so
corepack fetches that exact version the first time you run it whatever you
have installed globally. The first `pnpm --version` is therefore slower than
it looks like it should be.

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

## 2. Install the dependencies

Everything from here runs from the root of your clone.

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

- The file to write for a terminal or tmux start is `.env`. The systemd option
  below reads `.env.production` through its `EnvironmentFile`; that file is
  not loaded when you start the launcher by hand.
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

That runs in the foreground: closing the terminal stops Deck. The subshell is
deliberate: the launcher must run with
`packages/deck` as its working directory (it resolves the build and the `.env`
relative to it), and the brackets mean your own shell stays where it was.

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

### Keep it running after closing the terminal

Stop the foreground instance with Ctrl+C before choosing one of these options,
so only one Deck instance uses the port. Run the commands from the repository
root after building.

**Detached tmux:** this uses the same `.env` as the foreground launcher.
If a `deck` session already exists, inspect it with `tmux attach -t deck`.
Stop its launcher, then use `tmux kill-session -t deck` before creating a
replacement session with the command below.

```sh
tmux new-session -d -s deck -c "$(pwd -P)/packages/deck" 'node scripts/start-production.mjs'
```

You can now close the terminal. Inspect Deck with `tmux attach -t deck`, then
detach with Ctrl+B followed by D. Stop it with `tmux kill-session -t deck`.
Agents started by `boot-agents.sh` run in the separate `agents` tmux session,
which also survives closing an attached terminal. Starting Deck does not boot
agents, and stopping the `deck` session does not stop the `agents` session.

**systemd user service (Ubuntu 24.04):** this runs Deck outside the terminal
and restarts it if the launcher exits. On WSL, systemd must be enabled in your
distribution first; check that `systemctl --user status` reaches a user manager.
This option supervises Deck and its launcher children, not agent startup.

Copy the configuration and keep it private. If `.env.production` already
exists, edit it instead of overwriting it. Use literal values in this file:
systemd does not expand shell variables such as `$HOME` in an EnvironmentFile.
Remove any `export` prefixes and trailing inline comments copied from `.env`:
use `KEY=value`, with comments on separate lines, and check quoted values
against systemd's EnvironmentFile syntax.

```sh
cp -n packages/deck/.env packages/deck/.env.production
chmod 600 packages/deck/.env.production
```

Render the example unit with this checkout's directory and the Node executable
currently in use, including installations managed by a version manager. The
generated unit is machine-local; do not commit it or either environment file.
`EnvironmentFile` uses glob syntax, so the renderer escapes `\`, `*`, `?` and
`[` there so each of them matches only the literal character.
`WorkingDirectory` is not globbed, so it keeps those characters unchanged.
Systemd can load these paths, but Node's ES module loader rejects backslashes
in module filenames. Use a checkout path without backslashes to run Deck.

```sh
deck_unit_dir="$(systemd-path user-configuration)/systemd/user"
mkdir -p "$deck_unit_dir"
DECK_DIRECTORY="$(cd packages/deck && pwd -P)" \
NODE_BINARY="$(node -p 'process.execPath')" \
python3 - "$deck_unit_dir/deck.service" <<'PY'
import os
from pathlib import Path
import re
import sys

def escape_command(value):
    return ''.join('%%' if c == 37 else '\\x%02x' % c
                   if c <= 32 or c >= 127 or c in (34, 92) else chr(c)
                   for c in value.encode('utf-8'))

directory = os.environ['DECK_DIRECTORY']
unit = Path('packages/deck/scripts/deck.service').read_text()
for token, value in {
    '@DECK_DIRECTORY@': directory,
    '@ENVIRONMENT_FILE@': str(Path(directory) / '.env.production'),
    '@NODE_BINARY@': os.environ['NODE_BINARY'],
}.items():
    if '\n' in value or '\r' in value:
        raise ValueError('Unit paths cannot contain line breaks')
    # Only ExecStart unescapes C escapes. EnvironmentFile uses glob syntax,
    # so escape its glob characters (backslash first) to match them literally.
    if token == '@ENVIRONMENT_FILE@':
        value = re.sub(r'([\\*?\[])', r'\\\1', value)
    value = ('"' + escape_command(value) + '"' if token == '@NODE_BINARY@'
             else value.replace('%', '%%'))
    unit = unit.replace(token, value)
Path(sys.argv[1]).write_text(unit)
PY
systemctl --user daemon-reload
loginctl enable-linger "$(id -un)"
systemctl --user start deck
systemctl --user status deck
```

Lingering keeps the user manager running after logout; without it, a user
service can stop when your last login closes. If enabling it requires
administrator authorisation, complete that step before relying on logout
survival. Logs are available with `journalctl --user -u deck -f`. Stop Deck
with `systemctl --user stop deck`; an explicit stop does not trigger a restart.
After rebuilding, use `systemctl --user restart deck`.
Repeated failures are limited to five starts within 60 seconds. After fixing
the cause, use `systemctl --user reset-failed deck` and start it again.

Neither option configures automatic Deck or agent startup after a reboot.
Closing every WSL window is also different from shutting down WSL or the host,
which stops both Deck and its agents. Re-render the unit if the checkout or
Node executable moves.

## 5. Bring your agents to life

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
packages/base/bin/create-agent.sh wren --role "keeps the notes"
```

That writes both, links the `inbox` CLI onto your `PATH`, and then tries to
prove the persona actually reached the model by asking the agent, in one
non-interactive turn, for a boot phrase that exists nowhere but its own
identity file. **With no model CLI installed, that last step cannot run**, and
the script says so and exits 4:

```text
create-agent: CREATED wren
  persona files  /home/you/agents/wren
  inbox          /home/you/deck/inbox/wren/inbox
  boot phrase    boot-6ed9a08da2961594

create-agent: CANNOT VERIFY wren
  No `claude` on PATH, so there was nothing to ask.
```

Exit 4 means created but unproven, and it is not a pass. Once you have a model
CLI installed and signed in, `packages/base/bin/create-agent.sh --verify-only
wren` re-runs only the proof. It exits 0 only if the phrase comes back, which
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

```sh
tmux list-windows -t agents -F '#{window_name}'
```

```text
wren
```

The window is real whether or not a model CLI is installed. With none, the
pane holds the shell and the error, which is exactly what you should see at
this point on a machine with no subscription:

```sh
tmux capture-pane -t agents:wren -p | grep -v '^$' | tail -5
```

```text
you@host:~/agents/wren$ printf '\033]0;wren\007'; [ -f /home/you/agents/wren/.env.secrets ] && . /home/you/agents/wren/.env.secrets; claude --resume wren  || claude
-bash: claude: command not found
-bash: claude: command not found
you@host:~/agents/wren$
```

(The blank lines are dropped because a tmux pane is padded to its full height,
and `tail` on the raw capture returns the padding rather than the text.)

Deck reads that pane live. Open the agent's thread and switch to the terminal
view, or `curl -sS "http://localhost:4242/threads/wren?view=tmux"`, and the
contents of the pane are in the page. That is the one check in this area worth
trusting. Deck's tmux surface is switched on by an environment variable that
defaults to on and never looks for the binary, so the terminal view being
offered in the navigation is not evidence that tmux exists on the machine. The
contents of a pane cannot be produced that way.

### Send a message, and answer it as the agent

From the browser, open the agent's thread and type. Without a browser, this is
the same request the interface makes:

```sh
curl -sS -X POST http://localhost:4242/threads/wren \
  --data-urlencode 'intent=compose' \
  --data-urlencode 'body=Welcome aboard. What do you make of the protocol doc?' \
  -o /dev/null -w '%{http_code}\n'
```

```text
200
```

That writes a block into `$INBOX_ROOT/wren/inbox/<your MC_USER>.md`. An agent
reads and answers with the `inbox` CLI, which is the half of the protocol that
lives in the terminal, where the agent is. Standing in for the agent by hand:

```sh
export AGENT_NAME=wren
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
curl -sS http://localhost:4242/threads/wren | grep -c 'the whole protocol'
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

**Typography needs the internet at runtime.** The stylesheet imports three
fonts from Google Fonts, so an installation with no outbound access renders in
fallback fonts with no explanation. Nothing else about the application depends
on egress.

**Optional subsystems are unverified here.** Voice dictation (Deepgram),
image descriptions (Gemini) and web push all need keys, are off without them,
and are not exercised by the rig. They degrade rather than fail: the voice
proxy starts without a key and tells the client it has none.

Voice carries one more thing worth knowing before you reach for it, because
the dev command hides it. Voice is a SECOND listener, on its own port, and
`pnpm dev` configures it for you while `node scripts/start-production.mjs` does
not. In production the proxy keeps its own defaults: it binds `127.0.0.1`
unless `VOICE_PROXY_HOST` says otherwise, it accepts WebSocket upgrades only
from `http://localhost:5174`, which is the dev server's old port and not one
anything here serves by default, and the URL handed to your browser falls back
to `ws://localhost:5176/voice` when `VOICE_PROXY_URL` is unset, which your
browser resolves against the machine YOU are sitting at rather than the one
Deck is on.
So on a production start, voice needs `VOICE_ALLOWED_ORIGINS` and
`VOICE_PROXY_URL` set by hand even on the machine Deck is running on, and
`VOICE_PROXY_HOST` as well to reach it from anywhere else. A rejected upgrade
is logged by the proxy and looks, in the browser, like a microphone that does
nothing. None of those three is in `.env.example` yet.

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
Ubuntu path in this document is executed on every run; the macOS block is not,
and no one has run this on Windows.

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
