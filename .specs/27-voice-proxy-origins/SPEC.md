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

- `test/voice-proxy-origins.test.ts`: pure tests for `defaultAllowedOrigins`
  and `resolveAllowedOrigins` (unset, blank, custom `PORT`, `PORT=5174`
  de-duplication, explicit override), plus a process test that spawns the real
  proxy with only `PORT` set and checks an upgrade from
  `http://localhost:4242` is accepted and `http://localhost:4243` is refused.
- `test/voice-server.test.ts`: `getVoiceDisabledReason` and `getVoiceProxyUrl`.
- Repo checks: typecheck, test, boundaries, leaks, licence, lib-version,
  dashes.
- Manual, run 2026-10-07 on a real `pnpm build` and `start-production.mjs`
  with `PORT` unset: with only `DEEPGRAM_API_KEY` set, the proxy logged
  `origins: http://localhost:4242, http://localhost:5174` and a WebSocket
  upgrade with `Origin: http://localhost:4242` was accepted. With no key, the
  thread page's loader data carried "voice disabled: no DEEPGRAM_API_KEY" and
  the rendered page contained the disabled note. Not measured: a real browser
  and a real Deepgram session (needs a key and a microphone), and the
  Tailscale steps.
- Gates: typecheck, deck tests, boundaries, leaks, licence, lib-version and
  dashes pass. `check:leaks:messages` is red from commits already on main, none
  of this branch's. `packages/base` has 4 failing shell-suite tests in this
  sandbox, unrelated to this change (not touched).

## Decisions log

- 2026-10-07: Branch started from the latest `origin/main`.
- 2026-10-07: The computation lives in `voice-relay.mjs` only, not also in
  `voice-relay.ts`. That file already has a hand-kept twin and a cross-copy
  suite; adding a third thing to keep in step buys nothing, because the proxy
  imports the `.mjs` and the new tests import it directly.
- 2026-10-07: Explicit `VOICE_ALLOWED_ORIGINS` replaces the default rather than
  extending it, as before. A blank value now falls back to the default, since
  an empty allowlist would reject every upgrade.
- 2026-10-07: Default hosts are `localhost` only. A page opened as
  `http://127.0.0.1:4242` sends a different origin and still needs
  `VOICE_ALLOWED_ORIGINS`.
- 2026-10-07: "No key" is decided before the browser connects, not by waiting
  for the proxy's `no_key` frame, which removes the failed WebSocket attempt
  and its console error. Dead end: the first version read the key in the
  loader and put the message in `Compose.tsx`, which `test/seam.test.ts`
  rejects, because that test bans the key's name from everything under `app/`
  (FND-02). Rather than loosen a guard, the launchers (outside `app/`, and the
  ones that hand the proxy its key) set `VOICE_DISABLED_REASON` for the app
  server when no key is present; the loader passes it on and `Compose` shows it
  as given. A start that bypasses the launchers (`pnpm start`, unsupported)
  leaves it unset, so the mic behaves as before there. If a maintainer would rather
  allow the key name in `app/`, the loader could check it directly.
  The proxy's `no_key` frame stays as a fallback.
- 2026-10-07: The Tailscale walkthrough uses `tailscale serve` for both Deck
  and the proxy, because the mic needs a secure context and `https://` pages
  need `wss://`. The `tailscale serve` flags are written from documentation
  and were not run here; INSTALL.md says so.
- 2026-10-07: Corrected the stale voice claims in `INSTALL.md` limitations,
  `scripts/start-production.mjs` header and `rig/container-image-note.md`,
  which said the three variables were absent from `.env.example`.

## Follow-ups

- `127.0.0.1` and `[::1]` origins are not in the default list.
- `start-production.mjs` could set `VOICE_PROXY_URL` itself from a configured
  public origin; left alone.

## Review feedback

- None yet.
