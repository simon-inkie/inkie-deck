# #154 slice 2: First live ACP agent in Deck

## Amendment (2026-11-23)

- Boot reports an unconfirmed Codex Resume and leaves the saved checkpoint
  untouched. Starting Codex with a new session is a separate operator action.
- Boot, Base inbox delivery and ACP admission use tmux's default socket and
  the `agents` session. ACP checks for a Base window before and after claiming
  `.runner.lock`. Drain Base agent panes on any other tmux socket before
  switching the agent to ACP.
