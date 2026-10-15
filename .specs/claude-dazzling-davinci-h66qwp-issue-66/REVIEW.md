# Review log for PR #68 (issue #66)

Every finding from every review round, with severity, what was done (or why it
was deferred) and the short sha of the commit that did it. Rounds are in the
order they arrived. "Superseded" means a later round replaced the fix; the
later row says how.

Commits referred to (oldest first):

| Sha | Subject |
| --- | --- |
| 40f5943 | feat(deck): Markdown draft editor over workspace drafts folder |
| fb5663b | fix(deck): normalise draft line endings, JSON errors in save lock, lock sidecar |
| b2edbbb | docs(spec): record review-fix commit sha |
| e55184b | fix(deck): surface removed drafts, avoid false poll conflict, keep save result after write |
| a706a99 | docs(spec): record second review-fix sha |
| b0297fb | fix(deck): guard draft switching, stale responses, confinement and cross-origin writes |
| d9a13ea | fix(deck): typecheck in draft editor test, reword SPEC to pass leak gate |
| ddd1b7b | test(deck): fix mock typing in draft editor test |
| d30e9d4 | fix(deck): origin allowlist for draft writes, read-only while switching, capped fd reads |
| 8175afa | fix(deck): non-blocking draft reads, dev app origin allowlist, test env isolation |
| a5f6659 | test(deck): run FIFO tests in a child process with a hard timeout |

## Round 1: first Opus review at 40f5943

| # | Severity | Finding | Outcome | Commit |
| --- | --- | --- | --- | --- |
| 1 | Must fix | Browser saves post multipart FormData, which writes CRLF; the editor then stays dirty forever | Fixed: CR/CRLF normalised to LF before the size check and hash; route test posts multi-line text and reloads clean | fb5663b |
| 2 | Low | `view()` inside the lock can throw (directory at the path, file vanishing), giving a framework 500 | Fixed: errors inside the lock return JSON (400 for a directory, 500 otherwise) | fb5663b |
| 3 | Low | Sidecar read-modify-write locked per draft, not per sidecar | Fixed: the sidecar update takes its own lock, always after the per-draft lock | fb5663b |
| 4a | Small | Relative WORKSPACE_ROOT silently disables the feature | Fixed: logs a warning | fb5663b |
| 4b | Small | `request.formData()` buffers the body before the 1 MB cap | Documented as a known limitation (SPEC and PR); not changed | fb5663b |
| 4c | Small | SPEC Log said "see branch" instead of a short sha | Fixed | b2edbbb |

## Round 2: re-review at b2edbbb

| # | Severity | Finding | Outcome | Commit |
| --- | --- | --- | --- | --- |
| 1 | Medium | Draft deleted outside the editor: save gets 409 with no `current`, nothing is shown, Keep mine unreachable, poll ignores 404 | Fixed: visible "removed" alert from the poll 404 or a 409 without `current`, with "Keep mine and recreate" (force save) | e55184b |
| 2 | Low | Poll compared against the version captured before its await, so a save finishing mid-poll raised a false alert | Fixed, then superseded in round 3 by a generation counter | e55184b |
| 3 | Low | A failure after the write (sidecar lock, final read) returned 500 although the file was written | Fixed, then superseded in round 3 (the result is now always the version written) | e55184b |

## Round 3: Review A, Review B and CodeRabbit at a706a99

| # | Severity | Finding | Outcome | Commit |
| --- | --- | --- | --- | --- |
| A1 | Major | Switching or creating a draft silently discards unsaved edits (CodeRabbit raised the same item) | Fixed: `window.confirm` when dirty, before the POST on create; tests for decline, accept, clean, create | b0297fb |
| A2 | Major | A delayed save response can attach to a different draft's text | Fixed: response dropped when the text was replaced meanwhile; older open/create responses dropped; test fails without the guard | b0297fb |
| A3 | Major | Save response could return an agent's newer version as the next base | Fixed: result is the version this save wrote (hash, content, mtime right after the write) | b0297fb |
| A4 | Major | Confinement checked before an async lock wait; a swapped `drafts/` symlink could redirect a new file | Fixed: re-checked inside the lock right before the write and before the sidecar write; test fails without it | b0297fb |
| A5 | Major | Dev restart deletes drafts (workspace under the reseeded `.runtime/`) | Fixed: default dev workspace is `packages/deck/.workspace/`, gitignored | b0297fb |
| A6 | Major | No cross-origin write protection | Fixed with an Origin check (Host-based at this point; hardened in round 4) | b0297fb |
| A7 | Minor | `Claude-Session` trailers in three earlier commits (leak rule) | Deferred: needs a history rewrite, which was not allowed; later commits omit the trailer; a maintainer can strip them on squash merge | none |
| A8 | Minor | Poll test covered only the favourable ordering; no switch-during-save test | Fixed: old-GET-arrives-late test and switch-during-save test; generation counter in the poll | b0297fb |
| A9 | Minor | Reads unbounded and synchronous | Partly fixed: files over 1 MB never read (413, list without reading, save refuses); async rewrite deferred | b0297fb |
| B1 | Minor | Corrupt sidecar silently reset on next write | Fixed: copied to `.deck-drafts.json.bad` and logged first | b0297fb |
| B2 | Minor | "Removed" alert persists if the file reappears with identical content | Fixed: a 200 poll clears it | b0297fb |
| B3 | Note | Case-insensitive filesystem collisions not checked | Deferred: not examined in this slice | none |
| CR1 | Major | CodeRabbit: switching drafts discards unsaved edits; confirm when dirty | Fixed, same change as A1 | b0297fb |
| fix-up | n/a | Typecheck error in the new test and a leak-gate hit on shas written in SPEC prose, found by running the checks | Fixed | d9a13ea |
| fix-up | n/a | Mock typing in the new test | Fixed | ddd1b7b |

## Round 4: Opus review at ddd1b7b (approve with minor follow-ups, CI green)

| # | Severity | Finding | Outcome | Commit |
| --- | --- | --- | --- | --- |
| 1 | Minor | DNS rebinding defeats the Origin-vs-Host check; Host-rewriting proxies refused | Fixed: Origin checked against the shared allowlist (`VOICE_ALLOWED_ORIGINS`, default `http://localhost:$PORT` plus the dev port) via `resolveAllowedOrigins`; same-origin saves behind a proxy work when the origin is listed. The allowlist replaces the default when set, as for voice | d30e9d4 |
| 2 | Minor | Edits typed while an open/create is in flight are lost without a prompt | Fixed: textarea is read-only while the request is pending | d30e9d4 |
| 3 | Minor | Opening a draft over 1 MB shows a generic error | Fixed: the server's message is shown; test added | d30e9d4 |
| 4 | Nit | Size cap bypassable between stat and read; sidecar read unbounded | Fixed: one file descriptor, at most cap plus one byte, for drafts and the sidecar | d30e9d4 |
| 5 | Nit | `.bad` backup copy follows a symlink | Fixed: the path is removed (unlink acts on the link) and the copy is created exclusively; test added | d30e9d4 |
| 6 | Nit | Folder-swap race leaves the waiter's `.lock` file in the outside directory | Accepted as a known limitation, noted in the SPEC; the file holds only a token and is removed on release | none |
| 7 | Nit | Force-save buttons enabled during a save | Fixed: disabled while saving; test added | d30e9d4 |
| 8 | Nit | No tests for `Origin: null`, or a matching Origin with `Sec-Fetch-Site: cross-site` | Fixed: both added, plus DNS-rebinding and proxy-allowlist cases | d30e9d4 |
| 9 | Nit | PR description out of date | Fixed: regenerated from the SPEC (dev workspace path, test-plan head, 403 rule, proxy/allowlist behaviour, 413 handling) | PR body edit |

## Round 5: Opus review at 44b8686 (approve with minor follow-ups, CI green)

| # | Severity | Finding | Outcome | Commit |
| --- | --- | --- | --- | --- |
| 1 | Minor | `openSync(file, "r")` blocks on a FIFO named like a draft (or a symlink to one) before fstat can refuse it, freezing the server on list, open or poll (regression from the round 4 fd read) | Fixed: open with O_RDONLY and O_NONBLOCK, fstat, refuse non-regular files; same helper serves the sidecar. The first tests used mkfifo in-process; they hung rather than failed on regression, returned early (counted as passed) without mkfifo, and their symlink case was refused by the path check before the open ran. Reworked in round 6 | 8175afa |
| 2 | Minor | The dev launcher gave VOICE_ALLOWED_ORIGINS only to the voice proxy, so with `--port N` every draft write from the app got 403 | Fixed: the app environment now gets the same VOICE_ALLOWED_ORIGINS; a script-level source check covers it. Not exercised by running the launcher | 8175afa |
| 3 | Nit | `.env.example` should say browser saves need the origin listed in VOICE_ALLOWED_ORIGINS | Fixed | 8175afa |
| 4 | Nit | Tests hard-code localhost:4242 | Fixed: PORT and VOICE_ALLOWED_ORIGINS are cleared before and restored after every draft test | 8175afa |
| 5 | Nit | `Buffer.alloc(max + 1)` zero-fills 1 MB per list and poll | Fixed: `allocUnsafe`; only the bytes actually read are used | 8175afa |
| 6 | Nit | PR body footer carries the claude.ai session link | Fixed: removed from the PR description; the squash-merge note about older commit trailers stays | PR body edit |

## Round 6: Opus review at fd9bb56 (approve, CI green, no Critical or Major)

| # | Severity | Finding | Outcome | Commit |
| --- | --- | --- | --- | --- |
| 1 | Minor | FIFO tests hang instead of failing on regression (a blocked synchronous open ignores the test timeout) and return early where mkfifo is missing | Fixed: the cases run the real module in a child process (`node --import tsx`) with a 20 s hard timeout, so a regression fails cleanly (confirmed by removing the fix: both tests failed after the timeout); `it.skipIf(!hasMkfifo)` so a missing mkfifo reports as skipped. CI workflows not touched | a5f6659 |
| 2 | Nit | The symlink case pointed at a FIFO outside the workspace, so the path check refused it before the non-blocking open ran | Fixed: the link now targets a FIFO inside `drafts/` | a5f6659 |
| 3 | Nit (optional) | Stat before opening so a device node is not opened first | Done as a mitigation: `statSync` rejects non-regular files before the open; the `fstat` after the open stays authoritative, so a swap between the two cannot bypass the check. With the pre-check in place the in-process FIFO cases are stopped by it, so the O_NONBLOCK open is only reached in a swap race and is not independently covered by a test | a5f6659 |
| 4 | Nit | REVIEW.md round 5 row 1 overstated the tests | Fixed: reworded; this round added | this docs commit |
| 5 | Out of scope | Pre-existing blocking `readFileSync` in `withInboxLock` (`safe-fs.server.ts`) | Not changed; recorded in the SPEC as a known pre-existing limitation | none |

