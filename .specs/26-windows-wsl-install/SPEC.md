# #26: No Windows (WSL) install path in INSTALL.md

- Issue: #26
- Branch: 26-windows-wsl-install
- Started: 2026-10-11

## TL;DR

Adds a "Windows (via WSL)" section to INSTALL.md for a non-developer on
Windows 11. It links to the Linux steps instead of repeating them, and covers
only what differs under WSL.

## Scope

In scope: the new section; a `powershell` fence language in the rig's known
list; small edits to the lines elsewhere in INSTALL.md that said Windows was
untouched or that pointed at WSL.

Out of scope: the other Known limitations entries (issue #37), any change to
launchers or Deck itself.

## Acceptance

- A reader following INSTALL.md alone can get from a clean Windows 11 machine
  to the Ubuntu steps, and has the traps from the 2026-09-27 test covered.
- Every command is either rig-executed, marked `sh-manual` or marked
  `powershell` (Windows-only, not run by the rig).

## Test plan

- Rig shape stage: the new fence language is accounted for, no unclaimed `sh`
  block (`node rig/self-test.mjs`).
- Linux checks of the commands that make sense on Linux: the CRLF failure
  message, `git ls-files --eol` under the repo's `.gitattributes`, the PID 1
  check for systemd.
- Everything Windows-specific is from documentation and is listed in the PR.

## Decisions log

- Section sits before section 1 and has no number, so the rig's block ids for
  sections 1 to 5 do not change.
- Windows-side blocks use a new `powershell` language rather than `text`, so
  they read as commands and the rig still refuses an unknown language.
- `/etc/wsl.conf` is edited with an editor and a shown snippet, never
  overwritten with a heredoc, because the file often already exists.
- Line endings section tells the reader to re-clone, not repair files.

## Follow-ups

- The private-repo `gh auth login` paragraph in section 1 is marked for
  deletion once the repo is public.

## Review feedback

Opus round 1 (changes needed), all addressed:

1. Blocker: "sudo in front of each line" broke the Node and `export` lines.
   Now `sudo -i`, paste, `exit`, re-run the `export`; the same fix applied to
   the pre-existing "prefix each line with sudo" prose in section 1.
2. Limitation line now says plainly that nobody has followed the Windows
   section end to end.
3. PR uses "Refs #26", not "Fixes", since acceptance needs a real clean
   Windows 11 run.
4. Section intro says which subsections to do first, and sections 4 and 5
   link back to the later ones.
5. Localhost fallback added (127.0.0.1, then `wsl --shutdown`), still no
   `HOST=0.0.0.0`.
6. tmux survival is flagged inline as unchecked, systemd named as the
   dependable option.
Nits: `/etc/wsl.conf` user default now set via an editor, not `printf >>`;
"carry on with section 2 and onwards"; sh-manual bullet says the WSL blocks
were not run by hand.
Opus round 2: the Windows "Keep it running" heading stole the
`#keep-it-running` anchor from section 4, so existing links pointed at it.
Renamed it "Keep Deck running on Windows" (link in the section intro
updated by wording). Nits: wrapped the long line and the intro, and added
Line endings to the "do first" list.
Human review (maintainer, PR comment): the WSL path only started the service, so
nothing brought Deck back after a restart. Added `systemctl --user enable
deck` and `loginctl enable-linger` to the Windows section, with what each
does and that Deck still does not start with Windows itself. The PR keeps the
unverified-steps list.
Not done here, separate issue: the tier table anchors at the top of
INSTALL.md (`#1-try-it` etc.) do not match the real headings.
