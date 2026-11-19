#!/usr/bin/env bash
# Tests for the cross-harness launch wiring: bin/runtime-launch.sh (the
# per-runtime launch constructors and session lookups), runtime selection in
# bin/boot-agents.sh and bin/workspace.sh, and bin/sync-gemini-includes.sh.
#
#   bash packages/base/test/multi-harness.test.sh
#     -> prints PASS/FAIL per case, exits non-zero on any fail.
#
# NO LIVE TMUX AND NO LIVE RUNTIME. `tmux`, `claude`, `codex` and `agy` are
# stub scripts on a PATH built for the test; the tmux stub logs every call so
# the launch command each agent was given can be read back. HOME, AGENTS_HOME,
# CLAUDE_CONFIG_DIR and the agy history file all point into a scratch tree.
set +e

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="$(cd "$HERE/../bin" && pwd)"

BOX="$(mktemp -d)"
trap 'rm -rf "$BOX"' EXIT

PASS=0
FAILS=0
pass() { echo "PASS  $1"; PASS=$((PASS+1)); }
fail() { echo "FAIL  $1${2:+ -- $2}"; FAILS=$((FAILS+1)); }
check() { local label="$1"; shift; if "$@"; then pass "$label"; else fail "$label"; fi; }

export HOME="$BOX/home"
export AGENTS_HOME="$BOX/agents"
export CLAUDE_CONFIG_DIR="$BOX/claude-config"
export AGY_HISTORY_FILE="$BOX/agy-history.jsonl"
unset CODEX_HOME
mkdir -p "$HOME" "$AGENTS_HOME" "$BOX/stubs"

# make_agent <name> <runtime>
make_agent() {
  mkdir -p "$AGENTS_HOME/$1"
  : > "$AGENTS_HOME/$1/SOUL.md"
  printf '%s\n' "$2" > "$AGENTS_HOME/$1/.runtime"
}

# ===== runtime-launch.sh, sourced directly ==================================

. "$BIN_DIR/runtime-launch.sh"
if declare -F agy_launch_command >/dev/null && declare -F codex_launch_command >/dev/null; then
  pass "runtime-launch.sh sources and defines both constructors"
else
  fail "runtime-launch.sh sources and defines both constructors"
  echo "multi-harness: $PASS passed, $FAILS failed"
  exit 1
fi

make_agent ann agy
make_agent anna agy
hist_line() { printf '{"display":"%s","timestamp":%s,"workspace":"%s","conversationId":"%s"}\n' "$1" "$2" "$3" "$4"; }

# L1: no history file -> no id, no error.
rm -f "$AGY_HISTORY_FILE"
got="$(agy_latest_conversation_for_workspace ann 2>&1)"
check "L1 agy lookup: no history file gives no id" test -z "$got"

# L2: the newest entry for this workspace wins; a later entry for a longer name
# that starts with this one ("anna" for "ann") and one for another directory
# are not this agent's.
{
  hist_line "first" 1 "$AGENTS_HOME/ann" "c-old-1"
  hist_line "second" 2 "$AGENTS_HOME/ann" "c-new-2"
  hist_line "other" 3 "$AGENTS_HOME/anna" "c-anna-3"
  hist_line "scratch" 4 "/tmp/scratch" "c-tmp-4"
} > "$AGY_HISTORY_FILE"
got="$(agy_latest_conversation_for_workspace ann)"
check "L2 agy lookup: newest entry for the workspace, prefix name not matched" test "$got" = "c-new-2"
got="$(agy_latest_conversation_for_workspace anna)"
check "L2 agy lookup: the longer name finds its own" test "$got" = "c-anna-3"

printf '{"workspace": "%s/\\u0061nn", "conversationId": "c-decoded"}\n' "$AGENTS_HOME" >> "$AGY_HISTORY_FILE"
printf '{"workspace":"%s/ann","conversationId":"c-unfinished"' "$AGENTS_HOME" >> "$AGY_HISTORY_FILE"
got="$(agy_latest_conversation_for_workspace ann)"
check "agy lookup: decoded workspace matches and an unfinished record is ignored" test "$got" = "c-decoded"
printf '\n' >> "$AGY_HISTORY_FILE"

# L3: an id that is not a plain token never reaches a command line.
hist_line "bad" 5 "$AGENTS_HOME/ann" 'x;touch /tmp/pwned' >> "$AGY_HISTORY_FILE"
got="$(agy_latest_conversation_for_workspace ann)"
check "L3 agy lookup: an unsafe id is refused" test -z "$got"
rm -f "$AGY_HISTORY_FILE"

# L4: the agy launch command carries identity, inbox root, model and resume, and
# never switches the runtime's own permission prompts off.
printf '%s' "$BOX/inbox" > "$AGENTS_HOME/ann/.inbox-root"
cmd="$(agy_launch_command ann "keeps notes" c-new-2 "--model gemini-x")"
case "$cmd" in
  *"env AGENT_NAME=ann AGENT_ROLE=keeps\\ notes INBOX_ROOT=$BOX/inbox agy --model gemini-x --conversation c-new-2") ok=1 ;;
  *) ok=0 ;;
esac
[[ "$cmd" == *"[ -f $AGENTS_HOME/ann/.env.secrets ] && . $AGENTS_HOME/ann/.env.secrets;"* ]] || ok=0
[[ "$cmd" == *dangerously* ]] && ok=0
[[ "$ok" -eq 1 ]] && pass "L4 agy launch command: identity, inbox root, model, resume" || fail "L4 agy launch command" "$cmd"

# L5: a first boot (no id) is a plain launch; no marker means no INBOX_ROOT.
cmd="$(agy_launch_command anna "" "" "")"
[[ "$cmd" == *" agy" && "$cmd" != *INBOX_ROOT* && "$cmd" != *--conversation* ]] \
  && pass "L5 agy first boot: plain launch, no inbox root without a marker" || fail "L5 agy first boot" "$cmd"

# L6: the Codex command gains INBOX_ROOT from the same marker, and only then.
make_agent cobalt codex
cmd="$(codex_launch_command cobalt "" "" "" "")"
[[ "$cmd" != *INBOX_ROOT* ]] && pass "L6 codex: no marker, no INBOX_ROOT" || fail "L6 codex: no marker, no INBOX_ROOT" "$cmd"
printf '%s\n' "$BOX/inbox" > "$AGENTS_HOME/cobalt/.inbox-root"
cmd="$(codex_launch_command cobalt "" "" "" "")"
[[ "$cmd" == *"AGENT_NAME=cobalt AGENT_ROLE='' INBOX_ROOT=$BOX/inbox codex" ]] \
  && pass "L6 codex: the marker becomes INBOX_ROOT on the process environment" || fail "L6 codex: marker" "$cmd"

# L7: a relative or empty marker is ignored, not placed on a command line.
printf 'relative/path' > "$AGENTS_HOME/cobalt/.inbox-root"
cmd="$(codex_launch_command cobalt "" "" "" "" 2>/dev/null)"
[[ "$cmd" != *INBOX_ROOT* ]] && pass "L7 a relative inbox-root marker is ignored" || fail "L7 relative marker" "$cmd"
rm -f "$AGENTS_HOME/cobalt/.inbox-root"

# ===== launch selection through the real launchers ===========================
# Stub binaries on PATH. The tmux stub logs its arguments one call per line and
# answers just enough for the launchers to proceed: no pane is running a
# runtime, every window already exists, captures are empty.
cat > "$BOX/stubs/tmux" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$TMUX_LOG"
case "$1" in
  has-session) exit 1 ;;
  list-windows) for d in "$AGENTS_HOME"/*/; do basename "$d"; done ;;
  list-panes) echo bash ;;
  capture-pane) : ;;
esac
exit 0
STUB
for rt in claude codex agy; do
  printf '#!/usr/bin/env bash\necho "%s stub must not run" >&2\nexit 99\n' "$rt" > "$BOX/stubs/$rt"
done
chmod +x "$BOX/stubs/"*
STUB_PATH="$BOX/stubs:/usr/bin:/bin:$(dirname "$(command -v node 2>/dev/null || echo /usr/bin/node)")"
export TMUX_LOG="$BOX/tmux.log"

# A three-agent home, one per runtime. The agy agent has a GEMINI.md whose fence
# is behind its source, and a conversation in the history file.
rm -rf "$AGENTS_HOME"; mkdir -p "$AGENTS_HOME"
make_agent claudia claude
make_agent cobalt codex
make_agent gale agy
printf 'Gale is new\n' > "$AGENTS_HOME/gale/IDENTITY.md"
printf '# gale\n<!-- BEGIN SYNCED:IDENTITY.md (generated) -->\nstale\n<!-- END SYNCED:IDENTITY.md -->\n' > "$AGENTS_HOME/gale/GEMINI.md"
hist_line "hi" 1 "$AGENTS_HOME/gale" "gale-conv-1" > "$AGY_HISTORY_FILE"

sent_to() { grep -E "^send-keys -t agents:$1 " "$TMUX_LOG" | head -1; }

: > "$TMUX_LOG"
PATH="$STUB_PATH" BOOT_STAGGER_SECS=0 BOOT_READY_SECS=1 CODEX_RESUME_VERIFY_SECS=0 \
  bash "$BIN_DIR/boot-agents.sh" claudia cobalt gale >"$BOX/boot.out" 2>&1
line="$(sent_to claudia)"
[[ "$line" == *" claude --session-id "* ]] && pass "B1 boot: a claude agent is launched with claude" || fail "B1 boot: claude agent" "$line"
line="$(sent_to cobalt)"
[[ "$line" == *"env AGENT_NAME=cobalt "*" codex Enter" ]] && pass "B2 boot: a codex agent is launched with codex" || fail "B2 boot: codex agent" "$line"
line="$(sent_to gale)"
[[ "$line" == *"env AGENT_NAME=gale "*" agy --conversation gale-conv-1 Enter" ]] \
  && pass "B3 boot: an agy agent is launched with agy and resumes its own conversation" || fail "B3 boot: agy agent" "$line"
grep -qx 'Gale is new' "$AGENTS_HOME/gale/GEMINI.md" && ! grep -qx stale "$AGENTS_HOME/gale/GEMINI.md" \
  && pass "B4 boot: GEMINI.md is re-synced before the agy launch" || fail "B4 boot: GEMINI.md re-sync" "$(cat "$AGENTS_HOME/gale/GEMINI.md")"
if grep -q 'stub must not run' "$BOX/boot.out"; then fail "B5 boot: no runtime binary is executed by the launcher itself"; else pass "B5 boot: no runtime binary is executed by the launcher itself"; fi

# B6: an agy pane that is already running is left alone.
cat > "$BOX/stubs/tmux" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$TMUX_LOG"
case "$1" in
  list-windows) for d in "$AGENTS_HOME"/*/; do basename "$d"; done ;;
  list-panes) echo agy ;;
  capture-pane) : ;;
esac
exit 0
STUB
: > "$TMUX_LOG"
PATH="$STUB_PATH" BOOT_STAGGER_SECS=0 BOOT_READY_SECS=1 bash "$BIN_DIR/boot-agents.sh" gale >"$BOX/boot2.out" 2>&1
if grep -q '^send-keys' "$TMUX_LOG"; then fail "B6 boot: a running agy pane is not relaunched" "$(cat "$TMUX_LOG")"; else pass "B6 boot: a running agy pane is not relaunched"; fi

# W1-W3: workspace.sh dry run prints the same commands, one per runtime. The
# boot above used claudia's day-one message; reset it so W4 can see whether the
# dry run would use it up.
rm -f "$AGENTS_HOME/claudia/.first-boot-done" "$AGENTS_HOME/claudia/.session-id"
out="$(PATH="$STUB_PATH" WORKSPACE_DRY_RUN=1 bash "$BIN_DIR/workspace.sh" claudia cobalt gale 2>&1)"
[[ "$(printf '%s\n' "$out" | grep '^claudia')" == *" claude --resume "* || "$(printf '%s\n' "$out" | grep '^claudia')" == *" claude --session-id "* ]] \
  && pass "W1 workspace: claude agent gets claude" || fail "W1 workspace: claude agent" "$out"
[[ "$(printf '%s\n' "$out" | grep '^cobalt')" == *"env AGENT_NAME=cobalt "*" codex" ]] \
  && pass "W2 workspace: codex agent gets the shared codex envelope" || fail "W2 workspace: codex agent" "$out"
[[ "$(printf '%s\n' "$out" | grep '^gale')" == *" agy --conversation gale-conv-1" ]] \
  && pass "W3 workspace: agy agent gets agy, resuming its own conversation" || fail "W3 workspace: agy agent" "$out"
[[ ! -e "$AGENTS_HOME/claudia/.first-boot-done" ]] \
  && pass "W4 workspace dry run does not use up the day-one message" || fail "W4 workspace dry run used the day-one marker"

# W5: --runtime overrides every agent's .runtime.
out="$(PATH="$STUB_PATH" WORKSPACE_DRY_RUN=1 bash "$BIN_DIR/workspace.sh" --runtime agy cobalt 2>&1)"
[[ "$out" == *"env AGENT_NAME=cobalt "*" agy"* ]] && pass "W5 workspace --runtime overrides .runtime" || fail "W5 workspace --runtime" "$out"

# W6: a real (stubbed) workspace run sends each pane its runtime's command.
cat > "$BOX/stubs/tmux" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$TMUX_LOG"
case "$1" in
  has-session) exit 1 ;;
  list-windows) for d in "$AGENTS_HOME"/*/; do basename "$d"; done ;;
esac
exit 0
STUB
: > "$TMUX_LOG"
PATH="$STUB_PATH" WATCHER_ENABLED=0 bash "$BIN_DIR/workspace.sh" claudia cobalt gale >"$BOX/ws.out" 2>&1
ws_rc=$?
[[ "$ws_rc" -eq 0 && "$(sent_to cobalt)" == *" codex Enter" && "$(sent_to gale)" == *" agy --conversation gale-conv-1 Enter" && "$(sent_to claudia)" == *" claude "* ]] \
  && pass "W6 workspace run: each pane is sent its own runtime's command" || fail "W6 workspace run" "rc=$ws_rc $(cat "$TMUX_LOG")"

provider_home="$AGENTS_HOME/cobalt/.codex-home"
exported_home="$BOX/exported codex"
mkdir -p "$provider_home/sessions" "$exported_home/sessions" "$HOME/.codex/sessions"
touch "$provider_home/config.toml"
codex_session() {
  printf '{"type":"session_meta","payload":{"id":"%s","cwd":"%s/cobalt","originator":"codex-tui","thread_source":"user"}}\n' "$2" "$AGENTS_HOME" \
    > "$1/sessions/rollout-fixture-$2.jsonl"
}
codex_session "$HOME/.codex" shared
codex_session "$provider_home" provider
codex_session "$exported_home" exported
out="$(PATH="$STUB_PATH" WORKSPACE_DRY_RUN=1 bash "$BIN_DIR/workspace.sh" cobalt 2>&1)"
[[ "$out" == *" CODEX_HOME=$provider_home codex resume provider" ]] \
  && pass "workspace uses the per-agent Codex home when CODEX_HOME is unset" || fail "workspace per-agent Codex home" "$out"
out="$(PATH="$STUB_PATH" WORKSPACE_DRY_RUN=1 CODEX_HOME="$exported_home" bash "$BIN_DIR/workspace.sh" cobalt 2>&1)"
[[ "$out" == *" CODEX_HOME=$(printf '%q' "$exported_home") codex resume exported" ]] \
  && pass "workspace passes the exported Codex home and resumes from it" || fail "workspace exported Codex home" "$out"
out="$(PATH="$STUB_PATH" WORKSPACE_DRY_RUN=1 CODEX_HOME="$BOX/empty" bash "$BIN_DIR/workspace.sh" cobalt 2>&1)"
[[ "$out" == *" CODEX_HOME=$BOX/empty codex" ]] \
  && pass "workspace starts fresh when the selected Codex home has no sessions" || fail "workspace fresh Codex launch" "$out"

# ===== sync-gemini-includes.sh ==============================================
SYNC="$BIN_DIR/sync-gemini-includes.sh"
S_DIR="$BOX/sync"; mkdir -p "$S_DIR/agent"
printf 'shared rules\n' > "$S_DIR/SYSTEM.md"
printf 'who I am\nboot-0000000000000000' > "$S_DIR/agent/IDENTITY.md"   # no final newline
cat > "$S_DIR/agent/GEMINI.md" <<'EOF'
# agent
<!-- BEGIN SYNCED:IDENTITY.md (generated) -->
old identity
<!-- END SYNCED:IDENTITY.md -->
between
<!-- BEGIN SYNCED:../SYSTEM.md (generated) -->
<!-- END SYNCED:../SYSTEM.md -->
tail
EOF
bash "$SYNC" "$S_DIR/agent/GEMINI.md" >/dev/null 2>&1; rc1=$?
first="$(cat "$S_DIR/agent/GEMINI.md"; echo x)"
bash "$SYNC" "$S_DIR/agent/GEMINI.md" >/dev/null 2>&1; rc2=$?
second="$(cat "$S_DIR/agent/GEMINI.md"; echo x)"
[[ "$rc1" -eq 0 && "$rc2" -eq 0 && "$first" == "$second" ]] \
  && pass "S1 sync is idempotent: a second run is byte-identical" || fail "S1 sync idempotent" "rc1=$rc1 rc2=$rc2"
grep -qx 'boot-0000000000000000' "$S_DIR/agent/GEMINI.md" && grep -qx '<!-- END SYNCED:IDENTITY.md -->' "$S_DIR/agent/GEMINI.md" \
  && pass "S2 a source with no final newline still leaves the END marker on its own line" || fail "S2 no final newline" "$(cat "$S_DIR/agent/GEMINI.md")"
grep -qx 'shared rules' "$S_DIR/agent/GEMINI.md" && grep -qx 'between' "$S_DIR/agent/GEMINI.md" && grep -qx 'tail' "$S_DIR/agent/GEMINI.md" \
  && ! grep -q 'old identity' "$S_DIR/agent/GEMINI.md" \
  && pass "S3 relative paths resolve against the GEMINI.md; text outside fences is kept" || fail "S3 relative paths" "$(cat "$S_DIR/agent/GEMINI.md")"

# S4: a missing source leaves the file exactly as it was, and fails.
before="$(cat "$S_DIR/agent/GEMINI.md"; echo x)"
printf '<!-- BEGIN SYNCED:NOPE.md -->\n<!-- END SYNCED:NOPE.md -->\n' >> "$S_DIR/agent/GEMINI.md"
before="$(cat "$S_DIR/agent/GEMINI.md"; echo x)"
bash "$SYNC" "$S_DIR/agent/GEMINI.md" >/dev/null 2>&1; rc=$?
after="$(cat "$S_DIR/agent/GEMINI.md"; echo x)"
[[ "$rc" -ne 0 && "$before" == "$after" ]] && pass "S4 a missing source fails and leaves the file untouched" || fail "S4 missing source" "rc=$rc"

# S5: a BEGIN with no END fails and leaves the file untouched.
printf '# x\n<!-- BEGIN SYNCED:IDENTITY.md -->\nbody\n' > "$S_DIR/agent/GEMINI.md"
before="$(cat "$S_DIR/agent/GEMINI.md"; echo x)"
bash "$SYNC" "$S_DIR/agent/GEMINI.md" >/dev/null 2>&1; rc=$?
after="$(cat "$S_DIR/agent/GEMINI.md"; echo x)"
[[ "$rc" -ne 0 && "$before" == "$after" ]] && pass "S5 an unterminated fence fails and leaves the file untouched" || fail "S5 unterminated fence" "rc=$rc"
leftover="$(find "$S_DIR/agent" -name 'GEMINI.md.sync.*' | wc -l)"
[[ "$leftover" -eq 0 ]] && pass "S6 a failed sync leaves no temporary file behind" || fail "S6 temporary files left" "$leftover"

# S7: with no arguments, only agents whose .runtime is agy are synced.
rm -rf "$AGENTS_HOME"; mkdir -p "$AGENTS_HOME"
make_agent gale agy; make_agent cobalt codex
for a in gale cobalt; do
  printf 'id-%s\n' "$a" > "$AGENTS_HOME/$a/IDENTITY.md"
  printf '<!-- BEGIN SYNCED:IDENTITY.md -->\n<!-- END SYNCED:IDENTITY.md -->\n' > "$AGENTS_HOME/$a/GEMINI.md"
done
bash "$SYNC" >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 0 ]] && grep -qx 'id-gale' "$AGENTS_HOME/gale/GEMINI.md" && ! grep -q 'id-cobalt' "$AGENTS_HOME/cobalt/GEMINI.md" \
  && pass "S7 no arguments: only agy agents under AGENTS_HOME are synced" || fail "S7 discovery" "rc=$rc"

cat > "$S_DIR/agent/SOUL.md" <<'EOF'
Examples of generated markers:
    <!-- END SYNCED:SOUL.md -->
> <!-- END SYNCED:SOUL.md -->
EOF
printf '<!-- BEGIN SYNCED:SOUL.md -->\n<!-- END SYNCED:SOUL.md -->\n' > "$S_DIR/agent/GEMINI.md"
bash "$SYNC" "$S_DIR/agent/GEMINI.md" >/dev/null 2>&1; rc1=$?
first="$(cat "$S_DIR/agent/GEMINI.md"; echo x)"
bash "$SYNC" "$S_DIR/agent/GEMINI.md" >/dev/null 2>&1; rc2=$?
second="$(cat "$S_DIR/agent/GEMINI.md"; echo x)"
[[ "$rc1" -eq 0 && "$rc2" -eq 0 && "$first" == "$second" ]] \
  && grep -qx '> <!-- END SYNCED:SOUL.md -->' "$S_DIR/agent/GEMINI.md" \
  && pass "sync leaves indented and quoted END examples untouched on repeated runs" || fail "sync with END marker examples"

printf 'new source text\n' >> "$S_DIR/agent/SOUL.md"
printf '#!/bin/sh\nprintf "partial output\\n"\nexit 1\n' > "$BOX/stubs/cat"
chmod +x "$BOX/stubs/cat"
PATH="$STUB_PATH" bash "$SYNC" "$S_DIR/agent/GEMINI.md" >/dev/null 2>&1; rc=$?
after="$(cat "$S_DIR/agent/GEMINI.md"; echo x)"
[[ "$rc" -ne 0 && "$second" == "$after" ]] \
  && pass "sync leaves the original intact after a partial copy fails" || fail "sync partial copy" "rc=$rc"

for marker in '<!-- END SYNCED:SOUL.md -->' '<!-- BEGIN SYNCED:SOUL.md -->'; do
  for example in plain fenced; do
    if [[ "$example" == fenced ]]; then
      printf '```markdown\n%s\n```\n' "$marker" > "$S_DIR/agent/SOUL.md"
    else
      printf '%s\n' "$marker" > "$S_DIR/agent/SOUL.md"
    fi
    for attempt in 1 2; do
      out="$(bash "$SYNC" "$S_DIR/agent/GEMINI.md" 2>&1)"; rc=$?
      after="$(cat "$S_DIR/agent/GEMINI.md"; echo x)"
      label="sync attempt $attempt rejects $example $marker without changing the target"
      [[ "$rc" -ne 0 && "$second" == "$after" && "$out" == *"source $S_DIR/agent/SOUL.md contains a SYNCED fence: $marker"* ]] \
        && pass "$label" || fail "$label" "rc=$rc $out"
    done
  done
done

echo
echo "multi-harness: $PASS passed, $FAILS failed"
[ "$FAILS" -eq 0 ]
