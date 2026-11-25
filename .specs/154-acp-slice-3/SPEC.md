# #154: ACP Slice 3

- Issue: #154
- Branch: 154-acp-slice-3
- Started: 2026-11-25

## TL;DR
Add Codex ACP alongside Antigravity, permit concurrent ACP homes, and display
Codex quota through UsageReading. Live adapter behaviour remains subject to the
manual verification below; offline checks use synthetic processes only.

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
- Resume binds capability evidence to the executable and manifest identity.
- Environment defaults cannot forward reserved application variables.
- Azure quota is unknown from codex-azure. Missing, malformed, telemetry-off,
  stale and UNKNOWN quota is unknown from codex. Fresh confirmed blocked is
  exhausted, WARN is low, OK is ok. Fresh windows retain nullable reset times.
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

## Exact changed files

- `.specs/154-acp-slice-3/SPEC.md`
- `packages/deck/app/components/AcpThreadView.tsx`
- `packages/deck/app/lib/acp-session.server.ts`
- `packages/deck/app/lib/acp-usage.server.ts`
- `packages/deck/app/lib/codex-quota-observer.server.ts`
- `packages/deck/app/lib/codex-quota-usage.ts`
- `packages/deck/app/lib/runner/acp-manifest.server.ts`
- `packages/deck/app/lib/runner/acp-manifest.ts`
- `packages/deck/app/lib/runner/acp-registry.server.ts`
- `packages/deck/app/routes/api.acp.tsx`
- `packages/deck/app/routes/threads.$agent.tsx`
- `packages/deck/test/acp-session.test.ts`
- `packages/deck/test/codex-quota-usage.test.ts`
- `packages/deck/test/fixtures/acp-agent.mjs`
- `packages/deck/test/runner/acp-manifest.test.ts`
- `packages/deck/test/runner/acp-registry.test.ts`
- `packages/deck/test/runner/acp-review-round2.test.tsx`
- `packages/deck/test/runner/acp-routes-and-steps4-6.test.tsx`
- `packages/deck/test/runner/import-graph.test.ts`
