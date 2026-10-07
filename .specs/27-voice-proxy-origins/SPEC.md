# #27: Voice dictation cannot work on a production start without undocumented env vars

- Issue: #27
- Branch: 27-voice-proxy-origins
- Started: 2026-10-07

## TL;DR

The voice proxy only accepts WebSocket upgrades from `http://localhost:5174`,
an old dev port, so on a production start (port 4242) the mic fails with a
console WebSocket error. Default the allowlist to Deck's own
`http://localhost:${PORT || 4242}` plus the dev port, document the three
`VOICE_*` variables in `.env.example` and INSTALL.md (including reaching Deck
over Tailscale with `wss://`), and make the mic show "voice disabled: no
DEEPGRAM_API_KEY" when no key is set.

## Scope

In scope:
- `packages/deck/server/voice-relay.mjs` and `voice-proxy.mjs`: compute the
  default allowed origins from `PORT`.
- `packages/deck/.env.example`: commented entries for `VOICE_ALLOWED_ORIGINS`,
  `VOICE_PROXY_URL`, `VOICE_PROXY_HOST`.
- `INSTALL.md`: voice dictation walkthrough, with the Tailscale case.
- Mic component: a clear disabled state when the key is missing.
- Unit tests for the default-origin computation.

Out of scope (and where it goes instead):
- Anything else in the voice pipeline. See Follow-ups.

## Acceptance

- With only `DEEPGRAM_API_KEY` set, the mic works on a local production start
  at port 4242.
- Without it, the mic shows a clear disabled state.
- A test covers the default-origin calculation.

## Test plan

To be filled in as the approach settles.

## Decisions log

- 2026-10-07: Branch started from the latest `origin/main`.

## Follow-ups

- None yet.

## Review feedback

- None yet.
