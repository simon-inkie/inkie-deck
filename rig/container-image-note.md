# Putting Deck in a container: what would have to be decided first

This is a record, not a build. There is no Dockerfile in this repository and
this note does not add one.

That is a decision rather than an omission. An example Dockerfile nobody
executes is an example that stops being true on the first edit somewhere else,
and reads exactly like one that still works. Preventing that is the whole
reason `rig/` exists, so shipping the one artefact in the repository that
nothing runs would be a strange way to end the effort. The rig does build
images, on every run, from `rig/lib/images.mjs`, and those are executed and
asserted against. Where this note needs evidence about images it cites those,
and where it needs evidence about the product it cites the product's own code.
Every claim below was re-derived from this tree rather than carried over from a
plan.

Four things stand between here and a defensible image. None of them is hard.
All of them are decisions that a Dockerfile would make silently on your behalf.

## 1. Process supervision, and the two deaths a container cannot see

`packages/deck/scripts/start-production.mjs` is what INSTALL.md tier 2 tells you
to run, and it is a supervisor of exactly three children.

| child | spawned as | what happens when it dies |
| --- | --- | --- |
| voice proxy (`packages/deck/server/voice-proxy.mjs`) | `spawn("node", ...)`, resolved from `PATH` | nothing at all. There is an `error` handler for a spawn that never starts, and no `exit` handler, so a proxy that dies after starting leaves no line anywhere |
| push watcher (`packages/deck/server/push-watcher.mjs`) | `spawn(process.execPath, ...)` | logged: `push-watcher exited (N) - pushes OFF until daemon restart`. No respawn, deliberately, and the comment says so: "degrade, never drag down the lifeline" |
| the app server (`@react-router/serve`'s `bin.js` over the build) | `spawn(process.execPath, ...)` | `cleanup()` kills the other two and the launcher exits with the child's code |

Three consequences an image has to answer to.

**Only one of those three deaths is visible from outside.** A restart policy
acts when PID 1 exits, and this launcher exits only when the app server does. A
dead push watcher or a dead voice proxy leaves a container that is running,
that answers a liveness probe against the app port, and that has silently
stopped doing one of the things it was deployed to do. Web push is the one that
matters, because its whole job is to reach you when you are not looking: the
watcher polls the thread files every `PUSH_POLL_MS` and pushes on new blocks
(`packages/deck/server/push-watcher.mjs`), so when it is gone the interface
still works perfectly for anyone already looking at it. If an image wants those
two supervised, the image has to supervise them. Nothing here will.

**It answers signals, which is the thing usually got wrong as PID 1, and its
cleanup is not symmetrical.** `SIGINT` and `SIGTERM` both run `cleanup()`, so
this does not ignore a `docker stop` the way a Node process with no handlers
does when it is PID 1. But `cleanup()` kills the voice proxy and the push
watcher and NOT the app server, so a launcher sent `SIGTERM` exits while its web
server keeps running and keeps the port. Two arrangements hide that, which is
presumably how it has survived: as PID 1 the namespace is torn down on exit and
the orphan goes with it, and under a service manager that kills by control group
the manager gets it instead. Neither is a property of this script. An image that
runs the launcher as anything other than PID 1, behind an init shim or beside
something else, gets the orphan back.

It also reaps nothing it did not spawn itself, which is fine right up until tmux
is in the container, and tmux is the whole point of tier 3.

**The voice proxy is spawned differently from its two siblings**, by name from
`PATH` rather than by `process.execPath`. The comment on the app-server spawn
records why that difference is not cosmetic and what it once cost: a service
manager's login shell resolved a system Node 18 instead of the intended
runtime, and React Router 7 needs 20 or above. The voice proxy still has the
shape that caused that. In an image where the process that starts the daemon
does not have the intended Node first on `PATH`, the app and the watcher run on
one Node and the proxy runs on another, or does not start and says so exactly
once.

And then the part of the system that is not in this process tree at all: **the
agents themselves.** `packages/base/bin/boot-agents.sh` runs `tmux
start-server`, `tmux new-session -d`, `tmux new-window`, and types each agent's
launch command into its pane with `send-keys`. tmux daemonises. So neither the
tmux server nor any model CLI running inside it is a child of the launcher, of
the boot script, or of anything either of them can wait on, and the fleet
survives a daemon restart and vice versa. The application reaches them by
running tmux itself: `packages/deck/app/lib/tmux.server.ts` calls
`execFileSync("tmux", argv)` with a 500ms deadline, from inside the web server
process, for both reads (`capture-pane`) and writes (`send-keys`).

Which makes the image question a fork rather than a detail:

- **One image serving Deck and hosting the agents** is two process trees in one
  container sharing a tmux socket and a UID, with the model CLIs living in the
  half that no supervisor is watching.
- **One image serving Deck only** has to reach a tmux server outside it, or
  lose the terminal surface. It will lose it QUIETLY. `MC_TMUX_ENABLED` defaults
  to on and never probes for the binary
  (`packages/deck/app/lib/instance.server.ts`), and every tmux failure degrades
  to an empty view rather than an error by design
  (`tmux.server.ts`, guard 5). So the navigation still offers a terminal tab and
  the panes are simply blank. The rig already knows this trap: stage eight
  asserts the CONTENTS of a real pane appear in the page, precisely because a
  200 from the terminal route, and the tab appearing in the navigation, are both
  satisfied on a machine with no tmux installed at all.

## 2. HOST and ports: two listeners, one of them unconfigured in production

The app is the listener everyone plans for. `PORT` defaults to 4242, `HOST`
defaults to `127.0.0.1`, and the launcher prints a paragraph at boot whenever
it binds loopback, because a published port against a loopback bind gets
nothing while the banner still reads like a healthy start. The rig proves both
directions of that, one variable apart: `run-it-loopback` and
`run-it-reachable` in `rig/install-plan.mjs` are the same document with and
without its one `HOST=0.0.0.0` block, and stage seven requires the first to be
refused from outside the container while answering 200 inside its own
namespace.

The voice proxy is the listener nobody plans for, and it is where an image gets
surprised.

| variable | default in the proxy | set by `pnpm dev` | set by `start-production.mjs` |
| --- | --- | --- | --- |
| `VOICE_PROXY_PORT` | 5176 | yes | yes |
| `VOICE_PROXY_HOST` | `127.0.0.1` | no | no |
| `VOICE_ALLOWED_ORIGINS` | `http://localhost:5174` | yes, derived from the app port | no |
| `VOICE_PROXY_URL` | client falls back to `ws://localhost:5176/voice` | yes | no |

Read that table as a container question and three things fall out.

**The bind.** `VOICE_PROXY_HOST` is loopback by default and the production
launcher never widens it, so the app's `HOST=0.0.0.0` line, which INSTALL.md
tells you to add for exactly this reason, does nothing for the voice port. A
second published port needs `VOICE_PROXY_HOST` as well, which INSTALL.md's
limitations now say and `.env.example` still does not.

**The origin allowlist.** `dev.mjs` computes it from the app port and carries a
comment about why: an upgrade rejected on origin fails silently, and the
5174-to-4242 port move broke it once already. `start-production.mjs` does not
compute it, so a production start keeps the proxy's own default of
`http://localhost:5174`, which is the dev server's old port. A browser on the
production app's own origin is refused. The proxy logs the rejected origin; the
browser just gets a microphone that does nothing.

**The URL, which is resolved in the wrong machine.** `getVoiceProxyUrl`
(`packages/deck/app/lib/voice.server.ts`) falls back to
`ws://localhost:5176/voice`, and that string is handed to the browser through
the loader, so `localhost` means the machine holding the keyboard. It is right
exactly once: when you are sitting at the machine Deck runs on. Everywhere
else, and that includes every container deployment worth building an image for,
it points at nothing.

None of the three is in `packages/deck/.env.example`. All three are now in
INSTALL.md's limitations, written down in the same pass that produced this note,
and the launcher's own header comment no longer points at `.env.example` for
them, which it used to and which was never true here.

## 3. Volume UID and permissions: everything measured so far has been root

Nothing in the rig ever chooses a user. The Dockerfiles it generates carry no
`USER` instruction (`rig/lib/images.mjs`), `docker run` is invoked with no
`--user` (`rig/lib/docker.mjs`, `rig/lib/docrun.mjs`), the base is
`ubuntu:24.04` whose default user is root, and the tier-3 stage does not have
to infer any of this because it records `id -un` in its own evidence, where it
reads `root`.

So every path in a green report is a root-owned path created by a root process:
the four roots under `/root/deck/`, the agent homes under `/root/agents/`, and
the `inbox` CLI symlinked onto `PATH` at `/root/.local/bin/inbox` by
`create-agent.sh`.

That is the whole finding, and it lands squarely on the one thing an image is
for. The application creates none of its four roots and refuses to boot against
a root that does not exist (`start-production.mjs`, and INSTALL.md section 4
explains why: the alternative is silently creating an inbox somewhere you did
not mean and then looking empty). So a container has to be handed roots that
already exist, which in practice means a bind mount or a named volume. Bind
mount a directory into a container that runs as root, and the messages, the
uploads, the kanban cards and the queue state come back owned by root on your
own machine. That is the data a user would most want to own: it is their
correspondence, in plain markdown, which the entire design goes out of its way
to keep readable with an ordinary text editor.

Two things make this better than it sounds, and one makes it worse.

Better: **write confinement here is shape-based, not permission-based.** The
guard asserts that a write resolves inside the configured root and looks like
`<agent>/inbox/<file>.md` (`packages/deck/app/lib/safe-fs.server.ts`, the rule
cited as FND-04), and it does that with path arithmetic rather than by relying
on what the filesystem would have refused. Dropping privilege does not weaken
it and running as root does not strengthen it, so the two questions are
genuinely independent: an image can pick a UID on the merits without touching
the security model.

Better: **the state is inert.** Threads, cards and attachments are files; there
is no database, no socket, no daemon-owned state directory with an opinion
about who owns it. `DATA_ROOT` holds the queue state and the self-provisioned
VAPID key pair (`packages/deck/server/push-watcher.mjs`), and that is the
extent of what the application considers its own.

Worse: **nobody has ever run any of this as a non-root UID.** Not the rig, not
CI, not the documented install. So a `USER` line in an image would be an
untested claim, of exactly the kind this repository has spent its entire short
history removing, and that is why this note does not offer one. The cheap way
to find out is not a Dockerfile either: it is one more stage. The same install
base with a `USER` line and a non-root home, running the same document. If
INSTALL.md survives that unchanged, the image question has answered itself, and
answered it by executing rather than by asserting.

## 4. The model CLI, which stays a question

An agent is a model CLI running in a terminal. Installing it, signing in to it
and paying for it happen on the machine, to a person, and a container image
cannot carry any of the three. INSTALL.md says this in tier 3 and the tooling
declines to overclaim in the two places where it would be easiest to:

- `packages/base/bin/create-agent.sh` exits **4, CANNOT VERIFY**, when there is
  no `claude` on `PATH`, rather than reporting the agent it just created as
  working. Created but unproven is not a pass, because a persona that never
  reached the model leaves behind exactly the same directory tree as one that
  did. The rig asserts the exact code and the words.
- `packages/base/bin/inbox-push` emits `skip:unknown-runtime` or
  `skip:unknown-format` and exits 2 rather than typing into a pane it cannot
  identify, and the message is already persisted before the push is attempted,
  so a refused push is never a lost message. Stage eight records a real
  refusal on every run, though the specific one it exercises (`skip:no-window`,
  the recipient being root rather than an agent) declines a step earlier than
  these two - before any pane is inspected at all.

What an image would have to answer, and this note deliberately does not:

- **Where the credential lives.** The only mechanism this repository has for
  agent secrets is a gitignored `.env.secrets` in the agent's home, sourced in
  the pane's shell immediately before the runtime launches (`boot-agents.sh`).
  That is a per-machine, per-agent file. Whether a model CLI's own login can be
  supplied that way, or is a per-user credential the CLI writes for itself, is
  not knowable from this tree, and guessing produces exactly the kind of recipe
  that stops being true without anything going red.
- **Whether it may be baked in.** An image with a signed-in CLI inside it is a
  credential in a registry. Whatever the answer turns out to be, it is not that.
- **How billing attributes.** Many agents in many panes on one machine is the
  arrangement this code was extracted from, and that is all the repository
  knows: nothing here records the terms it ran under, so nothing here should
  imply them for anyone else.

Until those are answered by someone who can answer them, the honest shape is
the one the rig already takes: measure everything up to the model CLI, assert
that the tooling refuses to claim the rest, and stop.

## What would have to be true before this becomes an image

In the order the work would go, each one a decision rather than a line of
Dockerfile:

1. Decide whether the agents live in the image (section 1). Everything else
   depends on the answer, because it decides whether the container has one
   process tree or two, and whether tmux is inside it or reached across a
   socket.
2. Decide who supervises the push watcher and the voice proxy, given that the
   container runtime can only see the app server die (section 1).
3. Publish two ports and set three voice variables, or decide voice is off in
   this deployment and say so where a reader will look (section 2).
4. Pick a UID, and prove it by running the document under it rather than by
   writing it into a `USER` line (section 3).
5. Leave the model CLI outside the image, and keep the two refusals that make
   its absence audible (section 4).
