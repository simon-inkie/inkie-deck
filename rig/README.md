# rig - the clean-machine harness

What this repository claims about installing itself is only worth what it has
been measured to be worth on a machine that has never run it. Every machine
that has run this product so far already had the things the product turns out
to assume, which is why nobody noticed the assumptions: a live git
repository, ripgrep on `$PATH`, curl before you can even install Node. The rig
is the instrument that finds the next one of those.

It runs a declared list of STAGES inside throwaway containers built from a
bare OS image (`ubuntu:24.04`), and writes `rig/out/report.json` plus
`rig/out/summary.md`.

## Running it

```sh
node rig/run.mjs --self-test   # the harness's own guards, no docker, ~1s
node rig/run.mjs               # the full run, containers and all
```

Requires docker and a clean working tree. Exit codes:

| code | meaning |
| --- | --- |
| 0 | every declared stage ran, every probe green, every negative control proven |
| 1 | PRODUCT failure: the product is broken in the measured environment |
| 2 | RIG failure: an instrument did not prove itself, or a declared stage did not run |

Codes 1 and 2 mean completely different things and are never merged. A product
failure is a finding. A rig failure means nothing in that report can be read at
all, because the instruments that produced it were not shown to work.

## The design, and what each part is a reaction to

**The stage list is declared up front** (`rig/stages/index.mjs`). The report
says "N of N ran" with both numbers taken from the declaration, and a declared
stage that did not execute fails the run. A harness that discovers its own
work list reports a triumphant green over the empty set on the day its
discovery breaks, in exactly the same words it uses when everything ran.

**Stage zero requires ABSENCE.** It probes the base image for node, pnpm,
corepack, tmux, git, curl and an `~/agents` directory and fails the whole run
if any is present, records the image digest, and asserts from outside the
container that it starts with zero mounts and no environment beyond `PATH`. If
the base is not provably bare, nothing downstream distinguishes "the product
works from a clean install" from "the base happened to carry the missing
piece".

**Source enters by `git archive` of a committed tree**, never a bind mount of
the working copy, because the mount is how `node_modules/`, `.runtime/` and
the dev build reach a container that is supposed to be measuring a clean
install. The commit is recorded; a dirty tree is refused unless `--allow-dirty`
is given, and the report then says so at the top.

**Every assertion ships a negative control that must fail in the expected
way**, and "in the expected way" means matched against the reason, not merely
against a non-zero exit. A control that goes red for an unrelated reason has
not exercised the probe it is supposed to validate; it is a false green
wearing a disguise. A stage with no control at all is a rig failure by
construction, so an assertion cannot be added without one.

**The test count is an instrument, not a colour.** "The suite exited 0" is
satisfied by a suite that quietly ran 67 fewer tests than it has, which is a
thing this suite has actually done on an unprepared machine. The rig asserts
the exact published figure and, on a shortfall, names the dependency the gap
implies.

**The installation document is executed, not read.** `INSTALL.md`'s fenced
shell blocks are extracted by `rig/lib/fenced.mjs` and sourced, in document
order, byte for byte, in containers built from a base with none of the tools
the document tells a reader to install. Nothing in `rig/` reimplements an
instruction in its own words: a verification script that runs `pnpm install`
because the document says `pnpm install` is a second artefact that agrees with
the document exactly once, and from the next edit onwards the document is
unverified while the script stays green. The runs are declared in
`rig/install-plan.mjs`, every executable block must be claimed by one, and a
block no run claims fails the rig, because an example nobody executes is an
example that has quietly stopped being true.

The runner does hold two pieces of knowledge the document's text cannot supply
on its own: which blocks never return, and which block's correct outcome is a
non-zero exit. Both are declared beside the sentence in the document that says
the same thing, and a probe requires that sentence to still be there. Reword
the paragraph and the rig goes red rather than carrying on against a private
assumption.

## Stages

| id | asserts | negative controls |
| --- | --- | --- |
| `base-attestation` | the base image is bare, unmounted, digest recorded | the same attestation against a base with git and `~/agents` planted must name both |
| `source-entry` | HEAD is committed and clean, the archive carries no developer state | a tar with a planted `node_modules` must be reported; a dirty status must be refused |
| `toolchain` | Node inside the `engines` range, corepack, pnpm at the `packageManager` pin, git, ripgrep, curl, tmux | a binary that does not exist must read as absent, never as success; the range evaluator must put 20.19.5, 22.9.0 and 23.11.1 outside the range and 22.13.0, 22.23.2 and 24.0.0 inside it |
| `documented-checks` | the README's own check list, green, with the published test count | the suite with ripgrep removed must go red naming it; the suite and leak gate with `.git` removed must go red naming the repository |
| `node20-floor` | `pnpm install` REFUSES Node 20, the refusal names the engine and quotes the range, and the message is recorded verbatim | the Node 20 image must be provably Node 20 with every other tool present, so the refusal cannot be blamed on a missing tool; and the same install must exit 0 on a permitted Node, so it cannot be blamed on the product being broken |
| `install-doc` | INSTALL.md parses unambiguously, every executable block is claimed by a declared run, and the sentences the runner's behaviour depends on are still in the document | an unclosed fence must raise rather than yield a partial list; a planted undeclared block must be reported unclaimed; removing the sentence that documents a long-running block must turn that check red |
| `install-try-it` | tier 1, executed from the document on a base with no node, pnpm, git, ripgrep, python3 or tmux: the toolchain installs, `pnpm dev` starts, and the page carries fixture data | the document's own verification command run against `dev:raw`, which starts and answers 500, must print no fixture agent at all; and the outside-the-namespace fetch must reach a server on the same port map that binds every interface, so the dev server's refusal is a statement about the bind |
| `install-run-it` | tier 2, executed twice from the same document: the four roots, the `.env`, `MC_USER` end to end, the build, the launcher, and the empty-state screen | the run WITHOUT the document's publish block must be refused from outside while answering 200 inside its own namespace; and the launcher with one required root emptied must exit non-zero naming it |
| `install-agents` | tier 3 as far as a machine with no model CLI goes: both of an agent's homes, the application listing it with no restart, a tmux window, the pane's contents rendered in the page, and a message round-tripping application to file to CLI and back | the launcher pointed at a home with no agents must exit non-zero naming it; the CLI with `AGENT_NAME` unset must refuse rather than guess an identity |

What tier 3 cannot do is install, authenticate and pay for a model CLI, so it
does not claim to. The stage asserts the two places the tooling declines to
overclaim instead: `create-agent.sh` exits 4 CANNOT VERIFY, and the live push
into a pane is skipped rather than typed. A run in which either of those
quietly succeeded would be the finding.

Phase 7 of the setup plan (the finished outputs) is done, and it added no stage
here. What it produced is a record rather than a measurement: the assumption
ledger the earlier phases accumulated is closed, with every entry either fixed
in the tree or written into `INSTALL.md` as a limitation this rig executes past
on every run, and the container question is worked through in
`rig/container-image-note.md`. There is deliberately no ledger file and no
Dockerfile. Both would be documents nothing executes, sitting in a repository
whose whole argument is that such documents stop being true without going red.

One stage is named and NOT built: a stub agent that can be started in a pane,
typed at, and asked what it received. Live delivery is proven refusing (stage
eight records a real refusal from a real pane on every run) and unproven
delivering, so
"a message typed into a ready pane lands" is a belief and is recorded as one in
INSTALL.md's limitations. It stays absent from the declaration rather than
appearing as a skip: a skip is a colour, and this rig has no colour for "we did
not look".

## Two things worth knowing before you read a report

The archived tree is turned into a git repository inside the image (`git init`,
one commit) before anything runs. Two of the product's suites and the leak gate
shell out to git against the repository root and fail without one. This keeps
the source-entry guarantee intact - the contents are still exactly a committed
tree - while giving the product the live repository it assumes. It also means
the rig cannot, by construction, measure the "downloaded a release tarball"
path; that needs a stage of its own.

Network egress is allowed, because installing Node from a bare Ubuntu requires
it. That makes the rig sensitive to what those package sources serve on the
day it runs, and the toolchain inventory in the report is what tells you what
you actually got.
