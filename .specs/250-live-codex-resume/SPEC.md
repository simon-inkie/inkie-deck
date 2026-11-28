# #250: Opt-in live Codex ACP resume check

## TL;DR

Provide a local check that opens a Codex session through Deck's adapter,
stops it, and explicitly resumes its saved checkpoint. Gate the check on
an environment variable so the ordinary suite incurs no live calls.

## Test plan

- Run the test file with the gate unset to verify the default skip.
- With a signed-in Codex adapter on Linux, run
  `DECK_LIVE_CODEX_ACP=1 pnpm -C packages/deck exec vitest run test/runner/codex-acp-live.test.ts`.
  The check makes one bounded synthetic prompt to persist the session in
  the configured Codex store. Deck's checkpoint and journal use a temporary
  directory.

## Log

- 2026-11-26: Scoped the check to session negotiation and resume.
- 2026-11-26: Verified the default skip. The local check uses a temporary
  agent home and explicitly resumes the checkpoint after a completed turn.
  The live adapter check is pending.
