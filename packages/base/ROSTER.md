# ROSTER.md - Who's on the team

> The generic version of the other file every agent imports alongside
> `SYSTEM.md` (see `templates/CLAUDE.md`). Solo agent, skip this until a
> second one joins. Once you have more than one, this is the one place
> anyone, human or agent, can answer "who owns this" without asking around.

## What goes in here

One entry per agent, short enough that a newcomer can scan the whole list in
under a minute. Not a biography, a routing table: if a task shows up that
belongs to a given area, this is what tells you (or another agent) who to
hand it to.

A workable shape per entry:

```markdown
- **<Name>** <emoji> - <one-line role>. <what they own, in a few words: which
  systems, which projects, which kind of decision they're trusted to make
  without checking first>.
```

Keep the detail that changes often (current workload, what they're mid-task
on) out of this file entirely, that belongs in whatever status surface you
already have (a board, a standing thread), not in a document every agent
re-reads for routing. This file should be stable for weeks at a time; if it's
changing daily, something that belongs elsewhere has leaked into it.

## Naming convention

Whatever regex you enforce for an agent's machine name (see `SYSTEM.md`
§Identity), enforce it here too, this is usually the canonical list of valid
names, and anything that generates a name programmatically should check
against it.

## A worked example (fictional, not a real team)

```markdown
- **Wren** 🪶 - onboarding specialist. Owns new-customer setup and the first
  30 days of any account; the one to route "how do I even start" questions to.
- **Basalt** ⛰️ - infrastructure. Owns deploys, the database, and anything
  that touches production directly. The one whose sign-off is required before
  any irreversible platform change.
- **Marlowe** 🕯️ - support triage. Owns the shared inbox and decides what gets
  escalated to a human versus handled directly. See `sample-agent/` for a
  fully worked persona in this same shape.
```

## Keeping this current

Add an agent the same day their persona files exist, not after they've been
running a while. Remove or archive an entry the day an agent is retired, a
stale roster entry pointing at something that no longer exists is worse than
a missing one, because it reads as current when it isn't.
