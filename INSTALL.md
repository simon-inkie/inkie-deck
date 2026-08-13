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
behalf.

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

## Known limitations

Current, verified, and written down rather than discovered later.

**No authentication.** Repeated here because it belongs on any list of this
kind. See the top of this document.

**A markdown heading in a message body truncates the message when it is
read.** Both readers of the protocol, the python3 CLI and the web application,
derive block boundaries from every line starting with `## ` and only afterwards
discard the ones that are not valid headers. The specification requires the
opposite order. A message whose body contains a markdown heading therefore
loses everything from that heading onwards **on read**; the bytes on disk are
intact, which is what makes it hard to notice. It is recorded as a deviation
in `packages/base/conformance/corpus.json` (`body-markdown-heading`), so the
conformance suite asserts the exact wrong answer today and will fail the
moment it is fixed, forcing the record to be deleted. The fix is owned by the
protocol implementation and is not applied here.

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
