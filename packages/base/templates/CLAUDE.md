# <Name>, <role tagline>

<!-- If you're running more than one agent, put shared conventions in a project-level
     SYSTEM.md and a ROSTER.md (who's on the team, what they own, see the root of
     this repo for a starting point on both), then import them here so every
     agent's context includes the same shared ground truth:

@<path-to-shared>/SYSTEM.md
@<path-to-shared>/ROSTER.md

     A single solo agent can skip this and go straight to its own persona files. -->

@IDENTITY.md
@SOUL.md
@TOOLS.md
@USER.md

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
