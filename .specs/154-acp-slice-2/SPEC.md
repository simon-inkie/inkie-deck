# #154 slice 2: First live ACP agent in Deck

## Amendment (2026-11-23)

- Boot reports an unconfirmed Codex Resume and leaves the saved checkpoint
  untouched. Starting Codex with a new session is a separate operator action.
- Boot, Base inbox delivery and ACP admission use tmux's default socket and
  the `agents` session. ACP checks for a Base window before and after claiming
  `.runner.lock`. Drain Base agent panes on any other tmux socket before
  switching the agent to ACP.

Run one Deck instance per agent home. Concurrent starts from two Deck
processes sharing a home are not guaranteed to be exclusive.

Deck offers Resume only for the verified `agy` executable identity that
advertised resume support. After an `agy` update changes that identity, a
fresh Start replaces Deck's saved checkpoint if the new executable
advertises resume support.

## Step 7: maintainer live agy walkthrough

Use a disposable test agent and a separate Base agent on the same machine.
Record the date, output of `agy --version`, and result on each line. Tick each
box after its check passes.

- [ ] Install `agy` on the Deck host. Stop the test agent's Base runtime and close its tmux panes. Set its `.runtime` to `agy` and `.runner` to `acp`, and run Deck with `MC_ACP_RUNNER=1`. (Date: ____ | agy version: ____ | Result: PENDING)
- [ ] Open the test agent's thread and click **Start**. Confirm the session is running. (Date: ____ | agy version: ____ | Result: PENDING)
- [ ] Send a distinctive prompt. Confirm both the prompt and the agent's reply appear in the thread. (Date: ____ | agy version: ____ | Result: PENDING)
- [ ] Trigger a permission card for a harmless action and approve it. Confirm the action proceeds. (Date: ____ | agy version: ____ | Result: PENDING)
- [ ] Trigger another permission card and deny it. Confirm the action is declined. (Date: ____ | agy version: ____ | Result: PENDING)
- [ ] Click **Stop** and confirm the session stops. (Date: ____ | agy version: ____ | Result: PENDING)
- [ ] Restart Deck with the same configuration and `agy` executable. In the test agent's thread, click **Resume last session** and confirm the agent keeps context. Earlier cards are shown only if the agent replays history on load. (Date: ____ | agy version: ____ | Result: PENDING)
- [ ] Stop the ACP session, remove the test agent's `.runner`, and run `packages/base/bin/boot-agents.sh <test-agent>`. Confirm Base starts the agent in its tmux window. (Date: ____ | agy version: ____ | Result: PENDING)
- [ ] Confirm the separate Base agent on the same machine still runs in its tmux window and receives an inbox message. (Date: ____ | agy version: ____ | Result: PENDING)
