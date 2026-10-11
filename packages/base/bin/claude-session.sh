# claude-session.sh - pinned session ids for claude agents. Sourced, not run.
#
# Sourced by boot-agents.sh and workspace.sh, the two launchers, so both pick a
# claude session the same way. Defines functions only; sourcing it has no side
# effects.
#
# WHY A PINNED ID. The launchers used to run `claude --resume <name> || claude`.
# That relied on `--resume <name>` failing for a brand new agent, and with
# current Claude Code it does not fail: it opens an interactive "No sessions
# match" picker and waits, so the fallback never runs and a headless boot sits
# at the picker forever. Even when the fallback did run, the session had no name
# until someone typed `/rename <name>` in it, and every later resume depended on
# that name.
#
# So each agent's session is pinned by id instead, in
# $AGENTS_HOME/<name>/.session-id:
#
#   - pinned id whose transcript holds a conversation
#                                       -> claude --resume <id> -n <name>
#   - no pin, or the transcript is gone or has no messages in it
#                                       -> mint an id, write it, and
#                                          claude --session-id <id> -n <name>
#
# `--resume <id>` with an id that has no conversation does not open the picker,
# but it does exit with "No conversation found with session ID", which leaves a
# dead pane. So the transcript is checked before launching, and a missing or
# empty one starts a fresh named session instead. `-n <name>` is passed on both paths, so the name is on
# the prompt border from the first boot and no `/rename` is needed.
#
# MIGRATION. An agent created before this change has no .session-id, only a
# session someone named by hand. The first boot without a pin looks for that
# session (the newest transcript in the agent's project directory whose latest
# title is the agent's name) and pins it, so an existing agent resumes its
# conversation instead of starting over. With no such session it starts fresh.
#
# WHERE TRANSCRIPTS LIVE. Claude Code writes each session to
# ${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/<dir>/<session-id>.jsonl, where
# <dir> is the physical working directory with every character that is not a
# letter or digit replaced by "-". The agent launches from its own home, so that
# is the directory checked.

# claude_projects_dir -- print the directory Claude Code keeps transcripts in.
claude_projects_dir() {
  printf '%s\n' "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects"
}

# claude_project_dir_for <dir> -- print the transcript directory for sessions
# started in <dir>. Resolves symlinks first, because the process records its
# physical working directory, not the path tmux was given.
claude_project_dir_for() {
  local dir="$1" physical
  physical="$(cd "$dir" 2>/dev/null && pwd -P)" || physical="$dir"
  printf '%s/%s\n' "$(claude_projects_dir)" "${physical//[^a-zA-Z0-9]/-}"
}

# claude_valid_session_id <id> -- succeed if <id> is a lowercase UUID, the only
# shape `--session-id` accepts. Guards against a hand-edited or truncated pin.
claude_valid_session_id() {
  [[ "$1" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]
}

# claude_new_session_id -- print a fresh lowercase UUID. Tries the kernel, then
# uuidgen (macOS), then node, which is already this repository's engine floor.
claude_new_session_id() {
  local id=""
  [[ -r /proc/sys/kernel/random/uuid ]] && id="$(cat /proc/sys/kernel/random/uuid 2>/dev/null)"
  [[ -z "$id" ]] && command -v uuidgen >/dev/null 2>&1 && id="$(uuidgen 2>/dev/null)"
  [[ -z "$id" ]] && command -v node >/dev/null 2>&1 \
    && id="$(node -e 'process.stdout.write(require("node:crypto").randomUUID())' 2>/dev/null)"
  id="$(printf '%s' "$id" | tr 'A-F' 'a-f')"
  claude_valid_session_id "$id" || return 1
  printf '%s\n' "$id"
}

# claude_transcript_has_conversation <file> -- succeed if <file> holds at least
# one user or assistant message. A file existing is not enough: Claude Code
# writes a metadata-only transcript (title, mode, cost) for a session that was
# opened and closed without a message, and `--resume <id>` on that exits with
# "No conversation found with session ID", leaving a dead pane. Seen live: a
# first boot that nobody typed into, then `tmux kill-server`.
claude_transcript_has_conversation() {
  [[ -f "$1" ]] && grep -qE '"type":"(user|assistant)"' "$1" 2>/dev/null
}

# claude_find_named_session <name> <dir> -- print the id of the newest session
# started in <dir> whose latest title is <name>, or nothing. This is the session
# `claude --resume <name>` used to resolve, so it is the one to migrate to.
# Silent on every failure: a lookup that cannot answer must never block a boot.
claude_find_named_session() {
  local name="$1" dir="$2" project f title newest="" newest_mtime=0 mtime
  project="$(claude_project_dir_for "$dir")"
  [[ -d "$project" ]] || return 0
  for f in "$project"/*.jsonl; do
    claude_transcript_has_conversation "$f" || continue
    title="$(grep -o '"customTitle":"[^"]*"' "$f" 2>/dev/null | tail -1)"
    [[ "$title" == "\"customTitle\":\"$name\"" ]] || continue
    mtime="$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null || echo 0)"
    if [[ -z "$newest" || "$mtime" -gt "$newest_mtime" ]]; then
      newest="$f"; newest_mtime="$mtime"
    fi
  done
  [[ -n "$newest" ]] || return 0
  newest="$(basename "$newest" .jsonl)"
  claude_valid_session_id "$newest" && printf '%s\n' "$newest"
  return 0
}

# claude_session_args <agent> <agent_home> -- print the session arguments for
# launching <agent> from <agent_home>: `--resume <id>` or `--session-id <id>`,
# then `-n <agent>`. Writes <agent_home>/.session-id whenever it picks a new or
# migrated id, so the next boot resumes the same session. Fails, printing
# nothing, only if no id can be generated or the pin cannot be written.
claude_session_args() {
  local a="$1" home="$2" pin id="" project
  pin="$home/.session-id"
  project="$(claude_project_dir_for "$home")"

  if [[ -f "$pin" ]]; then
    id="$(tr -d '[:space:]' < "$pin" 2>/dev/null)"
    if claude_valid_session_id "$id" && claude_transcript_has_conversation "$project/$id.jsonl"; then
      printf -- '--resume %s -n %q\n' "$id" "$a"
      return 0
    fi
    echo "claude-session: $a's pinned session ${id:-<empty>} has no conversation in $project; starting a fresh named session" >&2
  else
    id="$(claude_find_named_session "$a" "$home")"
    if [[ -n "$id" ]]; then
      printf '%s\n' "$id" > "$pin" || return 1
      echo "claude-session: pinned $a's existing named session $id" >&2
      printf -- '--resume %s -n %q\n' "$id" "$a"
      return 0
    fi
  fi

  id="$(claude_new_session_id)" || return 1
  printf '%s\n' "$id" > "$pin" || return 1
  printf -- '--session-id %s -n %q\n' "$id" "$a"
}

# claude_first_boot_prompt <session_args> <agent_home> -- print the first message
# to launch the agent with, shell-quoted and ready to append to the claude
# command line, when day one has plausibly not happened. Prints nothing
# otherwise.
#
# WHY. Whether a new agent did its day-one persona work used to depend on what
# the user's first message said: "hello" got it, a test ping did not. Passing
# the message as claude's initial prompt makes the first launch do it, with no
# typing into the pane.
#
# WHEN. All three must hold:
#   1. <session_args> (from claude_session_args) start a new session
#      (`--session-id`), so a resume never gets it.
#   2. <agent_home>/.first-boot-done does not exist. It is written here, as the
#      message is handed to the launcher, so the message goes out once per
#      agent. A pinned transcript that was later pruned (Claude Code expires old
#      ones) or a moved CLAUDE_CONFIG_DIR takes the `--session-id` branch again,
#      and the marker is what stops an established agent being told it is new.
#   3. IDENTITY.md is still the scaffold (it still carries the "self-author on
#      day one" placeholder) or is missing. An agent created before this marker
#      existed, whose persona is already written, is therefore left alone too.
#
# LIMIT. The marker is written at launch, not when the message is recorded. If
# the launch dies before claude records the message, day one is not retried
# automatically: delete .first-boot-done to send it again.
claude_first_boot_prompt() {
  local args="$1" home="$2"
  [[ "$args" == "--session-id "* ]] || return 0
  [[ -e "$home/.first-boot-done" ]] && return 0
  if [[ -f "$home/IDENTITY.md" ]] && ! grep -qi 'self-author on day one' "$home/IDENTITY.md" 2>/dev/null; then
    return 0
  fi
  : > "$home/.first-boot-done" 2>/dev/null || return 0
  printf '%q\n' "This is your first session. Do your day-one steps from your persona files (IDENTITY.md and SOUL.md), then say hello."
}

# agent_model_flag <agent_home> -- print `--model <id>` from <agent_home>/.model,
# or nothing when there is no file. The launchers put the flag on a shell
# command line unquoted, and .model is a plain file people edit by hand, so an
# id with anything but letters, digits, dots, colons and hyphens is refused with
# a warning instead of being run.
agent_model_flag() {
  local file="$1/.model" id
  [[ -f "$file" ]] || return 0
  # First line only, ends trimmed: an interior space must stay in the id so the
  # check below rejects it, rather than being squeezed into a different id.
  id="$(head -n 1 "$file" 2>/dev/null | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  [[ -n "$id" ]] || return 0
  if [[ "$id" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]*$ ]]; then
    printf -- '--model %s\n' "$id"
  else
    echo "claude-session: ignoring $file: '$id' is not a plain model id" >&2
  fi
}
