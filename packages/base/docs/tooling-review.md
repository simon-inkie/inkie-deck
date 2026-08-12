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
