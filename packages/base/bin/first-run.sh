#!/usr/bin/env bash
# first-run.sh - name your two starter agents and create them.
#
# One command for a new install: an assistant you talk to, and a platform
# agent that changes the setup. It wraps create-agent.sh, so each agent is
# still created in both homes and still has to pass the boot phrase proof.
#
# Usage:
#   bin/first-run.sh [--assistant <name>] [--platform <name>] [--model <id>]
#                    [--no-verify] [--agents-home <dir>] [--inbox-root <dir>]
#
#   --assistant <name>   the agent you talk to (asked for, default "inkie")
#   --platform <name>    the agent that changes the setup (asked for, default
#                        "doctor")
#   --model <id>         passed to create-agent.sh for both agents
#   --no-verify          create without the boot phrase proof (exit 4)
#   --agents-home <dir>  where agent homes live (default: $AGENTS_HOME, then
#                        $AGENTS_ROOT, then $HOME/agents)
#   --inbox-root <dir>   where inboxes live (default: $INBOX_ROOT)
#
# Both names are checked before either agent is created, so a typo in the
# second never leaves a lone assistant behind. Re-running is safe: a kind that
# already has an agent (a .kind file in its home) is reported and skipped.
#
# Exit codes: 1 if either creation hit a scaffold error or the names were
# refused, else 3 if either verification failed, else 4 if either could not be
# verified, else 0. Both verdict lines are always printed.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CREATE="$SCRIPT_DIR/create-agent.sh"

ASSISTANT=""
PLATFORM=""
MODEL=""
NO_VERIFY=0
AGENTS_HOME_ARG=""
INBOX_ROOT_ARG=""

usage() {
  local line first=1
  while IFS= read -r line; do
    if [[ $first -eq 1 ]]; then first=0; continue; fi
    [[ "$line" == \#* ]] || break
    printf '%s\n' "${line/#\# /}" | sed 's/^#$//'
  done < "${BASH_SOURCE[0]}"
}

fail() { printf 'first-run: %s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)     usage; exit 0 ;;
    --assistant)   [[ $# -ge 2 ]] || fail "--assistant needs a value";   ASSISTANT="$2";       shift 2 ;;
    --platform)    [[ $# -ge 2 ]] || fail "--platform needs a value";    PLATFORM="$2";        shift 2 ;;
    --model)       [[ $# -ge 2 ]] || fail "--model needs a value";       MODEL="$2";           shift 2 ;;
    --agents-home) [[ $# -ge 2 ]] || fail "--agents-home needs a value"; AGENTS_HOME_ARG="$2"; shift 2 ;;
    --inbox-root)  [[ $# -ge 2 ]] || fail "--inbox-root needs a value";  INBOX_ROOT_ARG="$2";  shift 2 ;;
    --no-verify)   NO_VERIFY=1; shift ;;
    *)             fail "unknown argument: $1 (run with --help)" ;;
  esac
done

# Same resolution create-agent.sh uses, so both look at the same directory.
if [[ -n "$AGENTS_HOME_ARG" ]]; then AGENTS_HOME="$AGENTS_HOME_ARG"
elif [[ -n "${AGENTS_HOME:-}" ]]; then :
elif [[ -n "${AGENTS_ROOT:-}" ]]; then AGENTS_HOME="$AGENTS_ROOT"
else AGENTS_HOME="$HOME/agents"
fi

COMMON=()
[[ -n "$AGENTS_HOME_ARG" ]] && COMMON+=(--agents-home "$AGENTS_HOME_ARG")
[[ -n "$INBOX_ROOT_ARG" ]] && COMMON+=(--inbox-root "$INBOX_ROOT_ARG")

# The name of an existing agent of this kind, from its .kind marker.
existing_of_kind() {
  local kind="$1" marker
  for marker in "$AGENTS_HOME"/*/.kind; do
    [[ -f "$marker" ]] || continue
    if [[ "$(head -n1 "$marker" | tr -d '[:space:]')" == "$kind" ]]; then
      basename "$(dirname "$marker")"
      return
    fi
  done
}

EXISTING_ASSISTANT="$(existing_of_kind assistant)"
EXISTING_PLATFORM="$(existing_of_kind platform)"

# Ask for a name, offering a default, until create-agent.sh accepts it.
# $1 kind label, $2 default, $3 a name already chosen (must differ).
ask_name() {
  local label="$1" default="$2" other="$3" reply
  while true; do
    printf '%s name [%s]: ' "$label" "$default" >&2
    read -r reply || fail "no $label name given"
    reply="${reply#"${reply%%[![:space:]]*}"}"; reply="${reply%"${reply##*[![:space:]]}"}"
    reply="${reply:-$default}"
    if [[ -n "$other" && "$reply" == "$other" ]]; then
      printf 'The two agents need different names.\n' >&2
    elif "$CREATE" --check-name "$reply" ${COMMON[@]+"${COMMON[@]}"} >/dev/null 2>&1; then
      printf '%s' "$reply"; return
    else
      "$CREATE" --check-name "$reply" ${COMMON[@]+"${COMMON[@]}"} >&2 2>&1 || true
    fi
  done
}

NEED_ASSISTANT=0; NEED_PLATFORM=0
[[ -n "$EXISTING_ASSISTANT" ]] || NEED_ASSISTANT=1
[[ -n "$EXISTING_PLATFORM" ]] || NEED_PLATFORM=1

if [[ $NEED_ASSISTANT -eq 0 && $NEED_PLATFORM -eq 0 ]]; then
  printf 'first-run: assistant "%s" and platform agent "%s" already exist. Nothing to do.\n' \
    "$EXISTING_ASSISTANT" "$EXISTING_PLATFORM"
  exit 0
fi
[[ $NEED_ASSISTANT -eq 1 ]] || printf 'first-run: assistant "%s" already exists, skipping it.\n' "$EXISTING_ASSISTANT"
[[ $NEED_PLATFORM -eq 1 ]] || printf 'first-run: platform agent "%s" already exists, skipping it.\n' "$EXISTING_PLATFORM"

# Interrupted-run recovery: the surviving agent already carries its peer's name
# (.peer, written at creation). The missing agent takes that name, not whatever
# was typed this time, so the two briefs stay consistent.
saved_peer() { head -n1 "$AGENTS_HOME/$1/.peer" 2>/dev/null | tr -d '[:space:]'; }
if [[ $NEED_PLATFORM -eq 1 && $NEED_ASSISTANT -eq 0 ]]; then
  SAVED="$(saved_peer "$EXISTING_ASSISTANT")"
  if [[ -n "$SAVED" ]]; then
    [[ -z "$PLATFORM" || "$PLATFORM" == "$SAVED" ]] || \
      printf 'first-run: "%s" already names its platform agent "%s"; using that, not "%s".\n' "$EXISTING_ASSISTANT" "$SAVED" "$PLATFORM"
    PLATFORM="$SAVED"
  fi
fi
if [[ $NEED_ASSISTANT -eq 1 && $NEED_PLATFORM -eq 0 ]]; then
  SAVED="$(saved_peer "$EXISTING_PLATFORM")"
  if [[ -n "$SAVED" ]]; then
    [[ -z "$ASSISTANT" || "$ASSISTANT" == "$SAVED" ]] || \
      printf 'first-run: "%s" already names its assistant "%s"; using that, not "%s".\n' "$EXISTING_PLATFORM" "$SAVED" "$ASSISTANT"
    ASSISTANT="$SAVED"
  fi
fi

if [[ $NEED_ASSISTANT -eq 1 && -z "$ASSISTANT" ]]; then
  [[ -t 0 ]] || fail "no assistant name given (pass --assistant <name>)"
  ASSISTANT="$(ask_name assistant inkie "$PLATFORM")" || exit 1
fi
if [[ $NEED_PLATFORM -eq 1 && -z "$PLATFORM" ]]; then
  [[ -t 0 ]] || fail "no platform agent name given (pass --platform <name>)"
  PLATFORM="$(ask_name "platform agent" doctor "$ASSISTANT")" || exit 1
fi

# Check everything before creating anything.
if [[ $NEED_ASSISTANT -eq 1 && $NEED_PLATFORM -eq 1 && "$ASSISTANT" == "$PLATFORM" ]]; then
  fail "the two agents need different names, got \"$ASSISTANT\" twice. Nothing was created."
fi
CHECKS_OK=1
if [[ $NEED_ASSISTANT -eq 1 ]]; then
  "$CREATE" --check-name "$ASSISTANT" ${COMMON[@]+"${COMMON[@]}"} >/dev/null || CHECKS_OK=0
fi
if [[ $NEED_PLATFORM -eq 1 ]]; then
  "$CREATE" --check-name "$PLATFORM" ${COMMON[@]+"${COMMON[@]}"} >/dev/null || CHECKS_OK=0
fi
if [[ $CHECKS_OK -eq 0 ]]; then
  for name in $([[ $NEED_ASSISTANT -eq 1 ]] && echo "$ASSISTANT") $([[ $NEED_PLATFORM -eq 1 ]] && echo "$PLATFORM"); do
    "$CREATE" --check-name "$name" ${COMMON[@]+"${COMMON[@]}"} >/dev/null || \
      "$CREATE" --check-name "$name" ${COMMON[@]+"${COMMON[@]}"} 2>&1 >/dev/null | sed 's/^/  /' >&2
  done
  fail "a name was refused. Nothing was created."
fi

ARGS=(${COMMON[@]+"${COMMON[@]}"})
[[ -n "$MODEL" ]] && ARGS+=(--model "$MODEL")
[[ $NO_VERIFY -eq 1 ]] && ARGS+=(--no-verify)

declare -A RC
create_one() {
  local kind="$1" name="$2" peer="$3"
  # if/else so a non-zero exit is captured, not fatal, even under `bash -e`.
  if "$CREATE" "$name" --kind "$kind" --peer "$peer" "${ARGS[@]}"; then
    RC[$kind]=0
  else
    RC[$kind]=$?
  fi
}

# The peer is the surviving agent's ACTUAL name, never a newly typed one.
ASSISTANT_PEER="${EXISTING_PLATFORM:-$PLATFORM}"
PLATFORM_PEER="${EXISTING_ASSISTANT:-$ASSISTANT}"
[[ $NEED_ASSISTANT -eq 1 ]] && create_one assistant "$ASSISTANT" "$ASSISTANT_PEER"
[[ $NEED_PLATFORM -eq 1 ]] && create_one platform "$PLATFORM" "$PLATFORM_PEER"

verdict() {
  case "$1" in
    0) echo VERIFIED ;;
    1) echo "SCAFFOLD ERROR" ;;
    3) echo FAILED ;;
    4) echo "CANNOT VERIFY" ;;
    *) echo "EXIT $1" ;;
  esac
}

printf '\n'
worst=0
rank() { case "$1" in 1) echo 4 ;; 3) echo 3 ;; 4) echo 2 ;; 0) echo 0 ;; *) echo 4 ;; esac; }
[[ $NEED_ASSISTANT -eq 1 ]] && printf 'first-run: assistant %s: %s\n' "$ASSISTANT" "$(verdict "${RC[assistant]}")"
[[ $NEED_PLATFORM -eq 1 ]] && printf 'first-run: platform agent %s: %s\n' "$PLATFORM" "$(verdict "${RC[platform]}")"
for kind in assistant platform; do
  [[ -n "${RC[$kind]:-}" ]] || continue
  if (( $(rank "${RC[$kind]}") > $(rank "$worst") )); then worst="${RC[$kind]}"; fi
done
exit "$worst"
