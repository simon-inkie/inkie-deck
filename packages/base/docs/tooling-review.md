# Tooling review

Status of the scripts behind the pattern this repo describes: which are
ported, which were written here, which were removed and then restored, and
why.

## Ported: `bin/workspace.sh`, `bin/boot-agents.sh`

Both are tmux orchestration: resume or launch one window per agent, handle a
couple of optional runtime integrations, stay idempotent. No concurrency-
correctness properties to preserve, so porting them was genuinely mechanical:
parameterise the one hardcoded path assumption (`AGENTS_HOME`, defaulting to
`~/agents` to match `templates/`), and replace a hardcoded list of which
agents get their watcher auto-armed with a per-agent marker file
(`.auto-arm-watcher`), consistent with the marker-file convention the scripts
already use for runtime/model overrides.

One simplification made deliberately, not by oversight: the source scripts
carry real integration code for two additional non-Claude runtimes, each with
its own hard-won env-var and timing quirks specific to those tools. That's
implementation detail for specific third-party CLIs, not part of the
persona/identity pattern this repo is about, so it's dropped here in favour of
a generic "any other runtime" branch with a comment on the general principle
(some runtimes need env vars set before the process starts, not just
hook-declared). If you need one of those integrations, treat it as a
runtime-specific extension, not core.

## Written here, not ported: `bin/create-agent.sh`

The only new code in this package rather than cleaned-up code from the internal
platform, because there was nothing to port. Internally, creating an agent is a
recipe a person follows by hand, and the recipe is mostly platform specifics:
a permission-classifier config, a shared-memory CLI, a roster of real people, a
placeholder-session migration for a naming ritual that is folklore rather than
mechanism. None of that crosses.

What crosses is the mechanism underneath it, which is small:

- an agent is **two** directories, and the two systems that care disagree about
  which one defines it. The launcher scripts here call a directory an agent iff
  it holds `SOUL.md`; the application calls it an agent iff it is a directory
  under the inbox root. Either one alone gives you an agent that is bootable and
  invisible, or visible and unbootable. Creating both at once is most of the job;
- settings files are **merged, never replaced**. Other systems keep their hooks
  in the same file, and a replacing write deletes them with nothing anywhere
  saying it happened;
- the self-authoring placeholders in `IDENTITY.md` and `SOUL.md` are left in
  place on purpose. A hand-written personality reads as costume and the agent
  drifts back out of it, so the script scaffolds the structure and writes none
  of the content;
- and the acceptance test, which is the reason the script exists at all rather
  than a paragraph in the README telling you which directories to make.

That test asks the new agent to state a random boot phrase written into its
persona file at creation, in one non-interactive turn from the agent's own
directory. It is the only check in this area whose success requires the whole
mechanism to have worked, because the answer has to come back through the thing
being tested. Every cheaper check passes while the thing is broken: the file is
present when the context assembly silently dropped it, the hook exits 0 when it
emitted nothing useful, the settings file exists after another tool's hooks were
overwritten out of it. **Files existing is what all of those failures look
like.**

The phrase, rather than the name, is what the check asserts on. The agent's name
reaches the model anyway through the working directory, so a session carrying no
persona at all answers a name question correctly, and a check built on the name
would report success in exactly the case it exists to catch.

## Ported, removed, restored: the `inbox` CLI

The inbox DM protocol implementation, the concrete counterpart to the
description in `SYSTEM.md`, was ported into this package as `bin/inbox.mts`
(a Python-to-TypeScript port, checked against the original byte for byte on
the same inputs) together with a real test suite, including a concurrency
stress test using real OS subprocesses against its cross-process lock.

Both the CLI and its tests were then **removed, deliberately**. The
application in `packages/deck` landed carrying its own implementation of the
same protocol, the one the internal platform actually runs, and two readers
of one on-disk format in one repository drift apart: every fix or tolerance
added to one and not the other becomes a silent interoperability bug. The
protocol would have exactly one normative artefact here, `docs/protocol.md`,
and exactly one implementation, the application.

**That was wrong, and the CLI is back**, now as `bin/inbox`, python3, copied
and cleaned from the internal fleet's working implementation rather than
reimplemented, with `bin/inbox-push` (the live tmux delivery half),
`bin/pane-idle` (the one definition of "is this pane busy", which `inbox-push`
cannot run without) and the ported suites in `test/inbox.test.sh` and
`test/inbox-push.test.sh`.

The removal reasoning was right about the risk and wrong about the
requirement. The application is a web server, and an agent lives in a tmux
pane with no browser: "the application already implements the protocol"
described a surface the agents themselves cannot reach, so removing the CLI
did not remove a redundant second implementation, it removed the only tool
they had. A live end-to-end test settled it. A newly created agent could
receive messages and had no way to reply, while every message the application
pushes into a pane ends with the hint `[reply via inbox: inbox reply <name>]`,
naming a command that did not exist in this repository.

The drift concern was not silly, and it still has to be answered. The answer
is `conformance/corpus.json`: one body of shared test data keyed to
`docs/protocol.md`, with a thin adapter per implementation (`run_cli.py` here,
`test/blocks/conformance.test.ts` in `packages/deck`), and a deviation record
for each known departure. A recorded deviation must still reproduce exactly,
so one that changes shape fails; and the runner also asserts the implementation
does not produce the right answer, so a deviation that gets FIXED fails until
its record is deleted. The corpus holds both to the specification, never to
each other.

Running it produced the finding worth having: **both implementations already
deviate from the spec**, the CLI on three of the nineteen cases and the
application on seven, and three of those are the same defect in both. Both
take block boundaries from every `## ` line and only afterwards discard the
ones whose header fails the grammar, where section 4 requires the opposite
order, so a message body containing a markdown heading is truncated at that
heading on every read. The two agree with each other and disagree with the
document. The application's other four are its own: a header in another case
does not parse, an empty subject with no trailing space does not parse, an
unparseable timestamp loses the block rather than tolerating it, and an
indented header-shaped line wrongly starts a block. `corpus.json` carries the
reason for each.

The original port was not wasted either. Its conformance findings were folded
into the spec before the code went:

- the requirement that the status flip locate the `sent` token via the header
  grammar's own `status` capture group, never a loose first-match search (a
  loose search can match inside a sender name shaped like `status:sentinel`
  and corrupt the file);
- the rule that a column-0 `## ` line failing the header grammar MUST be
  treated as body content, never as a block boundary (the original silently
  truncated messages at markdown headings typed inside a body);
- code points, not UTF-16 code units, as the reference definition for
  character counts;
- the known read-then-flip atomicity deviations, recorded in
  `docs/protocol.md` section 11 so no implementer copies them as behaviour.

If you are writing your own client, implement `docs/protocol.md`; its section
10 lists the conformance properties a test suite should exercise, and
`conformance/corpus.json` is the data to run them against.
[`docs/conformance.md`](conformance.md) explains how that corpus is structured,
what it deliberately does not cover, and the rules for adding a case or
recording a deviation.
