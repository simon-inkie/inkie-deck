# Review log for #21 (PR #67)

Every finding from every review round, with severity, what was done or why it
was deferred, and the commit. Commits on this branch, by short id:

| Id | What |
|---|---|
| f76901c | initial implementation |
| 54efe35 | SPEC id fix |
| 42266ec | round 1 fixes |
| 945d527 | merge of main, round 2 fixes |
| d5484a8 | round 3 fixes |
| df04422 | round 4 fixes, adds this file |

## Open maintainer decision

The first two commits in the table above carry a `Claude-Session:` trailer that the
repository's private-session-link leak rule flags in
`pnpm check:leaks:messages` (not part of the required CI list). Removing it
needs a history rewrite and a force-push, which were ruled out for this work.
Later commits omit the trailer. A squash merge must drop those lines from its
message, or the maintainer can authorise a rewrite. Raised in rounds 1 and 3.

## Round 1, first review (first two commits)

| Severity | Finding | Outcome | Commit |
|---|---|---|---|
| Major | The "built" check tested only the dist directory, but the real installer merges hooks and then exits 2 when tsx is missing, leaving hooks written while memory reports off | Fixed: the three hook scripts and tsx are checked before the installer runs; settings untouched when missing | 42266ec |
| Major | `Claude-Session` trailers on both commits flagged by the message gate | Open maintainer decision, see above | none |
| Minor | Test file rebuilt a denied name with a string join to pass the leak gate | Fixed: neutral fixture silo name | 42266ec |
| Minor | The probe's `claude -p` fires the memory hooks, so every first memory would be the probe turn | Fixed: memory is wired on exit, after the probe; choice recorded in the SPEC | 42266ec |
| Nit | Fixture lacked PreCompact matchers and the dist and tsx prerequisites | Fixed: stricter fixture; tests for tsx missing and for matchers | 42266ec |

## Round 2, re-review (head 42266ec)

| Severity | Finding | Outcome | Commit |
|---|---|---|---|
| Major | PR conflicted with main (`--model` work) | Fixed: merged main, kept both sides | 945d527 |
| Minor | INSTALL.md `sh` block unclaimed by the rig | Fixed: fenced `sh-manual` | 945d527 |
| Minor | Memory wired on a run killed by a signal | Fixed: INT, TERM and HUP clear the pending flag; test | 945d527 |
| Minor | SPEC and summary wording described the memory line wrongly, and printed "wired after verification" even when off | Fixed: conditional wording | 945d527 |

## Round 3, two reviews plus CodeRabbit (head 945d527)

| Severity | Finding | Outcome | Commit |
|---|---|---|---|
| Major | Memory could route to another agent when settings already carried a different `env.AGENT_NAME` | Fixed: refused before wiring, settings untouched; regression test | d5484a8 |
| Major | A failed install after hooks merged left active hooks while reporting off | Fixed: settings snapshot and restore, or an explicit PARTIAL report; tests for both | d5484a8 |
| Major | Symlinked per-agent settings file escaped the per-agent boundary | Fixed at creation and again before wiring (`.claude` and `settings.json`); test. Widened in round 4 | d5484a8 |
| Major | `Claude-Session` trailers in commit text | Open maintainer decision, see above | none |
| Minor | Tests did not substantiate a working loop (fixture failed before mutating) | Partly: failure-after-merge test added. An integration check producing a real observation needs a built checkout, listed as a follow-up | d5484a8 |
| Minor | Memory wired after a failed verification probe | Fixed: a failed probe (wrong phrase, empty reply, runtime error) leaves memory unwired with a reason; skipped or impossible verification still wires | d5484a8 |
| Minor (CodeRabbit) | An interrupt during memory wiring left no visible report | Fixed: handler prints `off (interrupted during memory install ...)` and restores settings; test | d5484a8 |

## Round 4 (head d5484a8)

| Severity | Finding | Outcome | Commit |
|---|---|---|---|
| Major | The symlink guard covered only `.claude` and `settings.json`, but the checkout's installer writes a temporary file and a backup beside the settings and both follow links; a planted link could overwrite another file, and `USER_NAME` was stamped through a symlink with `on` reported | Fixed: memory refused, nothing written, on ANY symlink in `.claude`; containment re-checked after the installer and before stamping or reporting on (a link that appeared gives PARTIAL). Tests: planted temporary-file link, planted backup link, symlinked `.claude` directory | df04422 |
| Minor | The settings snapshot leaked in the temp directory after an interrupted install, and was created with the settings file's mode | Fixed: created 0600, no `cp -p`, removed in the signal handler; test that no snapshot remains after SIGTERM | df04422 |
| Minor | A comment claimed the installer is never cut off, true only for a signal to the script's own process | Fixed: comment reworded. A regular temporary file the failed run created is removed after the restore | df04422 |
| Nit | A backup stayed in `.claude` after a restore | Fixed: files the failed run created are removed after the restore; a backup left by a successful install is kept and documented in INSTALL.md | df04422 |

## Not done, by design

- Semantic search, paid-key setup, watcher and systemd, the rollout across
  repositories: out of scope for M1, listed in the SPEC follow-ups.
- Silo seeding through the real tsx and a real observation after a compaction
  were never run: the memory layer's dependencies could not be installed in the
  sandbox.
