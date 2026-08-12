# Tooling review

Status of the scripts behind the pattern this repo describes: which are
ported, which were ported and then removed, and why.

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

## Ported, then removed: the `inbox` CLI

The inbox DM protocol implementation, the concrete counterpart to the
description in `SYSTEM.md`, was ported into this package as `bin/inbox.mts`
(a Python-to-TypeScript port, checked against the original byte for byte on
the same inputs) together with a real test suite, including a concurrency
stress test using real OS subprocesses against its cross-process lock.

Both the CLI and its tests have since been **removed, deliberately**. The
application in `packages/deck` landed carrying its own implementation of the
same protocol, the one the internal platform actually runs, and two readers
of one on-disk format in one repository drift apart: every fix or tolerance
added to one and not the other becomes a silent interoperability bug. The
protocol has exactly one normative artefact here, `docs/protocol.md`, and
exactly one implementation, the application.

The port was not wasted. Its conformance findings were folded into the spec
before the code went:

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

If you need a standalone CLI for the protocol, implement `docs/protocol.md`;
its section 10 lists the conformance properties a test suite should exercise.
