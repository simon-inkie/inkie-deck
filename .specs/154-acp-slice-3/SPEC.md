# #154: ACP Slice 3

- Issue: #154
- Branch: 154-acp-slice-3
- Started: 2026-11-25

## TL;DR
Add Codex ACP alongside Antigravity, permit concurrent ACP homes, and display
Codex quota through UsageReading. Live adapter behaviour remains subject to the
manual verification below; offline checks use synthetic processes only.
A failure at the final checkpoint sidecar rename can discard the prior sidecar
and leave Resume unavailable. A follow-up ticket tracks this case.

## Scope
In: runtime manifests, generic version probing, adapter auth/environment/usage,
per-home ACP admission and resume identity, quota mapping, route and UI wiring.
Out: dependencies, bundled adapters, interactive login, provider switching,
Flows, releases, pushes and pull requests.

## Contract
- ACP requires MC_ACP_RUNNER=1, .runner=acp and a registered .runtime.
- Codex uses codex-acp with no arguments, floor 2.6.0, NO_BROWSER=1,
  CODEX_HOME/CODEX_PATH/NO_BROWSER allowlisted, no API keys by default.
- Version output accepts bare semver or one token followed by semver on the
  first non-empty line. Errors name the selected adapter.
- Sessions are uncapped across homes. Per-home busy, lock, orphan and recovery
  guards, global recovery failure and shutdown gates remain fail closed.
- Resume binds capability evidence to the saved checkpoint, executable and
  manifest identity. Codex Resume requires a resolvable backend. Antigravity
  accepts original checkpoints and writes checkpoints the original reader
  can load.
- Environment defaults cannot forward reserved application variables.
- Azure quota is unknown from codex-azure. Missing, malformed, telemetry-off,
  stale and UNKNOWN quota is unknown from codex. Fresh confirmed blocked is
  exhausted, WARN is low, OK is ok. Fresh windows retain nullable reset times.
- Codex ACP quota requires a matching login-store fingerprint for the ACP
  login, observer and saved snapshot. The observer refreshes idle connections,
  reconnects on login-store changes and confirms recovery after two available
  full reads.
- Filesystem reads stay behind server helpers; routes receive UsageReading.

## Offline Test Matrix
- Manifests: runtime opt-in, unknown/missing runtime rejection, exact defaults,
  bare/prefixed/prerelease/below-floor/invalid version output and probe failures.
- Sessions: default env and reserved-variable stripping, adapter auth hint,
  optional usage hook and compatibility fallback.
- Registry: simultaneous adapters, independent prompt/cancel/stop, shutdown,
  same-home busy/locked/orphaned guards and changed-runtime resume rejection.
- Quota: telemetry off, missing/malformed/stale/UNKNOWN at 100%, OK/WARN/blocked,
  Azure, nullable/ISO resets, injected observer environment.
- Routes/UI: per-agent dispatch, windows and reset labels, seam/import guards.
- Gates: targeted vitest; pnpm test; typecheck; boundaries; leaks; licence;
  lib-version; dashes; build. Commit before full tests requiring a clean tree.

## Manual Live Verification
Not run automatically; requires an operator-approved live session.
- [ ] Install @agentclientprotocol/codex-acp outside the repository.
- [ ] Verify codex-acp --version output and floor, executable PATH and args [].
- [ ] Run codex login in a terminal; confirm existing credentials are reused.
- [ ] Verify unauthenticated -32000 emits the codex login instruction.
- [ ] Start synthetic Codex and Antigravity homes concurrently; prompt, cancel
      and stop independently, then verify shutdown removes both process groups.
- [ ] Inspect advertised loadSession/resume support; resume a saved session.
- [ ] Confirm custom extensions fail safely and API keys are not inherited.
- [ ] Enable quota telemetry; compare windows and reset times with source data,
      then check stale, disabled and Azure provider displays.

## Log
### 2026-11-25: Plan and contract
- What changed: Recorded the supplied Slice 3 plan and offline/live checks.
- Why: Extend the existing ACP path without a second registry or dependencies.
- Supersedes: nothing, additive.
- Commits: this initial SPEC commit.

### 2026-11-25: Implementation and deterministic checks
- What changed: Added Codex manifest, generic version parsing, adapter defaults,
  auth and usage hooks, per-home admission, runtime-bound resume evidence,
  quota mapper/server seam, route dispatch and quota-window rendering.
- Why: Existing per-home lifecycle machinery already supports concurrency.
  Moved filesystem/probe operations to acp-manifest.server.ts to enforce the
  server boundary while retaining compatibility exports at the original path.
- Decision: The existing observer uses AVAILABLE_CONFIRMED, not OK/WARN.
  Fresh AVAILABLE_CONFIRMED maps to ok below 90 percent and low at or above
  90 percent, matching the existing quota component. Explicit OK/WARN inputs
  are also supported. Unconfirmed states stay unknown even at 100 percent.
- Compatibility: Existing capability-cache keys lack the manifest prefix and
  fail closed until a fresh negotiation records the new identity.
- Verification so far: targeted suite passed, 13 files, 187 passed and 3 skipped;
  build, boundaries, leaks, licence, library version and dash gates passed.
  Full suite is running. A new route test needed explicit union narrowing for
  the loader's error response before typecheck could pass.
- Blocker: Git metadata is mounted read-only outside this worktree. The first
  SPEC commit and implementation commit cannot be staged or written here.
  No push or pull request attempted. Manual live verification remains unrun.
- Supersedes: nothing, additive.
- Commits: pending writable Git metadata.

## Verification results

| Command | Result |
| --- | --- |
| `pnpm -C packages/deck exec vitest run test/runner/ test/acp-session.test.ts test/codex-quota-usage.test.ts test/seam.test.ts` | PASS: 13 files, 187 passed, 3 skipped |
| `pnpm test` | FAIL: Base 8 files / 206 passed; Deck 132 files passed, 14 failed; 2636 tests passed, 148 failed, 14 skipped |
| `TMPDIR=/var/tmp pnpm -C packages/deck exec vitest run test/flows/` | FAIL before collection: 11 files, no tests, temporary-directory creation unavailable in sandbox |
| `pnpm typecheck` | PASS |
| `pnpm check:boundaries` | PASS: no dependency violations |
| `pnpm check:leaks` | PASS: 632 files, 33 rules |
| `pnpm check:licence` | PASS |
| `pnpm check:lib-version` | PASS: 6 historical revisions, no collision |
| `pnpm -C packages/deck check:dashes` | PASS |
| `pnpm build` | PASS |
| `git diff --check` | PASS |
| ASCII scan of all changed/new files | PASS: 19 files |

Final focused recheck after strengthening shared-binary runtime identity and
narrowing the route loader response: 2 files, 22 tests passed.

Full-suite failures are confined to attachments, review, projects, safe-fs,
review-autolink and nine flow suites. Clean-tree assertions reject these
uncommitted edits; the sandbox prevents writing Git metadata to commit them.
Other failures involve fixture ownership checks beneath a temporary directory
with a Git ancestor, and attempts to create temporary directories outside the
sandbox's writable scope. No flow implementation or licence file was changed.
The requested alternate temporary-directory run could not collect tests in
this sandbox. A clean committed run in an environment with writable temporary
and Git metadata directories is still required. Live adapter checks are unrun.

### 2026-11-25: Final local verification
- What changed: Completed the required verification commands and recorded exact
  results above. Strengthened the runtime-switch test with two adapter names
  resolving to the same executable identity.
- Why: Prove manifest identity participates in resume gating independently of
  the executable hash, and distinguish verification blockers from ACP results.
- Supersedes: earlier in-progress verification status only.
- Commits: none created; staging and commits remain blocked by read-only Git
  metadata. The SPEC was created before implementation; its attempted initial
  signed-off commit failed before staging. All edits remain in this worktree
  on 154-acp-slice-3, unstaged. No other repository was edited or pushed.

### 2026-11-25: Pass 1 triage fixes (R1-1 and R1-2)
- What changed:
  - R1-1: Enforced manifest and executable identity binding inside
    `AcpRunnerRegistry.start(..., { resume: true })` before spawning so a
    switched runtime rejects with `LaunchFailure("start-failed")` and preserves
    `.acp-last-session`, with a regression test in `acp-registry.test.ts`.
  - R1-2: Gated `readAcpUsageReading` on `trusted && optedIn` in `api.acp.tsx`
    and `trusted` in `threads.$agent.tsx`, and enforced `acpRunnerEnabled(env)`
    inside `readAcpUsageReading` so untrusted or flag-off calls return an
    unknown reading without touching `loadCodexQuotaDisplay` or the observer,
    with `.runtime=codex` tests in `acp-routes-and-steps4-6.test.tsx`.
- Why: Address the Pass 1 review findings scoped to this change.
- Supersedes: nothing, additive.
- Commits: `d2d9d15` (SPEC), `515dff1` (implementation); Pass 1 fixes unstaged
  pending review.

### 2026-11-25: Finish resume and quota guards
- What changed: Completed the pending direct-start resume and request-origin
  quota fixes (retrospective for the previously unstaged changes). Bound
  resume evidence to the exact saved checkpoint as well as the adapter and
  executable. Updated the original resume fixtures to negotiate a checkpoint
  before testing adapter failures, and supplied same-origin proof in trusted
  route fixtures.
- Why: A failed start under another runtime can advertise resume support
  without saving a checkpoint. Capability evidence must stay with the
  checkpoint that generated it. Cross-site and flag-off requests must avoid
  the Codex quota observer and return a generic unknown reading.
- Compatibility: Legacy capability records lack checkpoint identity. They
  fail closed until a successful new session saves fresh evidence.
- Supersedes: previous in-progress verification status.
- Commits: this signed-off follow-up to `515dff1`.

### 2026-11-25: Local verification of the follow-up
- Focused checks passed: 78 manifest, session, quota and import/seam tests;
  2 registry tests, including concurrent scripted adapters and runtime-switch
  refusal; 3 resume failure tests and 5 route cases.
- Required checks passed: `TMPDIR=/var/tmp pnpm typecheck`, boundaries,
  licence, library version and build.
- The normal leak wrapper hit `spawnSync git EPERM` here and on the base
  revision. The same scanner passed 632 repository files and 33 rules when
  supplied the `git ls-files` selection directly. The dash wrapper timed out;
  its direct ripgrep scan found zero matches. The changed files passed the
  ASCII and whitespace checks.
- Base conformance failed with `spawnSync python3 EPERM` on both the Slice 3
  checkout and base revision. The bounded `pnpm test` rerun timed out while
  still in Base. The independent Deck run encountered sandbox temporary
  directory, subprocess and timeout failures before it was interrupted.
  No aggregate test count was available for those runs.
- The original worktree's Git metadata is read-only in this environment.
  The commit and clean-tree checks used a local writable checkout.
- Live verification remains open for every item in Manual Live Verification.

### 2026-11-25: ACP resume and quota review fixes
- What changed: Store the checkpoint and its resume evidence in one atomic
  write (R1-1). Bind Codex resume to the executable selected by the adapter
  and its session store (R1-2). Keep the active adapter's quota source and
  refresh quota on stopped threads (R1-3 and R1-4). Use the supplied quota
  environment and surface version-probe and observer startup failures (R1-5
  and R1-7).
- Why: Preserve the previous checkpoint after a failed write, refuse resume
  under changed Codex configuration, and keep quota status current and
  diagnosable.
- Compatibility: Existing Codex checkpoints require a fresh Start to record
  the executable and store. Existing Antigravity resume evidence is readable.
- Verification: Typecheck and all nine new regression cases passed. The five
  focused Vitest files had 50 passes and 11 failures. The same 11 tmux and
  ACP subprocess failures and the same unhandled rejection reproduced at the
  original revision.
- Supersedes: Separate writes of the checkpoint and resume evidence.
- Commits: pending writable Git metadata. The signed-off commit attempt could
  not create the index lock.

### 2026-11-25 - Round 6 disconnect fixture

- The Round 6 blocker-retention test stalled after receiving all 501 chunks.
  Both halves of the Pass 1 diff reproduced the timeout when reverted
  separately. The previous commit, `725e817`, also timed out. That commit
  switched the fixture to filesystem streams on stdin and stdout. A standalone
  reproduction confirmed that `process.exit()` can hang during shutdown with
  a blocking filesystem read on stdin and complete once the parent closes stdin.
- End the fixture's stdout after the queued writes so Deck sees EOF. Wait for
  the registry to finish stopping and assert that it retained both the final
  chunk and the blocking card.
- The isolated Round 6 test passed 2 of 8 runs before the fix and 8 of 8 after
  at a 30-second diagnostic timeout. The six failures were timeouts. The fixed
  test also passed 8 of 8 at the standard 5-second timeout. Typecheck passed.
- The file passed 15 tests before stalling in the separate Rounds 9-10 case.
  That case also stalled on unmodified HEAD. A run excluding it passed all 15
  selected tests.
- Git could not create the index lock on the read-only metadata mount. The
  fixture and SPEC edits remain uncommitted.

### 2026-11-25: Review pass 2 resume and quota fixes

- The branch already contains the Round 6 fixture repair in `3f2aba0`. R2-5
  is accepted. The repair stays because the blocking stdin read caused a
  real fixture shutdown hang. The preceding working-tree Log entry records
  its reproduction and verification.
- R2-1 adds the resolved Codex store directory's device and inode to resume
  evidence. A replacement directory at the same path requires a fresh Start.
  Existing Codex checkpoints also need a fresh Start to record the new key.
- R2-2 uses Deck's literal `DATA_ROOT` resolver in both quota paths to keep
  reads and writes in the same instance when the path contains whitespace.
- R2-3 reports sanitized observer startup and exit errors in Deck's server
  log. R2-4 starts a bounded stderr drain at child exit so inherited pipes
  cannot hold up reconnect indefinitely.
- Verification passed for typecheck, 33 quota tests and four focused registry
  and fixture tests. The concurrent-adapter and Round 6 cases timed out on the
  first parallel run and passed on a single-worker rerun at the standard
  timeout. Both also passed with one worker on `3f2aba0`.
- The worktree changes remain unstaged. Git could not create the index lock
  on the read-only metadata mount for the signed-off commit.

### 2026-11-25: PR #249 triage follow-up

- Devin 4701575237: Refresh quota after at most five minutes with the default
  staleness setting. Shorter settings shorten the interval to half the
  staleness window, with a one-second floor. Retry malformed or failed
  responses and reconnect on timeouts.
- Independent quota recovery: Two available full reads move a confirmed block
  through candidacy to availability. Sparse updates alone leave recovery
  unconfirmed.
- Devin 4701575353: Match the active or configured ACP login store to the
  observer configuration and the snapshot's hashed store identity. Older
  snapshots without that identity yield unknown in ACP until a fresh sample.
- Devin 4701575495: A Codex shim with an unresolved backend can Start, with
  Resume gated on verifiable executable identity.
- Devin 4701575741: Read original Antigravity sidecars and intermediate
  embedded evidence. New checkpoints use a single-line session ID and a
  bound sidecar with an Antigravity key compatible with rollback. Both files
  are staged before publication. Interrupted publication fails closed.
- Follow-up (Devin 4701575915): Run the operator-approved saved-session Codex
  Resume check in Manual Live Verification. The recorded live run covered
  version probe, Start, prompt and shutdown. Verify that Resume reopens the
  saved session ID and record the adapter version and result.
- Verification: Typecheck and 137 focused Vitest tests passed. The broader
  run reported 11 tmux and ACP subprocess failures and one unhandled rejection.
  The same cases reproduced on the unmodified PR head. The requested
  temporary directory was on a read-only mount, so the gates used a disposable
  directory under /tmp.
- Supersedes the earlier fail-closed upgrade for original Antigravity
  checkpoints and the embedded checkpoint write format.
- Changes remain in the working tree.

### 2026-11-26: PR #249 quota verification fixes

- R2-2: Fingerprint the credential file using filesystem metadata only. A
  replacement or rewrite hides the previous snapshot immediately in ACP.
  The observer clears the old quota and ignores responses from its prior
  connection. A running ACP session with an outdated launch fingerprint
  needs a new launch to match the new snapshot.
- R2-6: Recheck the login store before periodic reads and when processing
  observer messages. Reconnect and resample when the store becomes resolvable
  after first-run sign-in.
- Ticketed follow-up: A failure at the final checkpoint sidecar rename can
  discard the prior sidecar and leave Resume unavailable.
- Verification: `pnpm typecheck`, 68 quota tests and the focused ACP loader
  test passed. The requested temporary directory was on a read-only mount,
  so the gates used a disposable directory under `/tmp`.

## Exact changed files

- `.specs/154-acp-slice-3/SPEC.md`
- `packages/deck/app/components/AcpThreadView.tsx`
- `packages/deck/app/lib/acp-session.server.ts`
- `packages/deck/app/lib/acp-usage.server.ts`
- `packages/deck/app/lib/codex-quota-display.server.ts`
- `packages/deck/app/lib/codex-quota-observer.server.ts`
- `packages/deck/app/lib/codex-quota-store.server.ts`
- `packages/deck/app/lib/codex-quota-usage.ts`
- `packages/deck/app/lib/codex-quota.ts`
- `packages/deck/app/lib/runner/acp-manifest.server.ts`
- `packages/deck/app/lib/runner/acp-manifest.ts`
- `packages/deck/app/lib/runner/acp-registry.server.ts`
- `packages/deck/app/routes/api.acp.tsx`
- `packages/deck/app/routes/threads.$agent.tsx`
- `packages/deck/test/acp-session.test.ts`
- `packages/deck/test/codex-quota-observer.test.ts`
- `packages/deck/test/codex-quota-usage.test.ts`
- `packages/deck/test/codex-quota.test.ts`
- `packages/deck/test/fixtures/acp-agent.mjs`
- `packages/deck/test/runner/acp-manifest.test.ts`
- `packages/deck/test/runner/acp-registry.test.ts`
- `packages/deck/test/runner/acp-review-round2.test.tsx`
- `packages/deck/test/runner/acp-routes-and-steps4-6.test.tsx`
- `packages/deck/test/runner/import-graph.test.ts`
