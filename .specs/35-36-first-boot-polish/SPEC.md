# First-boot polish (#35, #36)

## TL;DR

A new Claude agent now gets a standard first message on its first launch, so
day-one persona setup no longer depends on what the user types first (#35).
Panes no longer show the tmux focus-events hint, and `create-agent.sh --model`
makes the agent's model an explicit, documented choice (#36).

## Scope

- `claude-session.sh`: `claude_first_boot_prompt`.
- `boot-agents.sh`, `workspace.sh`: append it to the claude launch command; set
  tmux `focus-events on` before any pane starts.
- `create-agent.sh`: `--model <id>` writes `.model`.
- `INSTALL.md`: model cost, first message, focus-events.

## Acceptance

- A fresh agent starts its day-one steps without the user asking, once.
- No focus-events hint on a new pane.
- `create-agent.sh --model` reaches the launch command.

## Test plan

- `boot-agents.test.sh`: C8 (prompt only on a new session, never after a
  conversation exists, repeated if no message was recorded); a full-boot case
  checking one send, `--session-id`, `--model`, and focus-events ordering.
- `create-agent.test.ts`: `.model` written only when asked; unsafe ids refused.

## Decisions log

- Trigger is claude's positional initial prompt on the `--session-id` branch,
  the same branch #23 uses for a new pinned session. "Exactly once" follows from
  the pin: the prompt becomes the first message, so the next boot resumes.
- A first boot killed before any message was recorded gets the message again,
  which is right: day one has not happened.
- Existing agents with a conversation are untouched (resume path).
- A busy composer after a first boot is treated as ready, as the agent is
  working on its first message. Any other readiness failure still reports.
- focus-events is a tmux server option with no per-session form, so it is set
  globally, as the scripts already do for mouse. Documented in INSTALL.md.
- `--model` accepts plain ids only, because launchers put `.model` unquoted on
  a shell command line.
- The `create-agent.sh` verification probe uses the chosen model too.

## Follow-ups

- Codex agents get no first message; codex has no equivalent pinned-session path.
- Optional in #35: collect name, pronouns and time zone at install. Not done.
- The unpinned fallback launch (pin cannot be written) sends no first message.

## Review feedback

(none yet)
