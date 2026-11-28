# #154 ACP slice 4 | Live Codex saved-session verification

- Issue #154
- Branch `154-acp-slice-4-live-proof`
- Started 2026-11-28

## TL;DR

Record versioned evidence that Deck's ACP registry can use explicit Resume
to reopen a saved Codex session. Reuse the smoke test from #250 and the
synthetic registry suite, including the checkpoint rollback coverage from
#251. The wider live adapter matrix remains tracked in the [slice 3 SPEC](../154-acp-slice-3/SPEC.md#manual-live-verification).

## Verification contract

- **A1 (live, PASSED 2026-11-28).** The approved run completes one bounded synthetic
  prompt, stops the session, and finds a resumable Deck checkpoint with the
  original session ID. Explicit Resume returns to idle with the same ID.
  Record the equality assertion as a result. Approved by the operator and run
  once on 28 November 2026 (see the receipt).
- **A2 (offline, PASSED 2026-11-28).** With `DECK_LIVE_CODEX_ACP` unset, the
  live smoke test reports skipped and the synthetic registry suite passes,
  including independent adapter lifecycle, resume and runtime identity,
  and checkpoint rollback.

## Test plan

Run the offline check first from the repository root on the verification
host. Use a writable temporary directory and a fixture `tmux` on `PATH` that
returns an empty window list for the registry cases that use the default
lookup.

```sh
env -u DECK_LIVE_CODEX_ACP pnpm -C packages/deck exec vitest run test/runner/codex-acp-live.test.ts test/runner/acp-registry.test.ts
```

After operator approval, run the existing one-turn check on Linux with the
signed-in test account, a dedicated `CODEX_HOME` already set up for that
account, and the installed adapter on `PATH`. Probe the adapter version
from the same environment used for Vitest.

```sh
codex-acp --version
DECK_LIVE_CODEX_ACP=1 pnpm -C packages/deck exec vitest run test/runner/codex-acp-live.test.ts
```

The harness prompts once, checks for a completed turn within 30 seconds,
and stops the resumed adapter and removes the temporary Deck home in its
`finally` block. Confirm cleanup of the adapter and temporary Deck home on
the host. The harness inherits the Codex store, so the host handles the
dedicated store's cleanup separately. [Live harness](../../packages/deck/test/runner/codex-acp-live.test.ts#L9-L52)

Gate 2 requires an observed live pass. A skipped live run leaves it open.
After the host commits the receipt, run `pnpm build` and the
[required clean-tree checks](../../CONTRIBUTING.md#checks-a-pull-request-must-pass).

## Evidence limits

- A live pass would show that the adapter accepted the resume request and
  Deck stayed bound to the saved ID. The protocol reply can omit the ID.
  Restoration of the prior turn's content remains unverified.
  [Resume response handling](../../packages/deck/app/lib/acp-session.server.ts#L691-L720)
- The concurrent registry case uses a fixture that returns a fixed ID on
  each fresh start. A synthetic negative control for A1 needs distinct IDs
  for fresh starts to make the equality assertion fail on a fresh launch.
  [Registry case](../../packages/deck/test/runner/acp-registry.test.ts#L135-L181)

## RECEIPT

Append, for each observed host run, the date,
tested SHA, platform (OS and architecture), exact command and result. Include
the observed adapter version for live evidence. Record any failure against
the command and version using a short summary. Keep credentials, account
details, session IDs, host paths and raw logs out of the receipt.

| Date | Tested SHA | Platform | Command | Result |
| --- | --- | --- | --- | --- |
| 2026-11-28 | 2792a5a (plus this SPEC, no code change) | Linux x64, WSL2, Node 22.23.2 | `env -u DECK_LIVE_CODEX_ACP pnpm -C packages/deck exec vitest run test/runner/codex-acp-live.test.ts test/runner/acp-registry.test.ts` | A2 passed: 22 passed, 1 skipped (the live test, as expected) |
| 2026-11-28 | 2792a5a | Linux x64, WSL2, Node 22.23.2, `@agentclientprotocol/codex-acp` 2.8.0 | `DECK_LIVE_CODEX_ACP=1 pnpm -C packages/deck exec vitest run test/runner/codex-acp-live.test.ts` | A1 passed: 1 test, 12 s. Saved session resumed with the same session ID |

Adapter note: 2.8.0 is the newest release that satisfies the project's seven day package age rule on this date (2.12.1 is the current release). The manifest floor is 2.6.0. The old `@zed-industries/codex-acp` package is deprecated in favour of this one.
