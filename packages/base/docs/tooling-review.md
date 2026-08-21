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
deviated from the spec**, the CLI on three of the nineteen cases and the
application on seven, and three of those were the same defect in both. Both
took block boundaries from every `## ` line and only afterwards discarded the
ones whose header failed the grammar, where section 4 requires the opposite
order, so a message body containing a markdown heading was truncated at that
heading on every read. The two agreed with each other and disagreed with the
document, which is precisely what a check of the form "do the two produce the
same answer" would have certified as fine.

That defect is closed in both readers as of 2026-08-14, fixed in the protocol
implementation this package was copied from and ported here. Closing it is
what deleted the three shared records: a deviation that gets fixed fails the
suite until its record is deleted, so the numbers in this paragraph are the
tree's rather than a memory of it. The CLI now conforms on all nineteen cases.
The application's remaining five are its own: a header in another case does not
parse, an empty subject with no trailing space does not parse, an unparseable
timestamp loses the block rather than tolerating it, an indented header-shaped
line wrongly starts a block, and its header grammar accepts a status-less
header that the CLI treats as body, so the two now disagree about what is a
header rather than about where a block ends. `corpus.json` carries the reason
for each.

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

### Drift audit of `bin/inbox` against the implementation it was copied from

The copy here and the one it came from were diffed line by line, and every
behavioural difference between them classified. Comment and docstring rewording
is not listed; it is most of the diff and none of the behaviour. What follows
is the whole of the rest.

**Two write-time guards had been left behind, and are now ported.** Both refuse
a send outright, and both are refusals rather than warnings for the same
reason: what they catch is invisible to the sender afterwards.

- **The card metadata region is now parsed as YAML before the block is
  written** (`validate_card_metadata`). `docs/protocol.md` section 7.1 has
  always said the region MUST be valid YAML and that a scalar containing a
  colon MUST be quoted; nothing here enforced it. An unquoted colon in a
  `label:` or `detail:` value is read as a nested mapping, the parse breaks,
  and a renderer shows the block as plain prose with no error, which its
  re-serialiser then makes permanent. The sender sees `replied to ...`. This
  cost a real user two messages in one morning upstream before the check
  landed there. The port brings the optional PyYAML dependency described in
  the package README: present, cards are checked; absent, cards are refused
  and say why, and everything else runs on a stock python3.

  What was already here and is NOT the same thing: a heuristic that inserts a
  blank line after the metadata run when prose follows it immediately. That
  fixes an unterminated region, a different defect, and does nothing about an
  unparseable one. Both now run, in that order, so the YAML check sees the
  text that will actually be sent.

- **Bare, unlinked references are now refused, if you configure a pattern**
  (`INBOX_BARE_REF_PATTERN`, `INBOX_BARE_REF_TO`). The original hardcoded one
  deployment's conventions throughout: a single change-request syntax, a
  single ticket prefix, two named human recipients, and two URL templates for
  the error message. None of that is true of anyone else, so here the pattern
  is the configuration, the check is off until one is supplied, and the error
  message names the offending reference rather than guessing a URL for it. The
  audience filter survives as a setting because the reason for it generalises:
  the original applied only to messages to humans, since agent-to-agent
  threads were not the problem, and a check that fires everywhere gets
  switched off. The markdown-link-stripping strategy is kept verbatim, being
  the load-bearing part.

**Deliberate genericisations, already correct, left alone.** `INBOX_ROOT`
replacing a hardcoded home-directory root; `default_push_bin()` resolving
`inbox-push` as a sibling of this file rather than at a fixed absolute path;
`resolve_attachments_root()` reading only the environment variable, having
dropped a fallback that parsed one specific deployment's `.env.production`;
`HEADER_RE` built by concatenation from `SEP_PATTERN` rather than spelling the
separators out three more times; and the separators themselves written as
codepoint escapes rather than literal characters, since the character is
protocol syntax here and a literal one in source is a parsing hazard.

**Internal-only, correctly absent, and staying that way.** The
`.env.production` fallback above is the whole of this category: it is coupled
to one deployment's filesystem layout, and this repository's own application
requires `ATTACHMENTS_ROOT` in its environment anyway, so there is one
contract rather than two.

**Present here and not upstream**, for completeness: the `reply` subcommand's
epilog documenting the document-link form from section 7.2, and the comment in
`flip_blocks_in_file` recording the loose `status:\s*(sent)` search as a known
deviation. That deviation is real, is shared with the implementation this was
copied from, and is described in `docs/protocol.md` section 8.3. It is not
fixed here, for the reason given in the code: changing behaviour is a separate
reviewable decision rather than something to slip into a drift audit.
