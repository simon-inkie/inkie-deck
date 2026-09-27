# Inkie Deck: Windows (WSL) install test log

> **What this is.** Notes from a hand-run install of Deck on a clean Windows 11
> laptop via WSL 2 + Ubuntu 24.04, following INSTALL.md as written, on
> 2026-09-27. It's the brief for implementation work, not user documentation:
> `R` items are changes to the repo, `D` items are documentation to write, and
> the run log at the end is what actually happened. Internal names, people and
> paths have been replaced with neutral placeholders so this passes the leak
> gate; `<you>` is the Linux user, `<owner>` the GitHub owner.

Aim: a stranger with a Windows machine can install Deck from the public repo
without help. Anything we have to work around goes into the repo as a change
or as documentation.

- Machine: Windows 11 Pro laptop (build 26200), no dev setup for Deck
- Repo: `<owner>/inkie-deck` (private at time of test), cloned 2026-09-27
- Route: WSL 2 + Ubuntu 24.04, then INSTALL.md as written

Status key: **CONFIRMED** = we saw it happen | **EXPECTED** = found by reading, not yet run

---

## Changes to make in the repo

### R1. Add `.gitattributes` forcing LF line endings (EXPECTED)
There is no `.gitattributes` in the repo. If a Windows user clones with Git for
Windows (default `core.autocrlf=true`) and then runs the scripts from WSL, every
`.sh`, the python `inbox` CLI and the `.env` files get CRLF endings and fail
with errors like `/usr/bin/env: 'bash\r': No such file or directory`.
Proposed file:

```gitattributes
* text=auto eol=lf
*.png binary
*.jpg binary
*.ico binary
*.woff2 binary
```

That doesn't replace the "clone inside WSL" advice, but it stops the most likely
wrong move from breaking things.

### R2. Update the Windows line in "Known limitations" (EXPECTED)
At the moment it says "no one has run this on Windows". Once this test passes,
change it to say WSL 2 + Ubuntu 24.04 has been run by hand (not by the rig), and
that native Windows isn't supported because tier 3 needs tmux.

### R3. Update the "only measured as root" limitation (EXPECTED)
This test runs as a normal user with `sudo`. Once it passes, record that as the
first non-root run.

### R4. One-command Windows installer (PROPOSED, build after the manual run)
`install.ps1` (admin PowerShell) as a thin wrapper around a repo `install.sh`:
1. `wsl --install --no-distribution` if WSL is missing. May need a reboot;
   the script should detect that and resume when run again.
2. `wsl --install -d Ubuntu-24.04 --no-launch` (skips the interactive setup).
3. Create the Linux user as root (`wsl -d Ubuntu-24.04 -u root -- useradd ...`),
   ask for its password, and set it as the default user in `/etc/wsl.conf`.
4. Run `install.sh` inside Ubuntu: apt prerequisites, Node 22, corepack, clone
   into `~`, `pnpm install`, the four roots, `.env` with `MC_USER`, `pnpm build`.
5. Add a shortcut that starts Deck in WSL and opens http://localhost:4242.

Keep `install.sh` usable on its own (Linux users) so the rig can test it on
ubuntu:24.04; only the PowerShell wrapper stays untested by the rig. Publish as
`irm <raw url>/install.ps1 | iex` once the repo is public. Still manual either
way: the WSL-enable reboot, and signing in to the model CLI for tier 3.

### R5. Google Fonts never load, on any OS (CONFIRMED, bug)
`packages/deck/app/app.css` line 1 is `@import "tailwindcss";`, line 2 is the
Google Fonts `@import url(...)`. Tailwind v4 inlines itself at line 1, so the
font import ends up after other rules, and the CSS spec says a browser must
drop it. The dev server warns about exactly this
(`[vite:css][postcss] @import must precede all other statements`), and in the
browser `document.fonts` has nothing loaded and no import rule survives: the
app renders in fallback fonts even with full internet access. (Your own
machine may hide it if League Spartan / Work Sans are installed locally.)
Fix: remove the `@import url(...)` from `app.css` and add
`{ rel: "stylesheet", href: "https://fonts.googleapis.com/css2?..." }` to the
`links` in `app/root.tsx` (the preconnect is already there, line ~40); or move
the URL import above `@import "tailwindcss"`. Then correct the "Typography
needs the internet" limitation, which blames the network for this.

### R6. A new agent boots into a trust prompt that defaults to "No, exit" (CONFIRMED, all OSes)
After `create-agent.sh --verify-only wren` passed (the `claude -p` probe isn't
blocked by the trust dialog), `boot-agents.sh` launched `claude --resume wren
|| claude` in the tmux window and the pane stopped at:
"Accessing workspace: /home/<you>/agents/wren ... Is this a project you
created or one you trust? > No, exit / Yes, I trust this folder".
- The agent is dead until someone answers it, so booting on startup
  ("safe to fire on boot") doesn't produce a working agent the first time.
- The selected default is **No, exit**, so the first Enter that reaches the
  pane kills the agent. Deck's terminal view (`api.tmux-send.tsx` ->
  `sendKeysToWindow`) types with no idle check, so a first message sent from
  Deck would do exactly that.
Options, pick one:
1. `boot-agents.sh` recognises the trust prompt in the pane and says
   "wren is waiting for you to trust ~/agents/wren: open its terminal in Deck
   and choose Yes" instead of reporting "launched + armed".
2. `create-agent.sh` asks at creation time ("Trust ~/agents/wren in Claude
   Code? [y/N]") and on yes records the trust in Claude Code's own config.
   That writes to Claude Code's internal state, so it may break when Claude
   Code changes.
3. At minimum, document it (D11).

### R7. Rename the walkthrough's first agent from `wren` to `inkie` (DECIDED)
Your first agent should be called `inkie`, not `wren`. `wren` appears 117
times across 8 files:
- **Change:** `INSTALL.md` (15), `packages/base/README.md` (4), the usage
  examples in `packages/base/bin/boot-agents.sh` (2) and `workspace.sh` (2),
  and `rig/stages/08-install-agents.mjs` (2). The rig runs INSTALL.md's blocks
  and checks names like `tmux list-windows` -> `wren`, so it has to change in
  the same commit or the rig goes red.
- **Leave alone:** the test suites (`create-agent.test.ts` 88,
  `boot-agents.test.sh` 3, `agent-can-reply.test.ts` 1). There `wren` is just
  a fixture name, and renaming it buys nothing.
- Worth adding one line to INSTALL.md: `inkie` is only a suggested name, and any
  lowercase name works.

This test run used `wren` because that's what the guide says. The walkthrough
text drafted in this log (D9-D11) should say `inkie` when it goes into the repo.

### R8. Deck's terminal view can't press arrow keys, so menus can't be answered (CONFIRMED, all OSes)
The user tried to answer wren's trust prompt from Deck's terminal view by
typing `yes`. Deck sends text **literally** (`send-keys -l`, see
`buildSendKeysTextArgs` in `packages/deck/app/lib/tmux.server.ts:185`), waits
1s, then presses Enter. Letters don't move the menu selection, so only the Enter
counted, and it confirmed the default, **No, exit**. The launch line is
`claude --resume wren || claude`, so the first Enter killed Claude, `|| claude`
started a second copy, and the second `yes` killed that too. The pane ended
at a bare shell prompt. (Lucky: a third send would have run whatever was typed
in bash. `yes` would have filled the pane with `y` for ever.)

Scope: numbered Claude Code menus already work from Deck, because typing the
digit picks the option. The trust dialog ("> No, exit / Yes, I trust this
folder") has **no numbers**, so it's the case that needs arrow keys. That also
makes it the first thing every new user hits (R6).

Suggested fix: keep the literal text path as it is, and add a named-key path
with a fixed allowlist:
- `tmux.server.ts`: `SEND_KEY_ALLOWLIST = ["Up","Down","Enter","Escape","Tab","BTab"]`,
  `buildSendKeyArgs(session, window, key)` -> `["send-keys","-t","=s:=w", key]`
  (no `-l`), and `sendKeyToWindow(env, window, key)` with the same window
  roster and live-window gates as `sendKeysToWindow`, rejecting anything not
  on the allowlist.
- `api.tmux-send.tsx`: accept `{ window, key }` as an alternative to
  `{ window, text }` (zod `z.enum(SEND_KEY_ALLOWLIST)`).
- Both terminal views (`/tmux` Team tab and `threads.$agent.tsx` `?view=tmux`):
  a row of buttons Up Down Enter Esc Tab under the pane. No auto-Enter, and they work
  whatever state the pane is in.
- Worth considering: refuse **text** sends when the pane is at a shell prompt
  (`SHELL_PROMPT_RE` already exists for the push path), so typing into a dead
  agent can't execute in bash.

### R10. First boot: `--resume <name>` opens a picker, and the new session has no name (CONFIRMED, all OSes)
`boot-agents.sh` launches `claude --resume wren || claude`. Two problems on a
brand-new agent:
1. `--resume wren` with no matching session **doesn't fail**. It opens an
   interactive "Resume session" picker ("No sessions match "wren"") and waits,
   so `|| claude` never runs and the agent never starts without help. Two
   Escapes got out of it here, and then the fallback ran.
2. Even when the fallback runs, the new session has no name. Today the user
   fixes that by hand with `/rename <agent>` on the first session, which is
   what makes later `--resume <agent>` work.

Claude Code 2.1.283 has `-n, --name <name>` ("Set a display name for this
session (shown in the prompt box, /resume ...)") and `--session-id <uuid>`.
Suggested launch logic in `boot-agents.sh`:
```sh
id_file="$home/.session-id"
if [ -s "$id_file" ]; then
  claude --resume "$(cat "$id_file")"
else
  id=$(cat /proc/sys/kernel/random/uuid)   # or uuidgen
  echo "$id" > "$id_file"
  claude --session-id "$id" -n "$agent"
fi
```
Pinning the ID means resume never depends on matching names and never opens
the picker. `-n` replaces the manual `/rename`.

Why the name matters: the session name is shown on the prompt box's top
border (the pane showed `-- wren -` after `/rename wren`), so you can see at a
glance which agent a terminal is, and `claude --resume <agent>` restarts it
without hunting for a session ID. Naming at launch gives every agent that
from its very first session. Still to check: what
`--resume <id>` does if that session's transcript has been deleted. It should
fall back to a fresh named session rather than open the picker. For agents
that already exist (like the user's current ones), `claude --resume <name>`
still works because they were renamed by hand. A migration step could look the
ID up once and write `.session-id`.

### R11. Claude Code's first-run prompts stop a new agent (CONFIRMED, all OSes)
In order, a brand-new agent pane stopped at:
1. folder trust (R6, unnumbered, **No, exit** selected by default);
2. the resume picker (R10);
3. "Try the new fullscreen renderer? > 1. Yes, try it / 2. Not now"
   (numbered, so answerable from Deck by typing `2`).
Then it reached a ready prompt, in **auto mode** (the new default permission
mode, "1 more notice hidden"). These prompts come from Claude Code, change
between versions, and can't be listed once and for all. The robust fix is the
R6 option 1 idea generalised: after launching, `boot-agents.sh` checks the pane
and reports "wren is waiting on a Claude Code prompt, open its terminal in
Deck" rather than "launched + armed". The INSTALL.md walkthrough should say to
open each new agent's terminal once and click through, and should mention the
agents run in auto mode unless configured otherwise.

### R12. The brain isn't mentioned anywhere in inkie-deck, and the leak gate blocks its name (CONFIRMED by reading)
Searched the whole inkie-deck tree (excluding the lockfile) for `brain`,
`vector`, `embedding`, `.agents`, Qdrant and other vector stores. Nothing about
installing, configuring or indexing a brain. The only hits:
- `scripts/leak-gate.mjs:211` lists the memory layer's repository name (alongside the old product name and others) as a **forbidden internal term**. So today the gate would fail any
  commit that links the brain from Deck's docs. That rule needs relaxing
  (the brain repo is public) before it can be documented.
- `packages/deck/app/lib/safe-fs.server.ts:394`, a comment saying
  `ATTACHMENTS_ROOT` and `PROJECTS_ROOT` "may legitimately share ancestry under
  ~/brain". That's a hint of the original layout, not an instruction.
- comments crediting a person by first name in `Compose.tsx` / `AppShell.tsx` (not
  related, but they're more R9 leftovers).

The brain lives in its own public repo, the separate memory-layer repository (not named here: its name is on this repo's leak-gate denylist, see above) (v0.3.0):
Qdrant (Docker) + Gemini embeddings, Claude Code hooks (`UserPromptSubmit`,
`Stop`, `PreCompact`), an MCP server with a `remembering` tool, and a watcher
daemon. What its indexer reads (from `core/config.ts`,
`core/indexer/collection-router.ts`):
- the brain vault: any path containing `/brain/` (i.e. `~/brain/...`)
- per-agent silos under the memory layer's per-agent silo directory: `memory/`
  observations and reflections, `references/`, `MEMORY.md`
- per-agent persona repos: `brain-todos/`, `dev-notes/`, top-level `.md` files
- Claude Code conversation transcripts, and media assets

`.agents` isn't indexed. In the brain repo, `~/agents/<name>/.agents/hooks.json`
is only where the **Antigravity** adapter's hooks are configured. If you did
look at indexing `.agents`, it didn't make it into the code.

To decide: does Deck's install include the brain as a **tier 4** ("Give your
agents memory") that points at the memory-layer repository's QUICKSTART, and should the two
agree on paths? Deck's personas are in `~/agents/<name>/`, the brain's memory
silos in the memory layer's per-agent silo directory, and the brain's `persona-inject.sh`
already reads `~/agents/<name>/CORE.md`. Extra prerequisites on Windows: Docker
(Docker Desktop's WSL integration, or Docker Engine inside Ubuntu) for Qdrant,
and a Gemini API key.

### R13. Always-on target: survive a power cut, reachable over Tailscale (REQUIREMENT)
What's wanted: Deck and the agents run all the time, reachable from the
laptop or phone over Tailscale, and come back **by themselves after a power
cut / Windows reboot**, with no one signing in. That's how the main PC
already works (Windows reboots -> WSL starts -> agents start). Worth copying
that PC's actual setup into the docs rather than reinventing it: have the
coding agents on that PC write down exactly what's configured there.

Pieces to document or build (not yet tested on this laptop):
1. **Power back on -> PC boots**: BIOS/UEFI "Restore on AC power loss = Power
   On". Hardware-specific, doc only.
2. **Windows boots -> WSL starts, without anyone signing in**: a Task Scheduler
   task, trigger "At startup", "Run whether user is logged on or not", action
   `wsl.exe -d Ubuntu-24.04 --exec /bin/sh -c "sleep infinity"` (or similar)
   to start the VM and keep it up. Needs testing: WSL under a
   not-signed-in session has had problems on older versions.
3. **WSL starts -> Deck and agents start**: systemd units inside Ubuntu (systemd
   is on by default here), so starting the VM is enough:
   - `deck.service`: runs `node scripts/start-production.mjs` from
     `~/inkie-deck/packages/deck`, `Restart=always`. The repo already has
     `.env.production` "for a systemd `EnvironmentFile`", so a unit file is
     half-expected. Ship an example unit.
   - `agents.service`: oneshot running `boot-agents.sh` after `deck.service`.
     Needs R10 first, so that booting existing agents resumes them with no
     prompts.
   - As a user unit: `loginctl enable-linger <user>` so it runs with no login.
4. **Reachable over Tailscale**: recommended way is Tailscale on **Windows**
   plus `tailscale serve --bg 4242`. Deck stays bound to loopback, and only
   devices on your tailnet can reach it over HTTPS. That's the "authentication
   in front of it" INSTALL.md asks for, without `HOST=0.0.0.0`. (Tailscale
   inside Ubuntu also works, but then there are two Tailscale nodes for one
   machine.) Needs testing: `tailscale serve` on Windows proxying to a port
   WSL forwards to Windows localhost.
5. **Check after a reboot**: one command that reports Deck up, each agent's
   pane state, and which agents are stuck at a prompt (ties in with R11).

### R14. One `agents` command that brings everything up (REQUIREMENT)
Target experience, for a non-developer: Start menu -> type "Ubuntu" -> open it ->
type `agents` (or `agents <name>`) -> you're looking at your agents. That already works on the main PC.
Today the laptop needs two separate things (Deck's web service in its own tmux
session, plus `boot-agents.sh`), and INSTALL.md starts Deck in the foreground
of a terminal, where closing the window stops it.
**What the main PC has today (missing from inkie-deck):** a root-level
`agents` command that attaches to the tmux `agents` session, and
`agents <name>` (e.g. `agents wren`) which attaches straight to that agent's
window. It's the everyday way into the agents' terminals there, and nothing
like it ships in the repo. The laptop test needed `tmux attach -t agents` and
Ctrl-b w to find a window, which is too much to ask of a non-developer.

Suggested `packages/base/bin/agents` (linked into `~/.local/bin` by
`create-agent.sh`, like `inbox` already is), keeping the PC's behaviour and
adding the start-up half:
- `agents`: attach to the `agents` session. `agents <name>`: attach with that
  agent's window selected (`tmux attach -t agents \; select-window -t
  "=<name>"`, or `switch-client` if already inside tmux). Unknown name: list the
  agents and exit non-zero.
- If the session or Deck isn't running (after a reboot or `wsl --shutdown`),
  bring it up first:
  1. Start Deck's web service if it isn't answering: `tmux new-session -d -s
     deck-server -c <repo>/packages/deck 'node scripts/start-production.mjs'`
     (or `systemctl --user start deck` once R13 has a unit).
  2. Run `boot-agents.sh` (starts or leaves alone each agent's window).
  3. Print Deck's URL, and which agents are ready or waiting on a prompt (R11).
- Tab-completion of agent names is a nice extra (bash `complete -W` from the
  window list).
Tested on this laptop: Deck and agents in tmux survive every window closing
(D4), so `agents` is only needed after a reboot or `wsl --shutdown`.

### R15. No playbook for adding an agent; Deck has no "new agent" UI (CONFIRMED by reading)
Searched inkie-deck for a playbook / onboarding guide: none. The only way to
add an agent is `create-agent.sh`, documented in `packages/base/README.md`
("Install"), which also notes that "`--resume`-style launching needs the first
session named before it can resume", the same gap as R10, yet
`create-agent.sh` doesn't name it. Deck's UI can't create an agent (no route
calls `create-agent`). If a playbook exists in the main PC's private agents
setup, it should be cleaned and brought in as `docs/adding-an-agent.md`.

### R9. Pre-public leak check: leftovers from the original deployment in comments (SPOTTED, not yet swept)
While reading for R8: `api.tmux-send.tsx` comments mention a person's first name, a second person's name for their instance, and an internal ticket id. The leak gate is meant to
stop names and tickets; either these slipped past its rules or they're
allowlisted. Run `pnpm check:leaks` and `check:leaks:history`, and grep for
internal ticket ids and the first names found in those comments before making the repo public.

---

## Documentation to write

### D1. New INSTALL.md section: "Windows (via WSL)"
Put it before section 1 (Prerequisites). Draft:

> Deck runs on Windows inside WSL 2. It doesn't run natively on Windows,
> because live agent sessions need tmux. Everything after this section is
> typed inside the Ubuntu terminal, not PowerShell.
>
> 1. From PowerShell, install Ubuntu. It will ask you to create a Linux
>    username and password:
>    ```powershell
>    wsl --install -d Ubuntu-24.04
>    ```
> 2. Installing doesn't open Ubuntu. Open **Ubuntu 24.04** from the Start menu
>    (or run `wsl -d Ubuntu-24.04`) and create your Linux username and password
>    when it asks. If you get a `root@...#` prompt instead, see D5. From now
>    on you're in Linux.
> 3. You aren't root, so put `sudo` in front of each install command in the
>    Prerequisites section. The NodeSource line becomes
>    `curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -`.
> 4. Clone inside your Linux home folder (`cd ~`), **not** under `/mnt/c/...`.
>    Windows folders are slow from WSL and bring back Windows line endings.
> 5. Open Deck in your normal Windows browser at http://localhost:4242. WSL
>    passes localhost through, so you don't need `HOST=0.0.0.0` to reach it
>    from the same PC.

### D2. Gotcha: Docker Desktop's WSL distro (CONFIRMED on this laptop)
If you have Docker Desktop, `wsl -l -v` shows a `docker-desktop` distro, and it
may be the default. Plain `wsl` commands then go to Docker's distro, which
can't run Deck. Either always use `wsl -d Ubuntu-24.04`, or run
`wsl --set-default Ubuntu-24.04`.

### D3. Cloning while the repo is private (temporary)
Until the repo goes public, you need `gh` inside WSL (`sudo apt-get install gh`,
then `gh auth login`). Signing in on the Windows side doesn't carry over. Once
the repo is public, a plain `git clone https://github.com/<owner>/inkie-deck`
works and this note can go.

### D5. Ubuntu can install with no user, leaving you as root (CONFIRMED)
Current WSL does **not** open the distro after `wsl --install -d Ubuntu-24.04`.
It prints "Distribution successfully installed. It can be launched via
'wsl.exe -d Ubuntu-24.04'" and returns. The username/password setup only runs
the first time Ubuntu is opened *interactively*. On this laptop the first
opening was a non-interactive `wsl -d Ubuntu-24.04 -- <command>` (Claude
checking the install), and afterwards the default user was `root`, `/home` was
empty and `/etc/wsl.conf` had no `[user]` section.

The doc step needs to say explicitly: after install, run `wsl -d Ubuntu-24.04`
(or open "Ubuntu 24.04" from the Start menu) and create your user **before**
running anything else inside it. Everything would still work as root,
but that's exactly the case the "only measured as root" limitation already
covers. The docs (and the R4 installer) should check with `whoami` and, if it
says root, create a user:
```sh
useradd -m -s /bin/bash -G sudo <name>
passwd <name>
printf '[user]\ndefault=<name>\n' >> /etc/wsl.conf
```
then `wsl --terminate Ubuntu-24.04` from PowerShell and reopen.

### D6. INSTALL.md has no clone step (CONFIRMED by reading, affects every OS)
Section 1 says you need a git clone, and section 2 says "Everything from here
runs from the root of your clone", but nowhere does it tell you to clone.
(The rig probably copies the repo into the container, so it never notices.)
Snag: the leak gate's first-name rule matches the maintainer's first name as
a **substring in file content**, and that includes the GitHub owner in the
clone URL. So the real URL can't go into INSTALL.md until that rule gets an
exemption for the repo URL. (Found while committing these notes, which use
`<owner>` for that reason.)
Add between the two:
```sh
git clone https://github.com/<owner>/inkie-deck.git
cd inkie-deck
```

### D7. `pnpm --version` before cloning shows the wrong version (CONFIRMED)
The version check in section 1 comes before there's a repo, so there's no
`packageManager` field for corepack to use. It fetched the **latest** pnpm
(12.6.0 on 2026-09-27) instead of the pinned 10.34.5 shown in the recorded
output, and in an interactive terminal it first asks
"Corepack is about to download ... Do you want to continue? [Y/n]".
Fix: move the `pnpm --version` check to after the clone (inside the repo), and
mention the Y/n prompt, or set `COREPACK_ENABLE_DOWNLOAD_PROMPT=0`.

### D8. WSL finds the *Windows* `claude` and runs it half-configured (CONFIRMED)
WSL appends the whole Windows PATH inside Ubuntu (46 `/mnt/c/...` entries on
this laptop). With Claude Code installed on Windows via npm/nvm, `claude` inside
Ubuntu resolved to `/mnt/c/Users/<you>/AppData/Roaming/nvm/v20.18.0/claude`:
the Windows npm shim, running the Windows install under Ubuntu's Node with an
empty Linux `~/.claude`. Consequences seen:
- `create-agent.sh` got "no usable reply (exit status 1)" instead of the
  "No `claude` on PATH" the guide shows, which is more confusing.
- `boot-agents.sh` launched it in the tmux window, where it sat at Claude
  Code's first-run theme picker, so INSTALL.md's recorded
  `claude: command not found` pane output didn't match either.

Doc fix, in the Windows section: install the model CLI **inside** Ubuntu
(`curl -fsSL https://claude.ai/install.sh | bash`, then run `claude` once to
sign in). Recommend turning off the Windows PATH so shims can't leak in:
```sh
printf '\n[interop]\nappendWindowsPath=false\n' | sudo tee -a /etc/wsl.conf
```
then `wsl --terminate Ubuntu-24.04`. Possible repo fix: have `create-agent.sh`
/ `boot-agents.sh` warn when the resolved runtime path starts with `/mnt/`.

### D9. Signing in to Claude Code inside WSL (CONFIRMED)
Tier 3 needs the model CLI installed and signed in **inside Ubuntu**. Draft doc
text:

> In the Ubuntu terminal:
> ```sh
> curl -fsSL https://claude.ai/install.sh | bash
> mkdir -p ~/claude-signin && cd ~/claude-signin
> claude
> ```
> WSL has no browser of its own, so the sign-in step prints a URL instead of
> opening one. Copy it out of the terminal, open it in your browser on Windows,
> approve, then copy the authorization code the page shows and paste it back
> into the Ubuntu terminal. (In Windows Terminal, select the text and
> right-click to copy; right-click again to paste.)
>
> Your sign-in is saved in `~/.claude` and every agent shares it, so you only do
> this once.

Then it asks whether to trust the folder, which is covered in D10.

### D10. Don't trust your home folder (CONFIRMED)
Straight after signing in, Claude Code asked "Do you trust the files in this
folder? /home/<you>". The user had run `claude` from `~`. Answering yes trusts
everything under it: the Deck clone, the `~/deck` roots agents write into,
and every agent home. That defeats each agent trusting only its own folder.
Doc text:

> If Claude Code asks whether to trust your home folder (`/home/<you>`), choose
> **No, exit**. Your sign-in is already saved. Only trust an agent's own folder
> (`~/agents/<name>`), which is what the next step does.

That's why D9 signs in from a throwaway `~/claude-signin` folder instead of
`~`. Still to check: whether `boot-agents.sh` agents stop at their own trust
prompt in tmux, which would block a headless boot.

### D11. First boot: trust each agent's folder once (CONFIRMED)
Doc text for tier 3, after "Start the sessions":

> The first time an agent starts, Claude Code asks whether you trust its folder
> (`~/agents/<name>`) and waits. Open the agent in Deck, switch to the terminal
> view, and choose **Yes, I trust this folder**. Watch out: **No, exit** is
> selected by default, so don't just press Enter. You only answer this once per
> agent. (Or from a terminal: `tmux attach -t agents`, pick the agent's window,
> answer, then detach with Ctrl-b d.)

### D4. Keeping agents alive on WSL (TESTED: survives closing windows; reboot not covered)
Test, 2026-09-27: Deck running in a detached tmux session (`tmux new-session
-d -s deck-server -c ~/inkie-deck/packages/deck 'node
scripts/start-production.mjs'`) plus wren in tmux `agents`. Every `wsl.exe`
closed at 14:42:50 (zero clients). A Windows-side watcher checked every 10s for
5 minutes: Ubuntu stayed running and Deck answered 200 throughout. Afterwards
both tmux sessions were intact, and `/proc/uptime` showed the VM hadn't
restarted. So on this WSL version (systemd on) **closing the terminal doesn't
kill Deck or the agents**, as long as they were started in tmux.

Caveat: the watcher's HTTP request every 10s went through WSL's localhost
forwarding, which may count as activity. **Repeated cleanly, 15:14-15:25:** zero
`wsl.exe` clients and no traffic into WSL for 11 minutes (only
`wsl -l --running` once a minute, which doesn't touch the distro). Ubuntu was
still running every minute, and the one HTTP check at the end got Deck 200. So
the result stands: with systemd on and Deck + agents in tmux, WSL doesn't shut
down when idle on this version (WSL on Windows 11 build 26200, no
`.wslconfig`).

What this doesn't cover, and needs documenting:
- **Deck started the INSTALL.md way dies with its window.** The guide runs
  `node scripts/start-production.mjs` in the foreground of a terminal, and
  closing that terminal stops it. The Windows section should run Deck in tmux
  (as above) or as a systemd user unit.
- **Nothing starts after a Windows reboot or sign-out.** WSL only starts when
  something calls it. Options: a Task Scheduler "At log on" task running
  `wsl -d Ubuntu-24.04 -- bash -lc '<start deck in tmux>; ~/inkie-deck/packages/base/bin/boot-agents.sh'`,
  or systemd units inside Ubuntu plus any Windows-side task to wake WSL. This
  belongs in the R4 installer.
- A fresh boot of agents hits the first-run prompts again only for new agents
  (R6/R10/R11). An existing agent with a named session should resume
  unattended (still to test).

---

## Run log

| step | result | notes |
| --- | --- | --- |
| Check laptop | done | WSL 2 present; only `docker-desktop` distro; `gh` installed on Windows but not on this session's PATH |
| Install Ubuntu 24.04 | done | install didn't launch Ubuntu; user `<you>` created on a second, interactive launch (D5) |
| Prerequisites (apt, Node 22, corepack) | done | run as root via `wsl -u root`; Node v22.23.3, rg 14.1.0, Python 3.12.3, tmux 3.4, xxd, gh 2.45.0. LANG already C.UTF-8, systemd on. D6, D7 |
| gh auth + clone into ~ | done | user ran `gh auth login` in Ubuntu; `gh repo clone` fine (D3) |
| `pnpm install` | done | corepack asked Y/n to fetch pnpm 10.34.5 (D7); 483 packages in 7.9s; only the expected esbuild warning |
| Tier 1: `pnpm dev` + open in Windows browser | **pass** | agents `atlas`/`scribe` listed from WSL and from Windows at localhost:4242, no extra config. Fonts don't load (R5) |
| Tier 2: roots, `.env`, build, production start | **pass** | as user `<you>`, not root (first non-root run, R3). Launcher output matches doc; "No agents yet / Nothing needs you" from WSL and Windows. Fonts don't load in production either (R5) |
| Tier 3: create-agent, boot-agents, inbox reply | **pass, apart from D8** | create-agent exit 4 as documented, but because the Windows `claude` answered badly, not because it was missing (D8). boot-agents made the `wren` window. Compose -> 200, `inbox unread/read/reply` output matches the doc incl. `push: skip:no-window`, reply shows in Deck |
| Claude Code in Ubuntu | done | native install 2.1.283 at `~/.local/bin/claude`, found before the Windows copies. Sign-in via copy URL -> Windows browser -> paste code (D9); declined trusting `~` (D10) |
| `create-agent.sh --verify-only wren` | **pass** | exit 0, boot phrase quoted back |
| boot-agents with a real CLI | **blocked, then pass** | pane stopped at folder trust (R6). Answering `yes` from Deck's terminal view killed it twice (R8). Relaunched, trust accepted with Down+Enter via tmux, then the resume picker (R10), then the renderer prompt (R11). Ready after that, in auto mode. `/rename wren` sent by hand |
| **Live delivery: Deck -> agent -> reply** | **pass** | compose from Deck 200 -> pushed into the pane as `[inbox from <you>] ... [reply via inbox: inbox reply <you>]` -> wren ran `inbox reply <you>` itself (allowed by auto mode) -> reply in the thread file **10s** after sending. First observation of the "delivering direction" INSTALL.md calls unproven. Update that limitation: seen working by hand on 2026-09-27, still no automated test |
| New agent `inkie` via `create-agent.sh` | **pass, then blocked** | created + VERIFIED in 5.6s (boot phrase quoted back), appears in Deck straight away. `boot-agents.sh`: "1 launched + armed (inkie), 1 already up" (wren left alone). Pane stopped at the folder trust prompt again (R6), so the "launched + armed" report was wrong about its state (R11) |
| WSL idle shutdown (D4) | **pass** | Deck + wren in tmux, all Windows terminals closed: still up after 5 min with pings, and after 11 min with no traffic at all (final check 200). Reboot/login start not covered yet (R13) |
