# inkie-agents-base

A small, portable pattern for giving an AI agent (or a team of them) a persistent
identity: five files that define who the agent is, who it works for, and what it
can reach, plus the discipline of writing and reading them across sessions.

This is an early extraction, not a finished release. Structure and docs will keep
filling in.

## What's here

- **`templates/`**: blank, fill-in-the-blank versions of the five persona files:
  `IDENTITY.md` (name, vibe, the story behind the name), `SOUL.md` (core truths,
  boundaries, tone), `TOOLS.md` (your setup's specifics), `USER.md` (who you work
  for), and `CLAUDE.md` (wires the other four together as always-loaded context).
- **`sample-agent/`**: the same five files, fully filled in, for a wholly
  fictional example (a one-person handmade-goods shop and its support agent).
  Not a real agent or business, filled in so the shape of a *finished* persona is
  concrete rather than an abstraction.
- **`SYSTEM.md`** and **`ROSTER.md`**: what's shared across a whole team of
  agents rather than owned by any one of them, the inter-agent messaging
  protocol, a small always-on rules pattern, autonomy/escalation, and a
  routing table for who owns what. Only relevant once you're running more
  than one agent; a solo setup doesn't need either yet.
- **`docs/protocol.md`**: the normative specification of the message format.
  This is the document to implement against if you're writing your own client,
  in any language. The application in `packages/deck` is one conforming
  implementation of it, not the definition of it.
- **`bin/`**: `create-agent.sh`, which creates an agent and then proves its
  persona actually reached the model, plus the orchestration scripts that launch
  a team of agents in tmux (one window each, on boot or on demand).
- **`docs/tooling-review.md`**: honest status of what was ported, what was
  ported and then removed, and why.

There is deliberately no CLI in this package. An `inbox` CLI implementing the
protocol was ported here, tested, and then removed once the application in
`packages/deck` landed: the application already reads and writes the same
format, and two implementations of one protocol in one repository drift apart.
The spec is the artefact this package ships; `docs/tooling-review.md` records
what happened to the code.

## The idea

An agent's identity shouldn't live only in a conversation that resets. It lives
in files the agent reads at the start of every session and rewrites as it learns
who it is. The person a stranger meets on turn one and the person a long-time
collaborator knows should be readable from the same five files, at different
levels of depth.

`IDENTITY.md` and `SOUL.md` are the agent's own, self-authored, not written for
it. `TOOLS.md` and `USER.md` are practical: what it has access to, and who it's
actually working for. `CLAUDE.md` just imports the rest so every session starts
with the full picture loaded.

## Install

There's no package to install, this is a pattern and a handful of scripts, not
a library. Clone it, then take what you need:

```bash
git clone <this-repo-url>

# Starting a new agent from scratch:
AGENTS_HOME=/path/to/agents INBOX_ROOT=/path/to/inboxes \
  packages/base/bin/create-agent.sh wren --role "keeps the notes"
```

That writes the persona files, the inbox, and the runtime settings, and then
asks the new agent, in one non-interactive turn from its own directory, to state
its name and the boot phrase written into `IDENTITY.md` at creation. It exits 0
only if the phrase comes back.

Why that last step rather than checking the files landed: **files existing on
disk is what every way this breaks looks like.** A persona that silently never
reached the model leaves behind exactly the directory tree of one that did, so
nothing you can check on the filesystem tells them apart. Only an answer that
comes back through the mechanism can. And it asks for the boot phrase rather
than the name because the *name* leaks into the model's context through the
working directory, so a session carrying no persona at all can answer "what is
your name" convincingly. The phrase is random at creation and exists nowhere
but the persona file.

Four outcomes, four exit codes, and deliberately no fifth one meaning "created,
assume fine": `VERIFIED` (0), `SCAFFOLD ERROR` (1), `FAILED` (3, and it prints
the reply, because the reply is the diagnostic), `CANNOT VERIFY` (4, when there
was no runtime to ask, which is not a pass). An empty reply with a zero exit
status is `FAILED`. Re-check later with `create-agent.sh --verify-only <name>`;
`create-agent.sh --help` has the rest.

There is nothing magic in it. If you would rather do it by hand, the templates
are just files, and the two things easiest to miss doing it that way are the
inbox directory (an agent your launcher can see but your control plane cannot)
and the fact that `--resume`-style launching needs the first session named
before it can resume:

```bash
cp packages/base/templates/*.md /path/to/your/new/agent/
```

The templates and docs are plain markdown and the `bin/` scripts are plain
shell; nothing in this package needs an install step. If you want machinery
that speaks the message protocol, implement `docs/protocol.md` in your
language of choice, or use the application in `packages/deck`, which already
does.

## Development

This package is markdown and shell, so it has no build and no typecheck. It does
have a test suite, covering the one thing in here with behaviour:
`bin/create-agent.sh`. `pnpm test` runs it. The tests drive the script as a
subprocess against temporary directories, with `HOME`, the agents home, the
inbox root and `PATH` all redirected, so they cannot touch a real agent or reach
a real runtime.

The protocol's conformance requirements live in `docs/protocol.md` section 10,
and are not covered by that suite. The repository-level CI (`.gitlab-ci.yml`, `.github/workflows/ci.yml`) runs the
workspace-wide checks, including the leak gate that also scans this package,
on every push.

## Status

Templates, one worked example, the shared multi-agent conventions, the create
and tmux launch scripts, the protocol specification, a licence, and CI all
exist now.
Still to come: a CONTRIBUTING guide, and a second worked example that shows a
small team of agents using `SYSTEM.md`/`ROSTER.md` together, not just one
agent in isolation.

## License

Apache-2.0, see the `LICENSE` file at the repository root.
