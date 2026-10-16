# #38: No guide for adding an agent after install

- Issue: #38
- Branch: 38-add-an-agent-guide
- Started: 2026-10-16

## TL;DR

Adds `docs/adding-an-agent.md`, a short guide for someone who finished install
and wants another agent: create, naming rules, appearing in Deck, starting,
first message, removal, and the likeliest failures. Linked from INSTALL.md
"Where to go next" and the README. Written from a real run in a sandbox.

## Scope

In: the guide, two links. Out: a creation UI, a remove command, any script change.

## Acceptance

- A user can add a second agent following the guide alone.
- Covers create, verify, boot, first-boot prompts, day one, model choice.

## Test plan

Ran every step on a clean sandbox with a real Deck and a real runtime: create
(VERIFIED), bad name, duplicate name, agent visible in Deck, allowlist hiding
it (write returns 500), boot with trust prompt, a trust prompt answered No
(agent exited, day-one skipped), fix with `.first-boot-done` removal, message
sent from Deck and the reply arriving, removal and Deck dropping the agent.

## Decisions log

- Lives in `docs/` (new), linked from README and INSTALL.md.
- Command blocks use `text`, so the install rig does not execute them.
- Removal is documented as manual, since no script exists.

## Check results

Recorded in the PR.

## Follow-ups

- Killing the Deck launcher can leave the web-server child holding port 4242.
- A `remove-agent.sh` would make removal safer.

## Review feedback

None yet.
