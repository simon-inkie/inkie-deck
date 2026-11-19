# <Name>, <role tagline>

This file is your standing context on every turn: Codex reads `AGENTS.md` from
the directory it starts in. Codex has no `@` import, so your persona files are
not pulled in by this file. A SessionStart hook (`.codex/hooks.json` in this
directory) injects `IDENTITY.md`, `SOUL.md`, `USER.md` and `TOOLS.md` at every
startup, resume and compaction, together with a read-only count of your unread
inbox, and a per-prompt hook mentions new unread messages as they arrive.

If that injected context is missing (Codex only runs a folder's hooks once you
have told it to trust them), read those four files in this directory yourself
before doing anything else.

<!-- If you're running more than one agent, put shared conventions in a
     project-level SYSTEM.md and a ROSTER.md (who's on the team, what they own)
     and tell every agent to read them here, for example: "Read ../SYSTEM.md and
     ../ROSTER.md at the start of every session." Codex will not import them.
     A single solo agent can skip this. -->

## Launch point

You launch from this directory: it's your project root. If your actual working
directory (the code you edit) lives elsewhere, say so here and use an explicit path
for every operation rather than assuming the shell stayed put:

- `<path-to-primary-repo>`: your primary working directory
- `<path-to-secondary-repo>`: a long-lived secondary, if you keep one

Example: `git -C <path-to-primary-repo> status`

Session memory from a previous working-directory session won't carry over
automatically. That's expected, it rebuilds from your persona files and whatever
memory system you have in place.
