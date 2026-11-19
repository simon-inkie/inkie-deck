# First-run hints: tell a new user what to do when an agent is waiting

- Issue: #201
- Branch: docs/first-run-hints-spec; code on `<issue>-first-run-hints`
- Started: 2026-11-18
- Related: #151 (clean-machine install, PR #148), #35 (first-boot message)

## TL;DR

A new agent's pane can sit at Claude Code's folder-trust dialog while Deck
shows an empty thread saying "Send the first reply below". This adds a hint
on the thread page, derived from live state on each refresh, that names the
waiting state and points at the terminal tab and its keys. Deck never presses
a key for the user.

The checked-in fixtures model the approved patterns; confirmation against real
CLI captures is still a pre-merge check. The unnumbered trust variant is not
claimed as supported without a retained capture.

## Problem

Today `boot-agents.sh` deliberately leaves folder trust, sign-in and key
approval to the user, and on first boot it passes the agent a first message
(#35), so on first boot a new agent writes first. Deck shows the same empty thread whatever
the cause, and its copy tells the user to write first.

Planned, not on `main`: setup in #151 (PR #148). There, exit 4 means agents
created but not started, exit 5 launched and waiting at native prompts, and
setup may write a model key. This spec does not depend on it, and exit 5
alone does not identify which prompt is showing.

## Goals

1. When an agent's pane is at a known one-time CLI dialog, the thread page
   says so and links to the terminal tab, where the hint names the keys.
2. An empty thread says a new agent writes first after its first start, and
   where to look if nothing arrives, even when no pattern matches.
3. Every hint clears itself on the next successful refresh after the state
   is gone, using the existing poll (no new timer).

## Non-goals

- Answering any dialog for the user: no auto-press, no key-sending "Trust"
  button. The existing key buttons stay the only path.
- Pre-trusting folders, writing any Claude Code config, or running the CLI
  or reading its credentials from Deck.
- Hints in the sidebar, Activity page or push (follow-ups); other runtimes'
  dialogs beyond the runtime-neutral H5.
- A first-run wizard, a persisted "has onboarded" flag, or new env vars.

## Hint catalogue

One hint at a time, priority H1 to H6. Copy never claims which option is
preselected. H1 to H4 ask users to check the terminal before choosing.

H1 Folder trust
- Trigger: the pane tail is the trust dialog (see Detection).
- Chat view: the CLI appears to be asking whether to trust the agent's folder.
  Button: "Open terminal" (a link to `?view=tmux`, not a key send).
- Terminal view: check the terminal, then, if you trust the folder, select
  'Yes, I trust this folder' with Up or Down and press Enter.
- Cleared: automatically, when the dialog is gone from the pane.

H2 Sign-in needed
- Trigger: the pane tail is the CLI's login method menu. Error-only forms
  (a "/login" instruction or an invalid-key error, with no menu) are out of
  this slice: they need their own evidence rule and copy, and fall back to H6.
- Chat: the CLI appears to need a one-time sign-in. Button: "Open terminal".
- Terminal: check the sign-in step before choosing with Up, Down and Enter;
  a browser link may appear in the pane. Cleared automatically.

H3 API key approval
- Trigger: the pane tail is the CLI's menu asking whether to use a key found
  in the environment (set by hand today; the planned #151 setup may write one).
- Chat: the CLI appears to have found an API key and asks whether to use it.
  Button: "Open terminal".
- Terminal: check the API key question before choosing with Up, Down and
  Enter. A key in the environment takes precedence over a subscription
  sign-in. Cleared automatically.

H4 Other one-time screen (theme picker, resume picker, fullscreen offer)
- Trigger: one of the base classifier's other anchored dialogs, plus the
  first-launch theme picker.
- Chat: the agent appears to be waiting on a setup screen. Button.
- Terminal: check the setup screen before choosing with Up, Down and Enter.
  Cleared automatically.

H5 Agent exited to a shell
- Trigger: positive evidence only. A capture succeeded and its tail ends at a
  shell prompt (`HINT_SHELL_PROMPT_RE`). Nothing else triggers it in this slice.
  An undefined capture is never H5: `captureTmuxPane` and
  `listTmuxWindows` fold a missing window, a missing session, a timeout and a
  tmux error into the same result, so it proves nothing about the agent.
- Chat: "<agent> appears to have exited to a shell in its terminal. Open the
  terminal to check, then start the agent again." Button: "Open terminal".
- Terminal view: one line above the keys: "This pane appears to be at a shell
  prompt, so the agent appears to have exited."
- Cleared automatically.
- An undefined capture shows no banner. The terminal view keeps its existing
  neutral "Pane unavailable" state, and an empty thread gets H6.

H6 Waiting for the first message (fallback, no pane match needed)
- Trigger: the thread has no blocks and none of H1 to H5 matched.
- Chat only, replacing the "No messages in this thread" empty state: title
  "No messages yet", body "A new agent writes first after its first start. If
  you expect a message and none has come, open the terminal: the agent may be
  waiting on a one-time question there. Otherwise, send the first message
  below." Link "Open terminal" when tmux is enabled; without tmux the middle
  sentence is dropped. It makes no claim about elapsed time.
- Cleared when the first block arrives.

Dismissal: no Hide control or storage. Hints clear themselves for every agent.

## Where shown

- Chat view: a banner above the message list for H1 to H5 (never pushing the
  compose box off a phone screen); H6 replaces the empty state.
- Terminal view: one line above the key buttons in `TmuxPane`, only when a
  `sendTarget` is set, since the copy names keys.
- Detection runs on the thread page only: terminal view, and chat view when
  the thread is empty or the operator's last message is unanswered.

## Detection design

A pure module, `app/lib/pane-hints.ts` (no fs, no env, no `.server`), exports
`classifyPaneHint(capture: string): PaneHintId | null`. The loader calls it on
text it already has and returns only the id. Pane text never crosses into the
chat payload, the same posture as `hashPane`.

Rules, all of which must hold for H1 to H4 (menu dialogs only):
- Only the tail: trailing blank lines dropped, then the last 30 lines, so a
  dialog quoted in the 1000 lines of scrollback does not match.
- Anchored lines: each phrase starts a rendered line after optional
  whitespace and border glyphs, as in `manual_prompt_reason` in
  `packages/base/bin/boot-agents.sh`.
- Two signals in the same menu: a heading or option line AND, within the
  next six menu rows, a selected option or the "Enter to confirm" footer.
  Allow one blank after the phrase, then only contiguous option rows and an
  optional final footer. H1 does not accept unnumbered selections.
- Nothing below it: nonblank output after the block invalidates the match,
  including busy output, an empty composer, a shell prompt, or another menu.
- Case-insensitive, non-breaking spaces normalised. Patterns live in one
  table, each entry naming the CLI version its fixture came from.

Candidate phrases, to be confirmed against real captures before merge
(fixtures are recorded from a real CLI, not typed from memory):
- H1: "Do you trust the files in this folder", "Yes, I trust this folder",
  "Quick safety check" (the base classifier's three trust forms included).
- H2: "Select login method" (menu only).
- H3: "Detected a custom API key", "Do you want to use this API key".
- H4: the base classifier's resume and fullscreen forms, "Choose the text
  style".
- H5: `HINT_SHELL_PROMPT_RE` must match from the start of the last line.
  The shell pattern used by wake detection is unchanged.

The fallback is to show nothing. Any parse doubt, an unknown dialog, an
unsupported variant, an undefined capture or a tmux-disabled instance returns
null, and the user still gets H6 on an empty thread.

Fixtures: a pane capture becomes a fixture only after real sign-in URLs,
tokens, keys, home paths, user and host names and any other identifying
detail are replaced with neutral placeholders. The leak gate scans the
fixture folder like the rest of the tree.

Failure modes:
- False positive (hint while no dialog is showing): bounded by the tail,
  anchoring, the two-signal rule and the nothing-below rule. The cost is a
  wrong sentence until the next refresh; no key is ever sent.
- Stale hint: the hint is recomputed on each loader run from a fresh
  capture, and clears on the next successful applicable refresh. The existing
  poll asks for about 1s in the terminal view and 3s in chat, skips hidden
  tabs and never overlaps a revalidation in flight, so there is no hard
  elapsed-time bound. No hint state is stored server-side.
- Localisation: English only; a localised dialog falls to H6.
- Upstream text changes: the matcher stops matching, the fallback keeps the
  user unblocked, and a fix is one table line plus a fixture.
- Indeterminate capture: a wrong `MC_TMUX_SESSION`, a missing window and a
  tmux error look the same. None of them yields H5; the page stays neutral.
- Parity drift with `boot-agents.sh`: two implementations of the same rule.
  A test feeds the base classifier's trust fixture (numbered) to the Deck
  matcher and expects H1. The unnumbered trust form seen in #24 and #25 is
  covered only by a sanitised retained capture of it; without one, that form
  is unsupported and falls to H6.

## Data and API changes

- Thread loader: adds `hint: PaneHintId | null` to its return. In chat view the
  existing awaiting-reply capture is reused; an empty thread adds one
  `capture-pane` per refresh, only while the thread is empty. H5 reads only
  a successful capture; no new tmux call distinguishes window from session.
- No new route, write path, env var or `/api/tmux-send` change; nothing
  written under the four roots. First-run state is derived, not stored.
- Client: `PaneHintBanner`, an optional `hint` prop on `TmuxPane`, and a
  chat-only H6 when the loader returns no hint for an empty thread.

## Accessibility

- The chat and terminal status regions stay mounted and update their text
  only when it changes. The terminal link keeps focus if still shown; if it
  disappears while focused, focus moves to the message history.
- Text-labelled links and buttons, 44px targets, keyboard reachable, existing
  colour tokens, no meaning by colour alone. The terminal hint is linked to
  the key group with `aria-describedby`.

## Tests

Core behaviour only; no live agent, no tmux.
- `test/pane-hints.test.ts` with fixtures under `test/fixtures/panes/`:
  trust dialog (numbered, and unnumbered if a sanitised retained capture
  exists), login menu, key approval menu, theme picker, shell after exit,
  busy pane, idle composer, unknown dialog. Each expects its id or null.
- Negative cases, the ones that matter most: the trust question quoted in
  scrollback above an idle composer; a trust phrase with no current selector
  or footer; a "/login" or invalid-key error with no menu; the dialog above a
  shell prompt. None yields a dialog hint. A shell prompt on the final line
  still yields H5, as required by its positive-evidence rule.
- Parity: the base `boot-agents.test.sh` trust strings give H1.
- Loader: the payload carries the id and never the pane text; tmux disabled
  gives null; an undefined capture gives null, never H5.
- Component: each id renders its copy; rendering a hint fires no request to
  `/api/tmux-send`; terminal guidance clears with the hint.
- Existing e2e (`e2e/flows/tmux-tab.test.ts`, missing session) gains one
  assertion: an empty thread shows H6 and no H5 copy (the cause of the
  missing pane is unknown there).

## Acceptance criteria

- With a fixture trust capture, the chat view shows H1 with an "Open terminal"
  link, and the terminal view shows the H1 key line above the buttons.
- When the capture changes to an idle composer, the hint is gone on the next
  successful refresh.
- An empty thread with no pane match shows H6.
- No code path added here sends keys, writes a file, or runs the CLI.
- `pnpm typecheck`, `pnpm test`, `check:leaks`, `check:dashes` pass.
- On a real machine, with the agent's pane confirmed by eye to show the trust
  screen, Deck shows H1 before the user touches the terminal. A setup exit
  code alone is not evidence. Pending: needs a signed-in Linux or WSL machine.

## Size estimate

Small, provisional: about 1.5 days (matcher about 120 lines, banner and
`TmuxPane` prop 120, loader 30, tests and fixtures 250). Capturing and
sanitising real fixtures from a clean CLI is the main unknown.

## Open questions for the maintainer

1. Trust dialog default: the base fixture shows "No (default)" preselected,
   while recent CLI versions appear to list "Yes, I trust this folder"
   first. The copy avoids saying which is selected; is that the right call, or should a real capture settle
   it and the copy name the default?
2. Should hints be limited to the first run (for example the assistant and
   platform agent only), or show for every agent that hits the dialog,
   including agents created later? This spec says every agent.
3. "Hide" per tab (sessionStorage) or per browser (localStorage)? Or no Hide
   at all, since the hints clear themselves?
4. The "Provider Unknown" badge shows for every non-Codex agent, which on a
   clean install looks like a fault. Hide it when the agent's `.runtime` is
   not codex, here or in its own issue?
5. H5 says "start the agent again" without a command. Should it name
   `scripts/setup.sh` (once #151 lands), or the INSTALL.md section for a user
   who installed by hand?
6. Sidebar marker (a dot on a thread whose agent is waiting): in this slice or
   a follow-up?

## Log

- 2026-11-18: spec only, from the thread loader, `TmuxPane`,
  `tmux.server.ts`, `boot-agents.sh` and the #151 spec.
- 2026-11-18: review fixes: #151 setup marked planned; first-boot scope for
  H6; existing refresh cadence; H5 on a shell prompt only; error-only
  forms left to the fallback; fixture sanitising.
- 2026-11-18: picked up the approved spec on the implementation branch.
  Applied the six maintainer decisions: no trust default in copy, all agents,
  no Hide, no Provider badge change, no H5 command, and no sidebar marker.
  No real captures were supplied or retained in the worktree, so use existing
  base test inputs and clearly labelled synthetic cases for local verification.
- 2026-11-18: picked up review of the first build. Tighten evidence to the
  current menu block, anchor H5 without changing wake detection, and keep
  announcements and keyboard focus stable across polls.
