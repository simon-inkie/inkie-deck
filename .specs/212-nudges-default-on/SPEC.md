# #212: Nudges on by default

- Issue: #212
- Branch: nudges-default-on
- Started: 2026-11-18

## TL;DR
`cronAdminEnabled` only opened for two hard-coded MC_USER names, so Nudges
(`/scheduler`, `api/cron`) was hidden on any install that sets MC_USER, as
INSTALL.md tells people to. It is now on by default for everyone, with
`MC_CRON_ADMIN_ENABLED=0`/`false` as the off switch. The page and API now say
plainly when `crontab` is missing and refuse writes before anything is
written, a throwing write comes back as an error instead of a 500, and the
`pnpm dev` sandbox turns Nudges off so it cannot touch the real crontab.

## Scope
In scope:
- Gate: default on, explicit opt-out, generic doc comments.
- `api/cron` GET now behind the same gate (404 when off); it was ungated.
- Missing `crontab` (PATH lookup, never runs it) and throwing seam handling.
- Dev sandbox default off; INSTALL.md section and `.env.example` entry.
Out of scope:
- README (separate PR).
- The nudge script's hard-coded `agents` tmux session name (same limitation
  as `boot-agents.sh`, already in INSTALL.md known limitations).

## Test plan
- `test/instance.test.ts`: default on for any MC_USER; 0/false (any case,
  padded) off; other values stay on.
- `test/api-cron.test.ts`: real seam bound to in-memory fake deps; GET 404
  when off; POST refused when off; missing crontab; throwing seam; injection.
- `test/scheduler-route.test.ts`: same for the page loader and action.
- `test/cron.server.test.ts`: `crontabAvailable` against temp-dir PATHs.
No test reads or writes the real crontab.

## Follow-ups
None filed.

## Log
### 2026-11-18: default on, degrade without crontab
- What changed: gate rewritten; crontab check and try/catch in both routes;
  sandbox default off; api-cron tests moved off the real seam deps.
- Why: the old api-cron suite ran the real `createCron` with default deps and
  relied on the gate or an unknown target to stop before a write; with the
  gate open by default that was one fixture change from writing the real
  crontab.
