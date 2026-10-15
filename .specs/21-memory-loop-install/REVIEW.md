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
| 5ae2586 | REVIEW.md commit ids |
| 887d0b3 | REVIEW.md leak-gate fix |
| ce2c6a2 | round 5 fixes |
| 1cf33f5 | round 6 fixes |
| be8d318 | round 7 fixes |
| b0b1469 | round 8 fixes |

## Open maintainer decision

The first two commits in the table above carry a `Claude-Session:` trailer that the
repository's private-session-link leak rule flags in
`pnpm check:leaks:messages` (not part of the required CI list). Removing it
needs a history rewrite and a force-push, which were ruled out for this work.
Later commits omit the trailer. A squash merge must drop those lines from its
message, or the maintainer can authorise a rewrite. Raised in rounds 1, 3, 4 and 5.

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
| Major | Symlinked per-agent settings file escaped the per-agent boundary | Partly fixed: rejected a symlinked `.claude` or `settings.json` at creation and before wiring. Round 4 showed this was too narrow, and round 5 showed it still was; see those rounds (not a complete fix at this point) | d5484a8 |
| Major | `Claude-Session` trailers in commit text | Open maintainer decision, see above | none |
| Minor | Tests did not substantiate a working loop (fixture failed before mutating) | Partly: failure-after-merge test added. An integration check producing a real observation needs a built checkout, listed as a follow-up | d5484a8 |
| Minor | Memory wired after a failed verification probe | Fixed: a failed probe (wrong phrase, empty reply, runtime error) leaves memory unwired with a reason; skipped or impossible verification still wires | d5484a8 |
| Minor (CodeRabbit) | An interrupt during memory wiring left no visible report | Fixed: handler prints `off (interrupted during memory install ...)` and restores settings; test | d5484a8 |

## Round 4 (head d5484a8)

| Severity | Finding | Outcome | Commit |
|---|---|---|---|
| Major | The symlink guard covered only `.claude` and `settings.json`, but the checkout's installer writes a temporary file and a backup beside the settings and both follow links; a planted link could overwrite another file, and `USER_NAME` was stamped through a symlink with `on` reported | Partly fixed: memory refused, nothing written, on ANY symlink in `.claude` (hard links and a symlinked agent home were missed, see round 5); containment re-checked after the installer and before stamping or reporting on (a link that appeared gives PARTIAL). Tests: planted temporary-file link, planted backup link, symlinked `.claude` directory | df04422 |
| Minor | The settings snapshot leaked in the temp directory after an interrupted install, and was created with the settings file's mode | Fixed: created 0600, no `cp -p`, removed in the signal handler; test that no snapshot remains after SIGTERM | df04422 |
| Minor | A comment claimed the installer is never cut off, true only for a signal to the script's own process | Fixed: comment reworded. A regular temporary file the failed run created is removed after the restore | df04422 |
| Nit | A backup stayed in `.claude` after a restore | Fixed: files the failed run created are removed after the restore; a backup left by a successful install is kept and documented in INSTALL.md | df04422 |

## Round 5 (head 887d0b3)

| Severity | Finding | Outcome | Commit |
|---|---|---|---|
| Major | The guard looked only for symlinks. A HARD link named like the installer's temporary file made the installer rewrite the shared file and rename it over the agent's settings; an agent home that is itself a symlink to a parent of `.claude` passed both checks and wired global settings | Partly fixed, and an overstatement when written: refuse when the agent home is a symlink or `.claude` does not resolve to `<agents home>/<name>/.claude`, at creation and before wiring; refuse when any file in `.claude` has a link count above one, or any `settings.json.*` entry exists before the install; re-check after the install; the restore also refuses a hard-linked settings file. Tests for both cases with installer-style temporary and backup names (round 8 replaced an earlier runtime-assembled spelling with neutral names), plus a hard link appearing during the install. NOT fixed, by nature: a link planted in the instant between the check and the installer's write is only caught afterwards, once the write has happened. This is acceptable only under a same-user threat model, and is stated in the SPEC and INSTALL.md. Round 6 found this still missed a hard-linked settings.json already in place, a find that failed open, and creation failing for a not-yet-existing agents home under a symlinked ancestor | ce2c6a2 |
| Minor | A signal inside the exit handler while the installer is not running printed no memory line, and the `USER_NAME` write was in place | Fixed: the handler prints whenever it runs inside the exit handler, tracking the stage (`off ... before the install ran`, `PARTIAL ... after the install ran`, `on (interrupted before USER_NAME was stamped)`); `USER_NAME` is written through a temporary file and a rename. Test: signal during the post-install check | ce2c6a2 |
| Minor | REVIEW.md overstated the round 3 and 4 symlink rows, and the trailer line omitted round 4 | Fixed: rows corrected, trailer line lists every round | ce2c6a2 |
| Nit | The temp-directory test did not assert the snapshot mode, and the planted-link tests used invented names | Fixed: asserts 0600 while the install is held; installer-style neutral names | ce2c6a2 |
| Nit | A stray blank line split a bullet in INSTALL.md | Fixed | ce2c6a2 |

## Round 6 (head 3b96653)

| Severity | Finding | Outcome | Commit |
|---|---|---|---|
| Major | First-time creation failed with a scaffold error when the agents home did not exist yet and its path had a symlinked ancestor or a trailing slash (`readlink -f` fails on two missing components) | Fixed: containment moved to node, resolving the deepest existing ancestor and appending the rest. Tests: symlinked ancestor with a not-yet-existing agents home, and a trailing slash | 1cf33f5 |
| Major | A hard link already in place on `settings.json` itself was written through (the scaffold writes in place) | Fixed: `settings.json` must be a regular file, not a symlink, with a link count of one, or creation is a scaffold error. Test. (Writing through a temporary file and a rename was not added; the refusal is the guard.) | 1cf33f5 |
| Minor | `find` failed open: a missing or failing find meant clean, so a hard link planted during the install and a pre-existing hard-linked settings.json gave `on` | Fixed: the whole check runs in node and fails closed (any error means not contained). Tests: hard link during the install gives PARTIAL | 1cf33f5 |
| Minor | The `USER_NAME` stamp used a predictable temporary name that a planted link could redirect | Fixed: random name opened with the exclusive-create flag, mode set with an explicit chmod, and the containment check repeated before `on` is reported | 1cf33f5 |
| Minor | Links pointing the other way (`$HOME/.claude` to the agent's directory, an agents home that resolves above `$HOME`) were not seen | Fixed for `$HOME/.claude/settings.json` and `$CLAUDE_CONFIG_DIR/settings.json`: the agent's settings must not be the same file by path or by inode. Not covered: global settings kept in any other location. The docs say so. Tests: reversed link, CLAUDE_CONFIG_DIR | 1cf33f5 |
| Minor | REVIEW, SPEC and INSTALL overstated the earlier fixes | Corrected here, in the SPEC and in INSTALL.md | 1cf33f5 |
| Nit | The signal line said `before USER_NAME was stamped` when the stamp had finished, and the stage covered gaps | Improved: a `stamping` stage with a hedged line; the stage is set before the install flag drops; an unarmed run (`--verify-only`) is excluded from the exit-handler branch only; an interrupted `--verify-only` probe still prints `memory off (run interrupted before memory was wired)`, which is a known wart (round 7, skipped). Remaining limitation: an interrupt in the few instructions between the stamp finishing and the stage being set reads as `stamping`. Also found and fixed while testing: a signal handler's output was being lost when it ran inside a command with its output redirected to /dev/null, so it now prints through a saved copy of stdout | 1cf33f5 |

## Round 7 (head c616a9d)

Scope was narrowed by the maintainer to the real defects; the rest was skipped on purpose.

| Severity | Finding | Outcome | Commit |
|---|---|---|---|
| Minor (real behaviour) | A saved copy of stdout (fd 7) was inherited by every child, so a detached grandchild kept the caller's pipe open (`create-agent \| tail` took seconds longer) and replaced a caller's own fd 7 | Fixed: fd 7 is opened only inside the exit handler and closed for the installer and the node helper. Test: a detached child of the install does not hold the pipe (confirmed to fail without the fix) | be8d318 |
| Minor | `..` in the agents home is resolved by text in the check but through real directories by the shell, so with a symlink before it the check passed while persona files landed elsewhere | Fixed: an agents home with a `..` component is refused. Test | be8d318 |
| Minor | A global settings path that is a dangling symlink to the agent's not-yet-created settings is missed | Not fixed, by maintainer decision to avoid new machinery: the claim in INSTALL.md and the SPEC was narrowed to say so | be8d318 |
| Minor | `merge_settings` still writes in place after an earlier check | Not fixed, by maintainer decision: documented in INSTALL.md and the SPEC as a limitation under the same-user threat model | be8d318 |
| Nit | The scaffold error always gives the same generic reason | Skipped by maintainer decision | none |
| Nit | Wording about `--verify-only` printing, and the stage after the stamp | Skipped by maintainer decision, except that the false `--verify-only` claim in the round 6 row was corrected | be8d318 |
| Nit | A stale test count in the SPEC | The false count was removed | be8d318 |

## Round 8 (head 823d230)

| Severity | Finding | Outcome | Commit |
|---|---|---|---|
| Minor | A test assembled the memory layer's silo-style name from string pieces at run time to get past the literal scanner | Fixed: every such place (one, found by searching the tests, fixtures and docs for joins, concatenation and character codes) now uses a neutral installer-style name, and the leak gate passes with no workaround; the gate itself is untouched. Because the guard refuses a link under any `settings.json.<x>` name, the neutral names test the same behaviour | b0b1469 |
| Minor | The detached-child test asserted only elapsed time, so it could pass if scaffolding failed or the installer never ran | Fixed: before the timing assertion it now asserts the exit status, the `CREATED` line, that the fixture installer was invoked (its call log), the `memory on` line and the three wired hooks. Re-confirmed that it still fails without the `7>&-` on the installer, now at the timing assertion (3459 ms against a 2500 ms limit) | b0b1469 |

## Not done, by design

- Semantic search, paid-key setup, watcher and systemd, the rollout across
  repositories: out of scope for M1, listed in the SPEC follow-ups.
- Silo seeding through the real tsx and a real observation after a compaction
  were never run: the memory layer's dependencies could not be installed in the
  sandbox.
