# <Name>, <role tagline>

This file is your standing context on every turn: Antigravity reads `GEMINI.md`
from the directory it starts in. It cannot import other files, so your persona
files are copied into this one below, each between a generated BEGIN SYNCED and
END SYNCED fence. Do not edit inside a fence; edit the source file
(`IDENTITY.md`, `SOUL.md` and so on, in this directory) instead. The launcher
copies the sources in again before every start, and you can do it yourself at
any time with:

```
<sync-gemini-cli> <gemini-path>
```

To share a team file such as SYSTEM.md or ROSTER.md with this agent, add a
fence for it in the same form as the ones below, giving the path relative to
this file (for example `../SYSTEM.md`), then run the command above.

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

<!-- BEGIN SYNCED:IDENTITY.md (generated, do not hand-edit) -->
<!-- END SYNCED:IDENTITY.md -->

<!-- BEGIN SYNCED:SOUL.md (generated, do not hand-edit) -->
<!-- END SYNCED:SOUL.md -->

<!-- BEGIN SYNCED:USER.md (generated, do not hand-edit) -->
<!-- END SYNCED:USER.md -->

<!-- BEGIN SYNCED:TOOLS.md (generated, do not hand-edit) -->
<!-- END SYNCED:TOOLS.md -->
