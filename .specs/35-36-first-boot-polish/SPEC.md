# First-boot polish (#35, #36)

## TL;DR

A new Claude agent now gets a standard first message on its first launch, so
day-one persona setup no longer depends on what the user types first (#35).
Panes no longer show the tmux focus-events hint, and `create-agent.sh --model`
makes the agent's model an explicit, documented choice (#36).

## Scope

- `claude-session.sh`: `claude_first_boot_prompt`, `agent_model_flag`.
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
  the same branch #23 uses for a new pinned session. That branch alone is not
  "once": a pruned transcript or a moved config dir also lands there. So the
  message is sent only when the branch is taken, `.first-boot-done` is absent
  (written at launch) and `IDENTITY.md` is still the scaffold or missing.
- Limit: the marker is written at launch, not when claude records the message.
  A launch that dies first does not retry on its own; delete the marker. This
  was chosen over repeating, which risked re-running day one on an established
  agent.
- Existing agents with a conversation, or a written `IDENTITY.md`, are untouched.
- A first-boot agent is not sent "arm your monitor" (it is mid first turn);
  it prints a note. Arming only happens on a relaunch (a running agent is
  skipped), so the user exits the runtime and runs boot-agents.sh again.
- A busy composer after a first boot is treated as ready, as the agent is
  working on its first message. Any other readiness failure still reports.
- focus-events is a tmux server option with no per-session form, so it is set
  globally, as the scripts already do for mouse. Documented in INSTALL.md.
- `--model` accepts plain ids only, because launchers put `.model` unquoted on
  a shell command line. The launchers re-validate (`agent_model_flag`), since
  the file can be hand-edited.
- The `create-agent.sh` verification probe uses the chosen model too.

## Follow-ups

- Codex agents get no first message; codex has no equivalent pinned-session path.
- Optional in #35: collect name, pronouns and time zone at install. Not done.
- The unpinned fallback launch (pin cannot be written) sends no first message.

## Review feedback

Opus review of PR 61, round 1 (no blockers):

1. Should-fix: "exactly once" held only while the `--session-id` branch was
   taken once; a pruned transcript sent an established agent day one again.
   Fixed: `.first-boot-done` marker plus an `IDENTITY.md`-is-scaffold check;
   limit documented here and in INSTALL.md. Tests C8.
2. Should-fix: first-boot agents with `.auto-arm-watcher` were sent the arm
   prompt mid first turn. Fixed: skipped with a note; fixtures no longer delete
   the marker for first-boot, and assert the arm prompt is never typed.
3. Should-fix: test comment claimed a second boot the fixture did not run. Fixed:
   added a `first-boot-again` full-boot fixture (resume, no message, arms).
4. Should-fix: opt-out expectation loosened without reason. Restored to the
   original label.
5. Nits: `.model` validated in both launchers (`agent_model_flag`, C9);
   focus-events override documented in INSTALL.md; INSTALL.md grammar fixed.

Round 2 (re-review at eb23583, no blockers): one docs should-fix. "Restart it" /
"the next boot arms it" was wrong, since boot-agents.sh skips a running agent.
Reworded in INSTALL.md, the boot-agents.sh note and this SPEC to "exit the
runtime, then run boot-agents.sh again". Nits not taken: a stderr pointer to
`.first-boot-done` on a failed launch, and the workspace.sh marker left behind by
a failed send (same documented trade-off; delete the marker to resend).
