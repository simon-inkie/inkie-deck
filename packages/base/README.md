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
  in any language. `bin/inbox.mts` is one conforming implementation of it, not
  the definition of it.
- **`bin/`**: the orchestration scripts that launch a team of agents in tmux
  (one window each, on boot or on demand), and `inbox`, the CLI that
  implements the message protocol: append a block, flip its status, never
  corrupt a concurrent writer.
- **`tests/`**: a real test suite for `inbox`, including a concurrency stress
  test for its cross-process lock, run with `npm test`. Vitest is a dev
  dependency and the only one; the tool itself has no runtime dependencies.
- **`docs/tooling-review.md`**: honest status of what's ported versus
  reviewed-only, and why.

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
git clone <this-repo-url> inkie-agents-base
cd inkie-agents-base

# Starting a new agent from scratch:
cp templates/*.md /path/to/your/new/agent/

# Using bin/inbox.mts as-is (Node 22.18+, no install step, no build step):
AGENT_NAME=yourname node bin/inbox.mts unread
```

`bin/inbox.mts` is a single file with no runtime dependencies. Node runs it
directly: `.mts` is TypeScript, and Node strips the types natively at load
time (on by default since Node 22.18, and in every Node 24+ release), so there
is nothing to compile, install or generate first. Copy the one file wherever
you like, or call it with an explicit path as above. It reads `AGENT_NAME` and
`SILO_HOME` from the environment (see `SYSTEM.md` for the conventions both
assume) and needs nothing beyond Node itself.

To get the bare command name on your `PATH`, symlink rather than copy, so the
`.mts` extension survives (Node decides whether to strip types from the
resolved filename, and an extensionless copy would fail to parse):

```bash
ln -s "$PWD/bin/inbox.mts" ~/.local/bin/inbox
AGENT_NAME=yourname inbox unread
```

The file is `.mts` rather than `.ts` on purpose: `.mts` is always treated as
an ES module, so it keeps working wherever you drop it, regardless of the
`"type"` field of whatever `package.json` happens to be nearest.

## Development

```bash
npm install     # dev dependencies only: vitest and typescript
npm test        # run the suite
npm run typecheck
```

The tool has zero runtime dependencies on purpose: a small, portable pattern
shouldn't make you install anything to use it. The test suite does need
vitest, which is why `npm install` appears here and nowhere in the Install
section above. CI (`.gitlab-ci.yml`, `.github/workflows/test.yml`) runs the
typecheck and the suite across the current Node LTS lines on every push, and
runs the CLI once *before* installing anything, so the no-install claim above
is checked rather than assumed.

## Status

Templates, one worked example, the shared multi-agent conventions, the tmux
launch scripts, the inbox protocol with its own test suite, a licence, and CI
all exist now. Still to come: a CONTRIBUTING guide, and a second worked
example that shows a small team of agents using `SYSTEM.md`/`ROSTER.md`
together, not just one agent in isolation.

## License

MIT, see `LICENSE`.
