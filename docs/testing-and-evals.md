# Testing and evals

## Unit and package tests

From the repository root, `pnpm test` runs both packages' Vitest scripts. To
run one file, use the owning package so its Vitest config and setup apply:

```sh
pnpm -C packages/deck test test/cron-validate.test.ts
pnpm -C packages/base test test/conformance.test.ts
```

- Put Deck tests in `packages/deck/test/` and Base tests in
  `packages/base/test/`. Name them after the feature, in kebab-case with
  `.test.ts`, or `.test.tsx` for JSX in Deck. Deck defaults to Node; use
  `// @vitest-environment jsdom` for DOM interactions, as in
  `packages/deck/test/scheduler-nav.test.tsx`. Browser journeys in
  `packages/deck/e2e/` run separately with `pnpm -C packages/deck e2e`.
- Cover the main behaviour, regressions worth catching, and refusals that
  prevent data loss, leaks, unauthorised writes or unexpected spend. For
  example, `packages/deck/test/file-description-cost.test.ts` tests cost
  arithmetic without calling a provider. Skip exhaustive low-risk edge cases,
  third-party behaviour, private implementation details and exact markup or
  class lists unless they are the contract under test.
- Write only to throwaway directories made with `mkdtemp` under `os.tmpdir()`;
  clean them up and restore environment stubs after the test. Read committed
  fixtures or copy them to the temporary directory before changing them.
  Deck's `packages/deck/test/setup.ts` enables `MC_SANDBOX_ONLY` but does not
  replace an explicit fake for external systems.
- `assertGitClean` is an isolation guard, not a product assertion. In files
  such as `packages/deck/test/review.test.ts` and
  `packages/deck/test/safe-fs.test.ts`, it checks `git status --porcelain`
  against a list of exceptions, so unrelated staged, unstaged or untracked
  work can fail the run. Check `git status --short` first. Run those suites
  from a clean checkout of the code you mean to test; stashing is useful for
  an unchanged baseline. While editing, run focused files without the guard.
  Do not expand the exception lists to hide your edits. Playwright's helper
  in `packages/deck/e2e/flows/helpers.ts` instead compares against a baseline
  taken before the tests.

## Shell scripts and the install rig

- Use a subprocess test for a CLI or shell script's exit code, output, and
  file changes. Follow `packages/base/test/setup.test.ts` for a Vitest wrapper
  with a temporary repo and PATH stubs. Existing `*.test.sh` suites are
  launched by `packages/base/test/shell-suites.test.ts`, which requires a
  zero exit and a non-zero pass tally. Run a single Bash suite directly with
  `(cd packages/base && bash test/inbox.test.sh)`. Check its prerequisites
  first (`python3` and `xxd` for inbox; `jq` for the sweep suites). Use fake
  homes and stub tmux or runtimes rather than reaching live sessions. Extend
  a script's existing suite; use a Vitest wrapper when typed fixture setup
  and assertions make a new check simpler.
- Use the [rig](../rig/README.md) for clean-machine and installation claims,
  not to test one script branch. `node rig/run.mjs` needs Docker, network
  access and a clean committed tree. It archives HEAD, exercises `INSTALL.md`
  in throwaway containers and requires a negative control for each assertion.
  It writes `rig/out/report.json` and `rig/out/summary.md`.
  `node rig/run.mjs --self-test` checks the harness without Docker.

## Nudges: cron admin and scheduler

The two routes have separate actions: `/api/cron` in
`packages/deck/app/routes/api.cron.tsx` and `/scheduler` in
`packages/deck/app/routes/scheduler.tsx`. Test both when a shared guard changes.
Call the loaders and actions with synthetic `Request` objects and socket
context, following the existing tests:

- `packages/deck/test/api-cron.test.ts` wraps the real cron functions with
  in-memory `CronDeps` and stubs `crontabAvailable`. It can assert the route
  and service together and inspect the captured writes.
- `packages/deck/test/scheduler-route.test.ts` mocks all cron service calls,
  including the action's dynamic import, and checks the arguments, results
  and read-only UI. `packages/deck/test/cron.server.test.ts` tests the service
  itself with fake crontab contents and a temporary PATH for binary discovery.
  If a test needs file-backed state, point the injected `CronDeps` at a temp
  file. Never use the default runner, a real user's crontab or agent home.
  Changing the inbox root does not redirect crontab.

```sh
pnpm -C packages/deck test test/api-cron.test.ts test/scheduler-route.test.ts
```

Cover the instance opt-out (`MC_CRON_ADMIN_ENABLED=0` or `false`): loaders
404 without listing and otherwise permitted POSTs are refused. With no
`crontab` binary, loaders report `crontabOk: false` and POSTs do not write.
Exercise the shared request guard: direct loopback with an allowed Host can
write without Origin or Fetch Metadata. Remote writes need
`MC_CRON_ALLOW_REMOTE_ADMIN=1`, an allowed Host and same-origin proof. Assert
403 and no mutation for cross-site requests, mismatched origins, disallowed
hosts, or requests relying on forwarded headers to appear local.
Also check rejected payloads (including newline or carriage-return schedule
injection), failure returned as `ok: false`, and valid create, toggle and
delete arguments. The API validates `targetType` at the boundary; the
scheduler coerces it and also handles `edit`. Check normalisation and that an
omitted scheduler checkbox does not enable a nudge. Restore environment
changes and assert rejected inputs never reach the write functions.

## Agent evals (proposed, not implemented)

A unit test asks whether known inputs produce a defined result. An eval asks
whether an agent completes a representative task with acceptable output and
side effects, even if the wording or sequence varies. The scripted ACP stub
(`packages/deck/test/fixtures/acp-agent.mjs`), pane replays
(`packages/deck/test/fixtures/panes/`) and protocol corpus
(`packages/base/conformance/corpus.json`) are deterministic fixtures, not
model evals. There is no dedicated eval runner in this tree.

Suggested first layout: `evals/<case>/prompt.md` (task), `fixture/` (synthetic
starting state), `expected.json` (required and forbidden properties) and
`score.mjs` (scorer). A proposed runner would copy the fixture into a temporary
sandbox and write a `results.json` outside the repository. For example, a
drafting task could require a draft in the right location and no messages sent.

Check paths, schemas and recorded side effects deterministically first. Only
use a model grader for qualities that need judgement, such as whether a draft
answers the brief. Give the grader a fixed rubric; it must not override a
failed deterministic check. Keep live runs opt-in and out of `pnpm test`.
Agree maximum spend, tokens, time and tool calls before running; stop on a
limit and record an incomplete result, not a pass. Use synthetic data and no
live inbox, crontab or tools with real side effects.

Example on-demand command once a runner exists (not runnable today):

```sh
results_dir=$(mktemp -d)
node evals/run.mjs --case draft-reply --max-usd 0.25 --timeout-seconds 60 \
  --out "$results_dir/results.json"
```

Record the case, commit, fixture and rubric revision, model and grader IDs,
per-check outcomes and reasons, elapsed time, tokens and cost in the results
file. Share a redacted summary for review, not raw traces or secrets.

## Open questions

- Who approves live eval budgets and model or grader choices?
- Where should redacted eval results be retained for comparison across runs?
