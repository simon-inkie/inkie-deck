#!/usr/bin/env bash
# setup.sh - one command from a fresh clone to a running Deck and two agents.
#
# Run it from a clone, after the prerequisites in INSTALL.md section 1. It
# checks everything first and writes nothing until the checks pass, then
# installs, makes the roots and the .env, builds, creates the two starter agents
# (an assistant and a platform agent, through first-run.sh), optionally stores a
# model API key, verifies both agents, starts Deck on loopback, and starts the
# agents only if both verified.
#
# Usage:
#   scripts/setup.sh [--yes] [--deck-home <dir>] [--agents-home <dir>]
#                    [--assistant <name>] [--platform <name>] [--model <id>]
#                    [--no-key | --key-stdin] [--replace-key]
#                    [--no-install] [--no-build] [--no-start]
#
#   --yes                accept the defaults for names (inkie, doctor) and
#                        directories. It never chooses a key, never replaces
#                        anything and never answers a model CLI prompt.
#   --deck-home <dir>    where Deck's four roots go when there is no .env yet
#                        (default: $HOME/deck)
#   --agents-home <dir>  where agent homes live (default: $HOME/agents)
#   --assistant <name>   the agent you talk to (default: inkie)
#   --platform <name>    the agent that changes the setup (default: doctor)
#   --model <id>         passed to first-run.sh for both agents
#   --no-key             do not store an API key (use your model CLI sign-in)
#   --key-stdin          read one API key from stdin, never from an argument
#   --replace-key        replace an existing stored key (needs a terminal or
#                        --key-stdin). A rerun never replaces one otherwise.
#   --no-install         skip pnpm install
#   --no-build           skip pnpm build
#   --no-start           do not start Deck or the agents
#
# Without a terminal on stdin, names (--yes, or both name flags) and a key
# choice (--no-key or --key-stdin) are required.
#
# The API key is optional. It is stored only as an `export ANTHROPIC_API_KEY=`
# line in each starter agent's .env.secrets (mode 0600). A key takes precedence
# over a subscription sign-in even when you are signed in, and each interactive
# agent pane asks once to approve it. Setup answers none of those prompts.
#
# Exit codes (precedence 2, 1, 3, 4, 5, 0):
#   2  usage: a flag is missing for an unattended run; nothing was done
#   1  failed: preflight, configuration, scaffold, key commit, an unresolved
#      mixed key state, Deck start or agent launch
#   3  a starter agent's persona check failed; agents not started
#   4  no usable model CLI, or verification could not run; Deck is running,
#      agents not started
#   5  agents launched, waiting on you at their own prompts (trust, key approval)
#   0  Deck running on loopback, both starters verified and launched
#
# Rerunning is safe: it repeats the checks, pnpm install and pnpm build, and
# skips everything else that is already done. It never edits an existing .env
# and never replaces an existing key.

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE_BIN="$REPO/packages/base/bin"
DECK_DIR="$REPO/packages/deck"
ENV_FILE="$DECK_DIR/.env"
CREATE="$BASE_BIN/create-agent.sh"
FIRST_RUN="$BASE_BIN/first-run.sh"
# An override for tests, in the same spirit as the other scripts' *_OVERRIDE
# seams; nothing in the documentation points at it.
BOOT="${SETUP_BOOT_AGENTS:-$BASE_BIN/boot-agents.sh}"
DECK_SESSION="deck"
NAME_RE='^[a-z0-9][a-z0-9-]*$'
KEY_RE='^[A-Za-z0-9_-]{8,256}$'

YES=0; NO_KEY=0; KEY_STDIN=0; REPLACE_KEY=0
NO_INSTALL=0; NO_BUILD=0; NO_START=0
DECK_HOME_ARG=""; AGENTS_HOME_ARG=""; ASSISTANT_ARG=""; PLATFORM_ARG=""; MODEL=""

say()  { printf '%s\n' "$*"; }
note() { printf 'setup: %s\n' "$*" >&2; }
fail() { printf 'setup: %s\n' "$*" >&2; exit 1; }
usage_error() { printf 'setup: %s\n' "$*" >&2; printf 'setup: run with --help for usage\n' >&2; exit 2; }

usage() {
  local line first=1
  while IFS= read -r line; do
    if [[ $first -eq 1 ]]; then first=0; continue; fi
    [[ "$line" == \#* ]] || break
    printf '%s\n' "${line/#\# /}" | sed 's/^#$//'
  done < "${BASH_SOURCE[0]}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)     usage; exit 0 ;;
    --yes)         YES=1; shift ;;
    --no-key)      NO_KEY=1; shift ;;
    --key-stdin)   KEY_STDIN=1; shift ;;
    --replace-key) REPLACE_KEY=1; shift ;;
    --no-install)  NO_INSTALL=1; shift ;;
    --no-build)    NO_BUILD=1; shift ;;
    --no-start)    NO_START=1; shift ;;
    --deck-home)   [[ $# -ge 2 && -n "$2" ]] || usage_error "--deck-home needs a directory";   DECK_HOME_ARG="$2";   shift 2 ;;
    --agents-home) [[ $# -ge 2 && -n "$2" ]] || usage_error "--agents-home needs a directory"; AGENTS_HOME_ARG="$2"; shift 2 ;;
    --assistant)   [[ $# -ge 2 && -n "$2" ]] || usage_error "--assistant needs a name";        ASSISTANT_ARG="$2";   shift 2 ;;
    --platform)    [[ $# -ge 2 && -n "$2" ]] || usage_error "--platform needs a name";         PLATFORM_ARG="$2";    shift 2 ;;
    --model)       [[ $# -ge 2 && -n "$2" ]] || usage_error "--model needs a value";           MODEL="$2";           shift 2 ;;
    *)             usage_error "unknown argument: $1" ;;
  esac
done

TTY=0; [[ -t 0 ]] && TTY=1

# ---------------------------------------------------------------------------
# A. preflight (writes nothing)
# ---------------------------------------------------------------------------

# Usage errors first: they win the exit-code precedence, and they are about the
# flags, not the machine.
[[ $NO_KEY -eq 0 || $KEY_STDIN -eq 0 ]] || usage_error "--no-key and --key-stdin contradict each other"
[[ $NO_KEY -eq 0 || $REPLACE_KEY -eq 0 ]] || usage_error "--replace-key and --no-key contradict each other"
if [[ $REPLACE_KEY -eq 1 && $TTY -eq 0 && $KEY_STDIN -eq 0 ]]; then
  usage_error "--replace-key needs a terminal to type the new key into, or --key-stdin"
fi
if [[ $TTY -eq 0 ]]; then
  if [[ $YES -eq 0 && ( -z "$ASSISTANT_ARG" || -z "$PLATFORM_ARG" ) ]]; then
    usage_error "no terminal: pass --yes, or both --assistant and --platform"
  fi
  if [[ $NO_KEY -eq 0 && $KEY_STDIN -eq 0 ]]; then
    usage_error "no terminal: pass --no-key, or --key-stdin to read the key from stdin"
  fi
fi

if [[ -n "$MODEL" && ! "$MODEL" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]*$ ]]; then
  usage_error "--model '$MODEL' is not a plain model id (letters, digits, dots, colons and hyphens)"
fi

[[ "$(id -u)" != 0 ]] || fail "refusing to run as root: Deck and the agents would run as root. Run it as your own user."
git -C "$REPO" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
  || fail "$REPO is not inside a git work tree. Setup needs a git clone, not a downloaded archive (INSTALL.md section 1)."

MISSING=()
need() { command -v "$1" >/dev/null 2>&1 || MISSING+=("$1"); }
need node; need rg; need python3; need tmux; need xxd; need curl; need git
if [[ $NO_INSTALL -eq 0 || $NO_BUILD -eq 0 ]]; then need pnpm; fi
if command -v python3 >/dev/null 2>&1 && ! python3 -c 'import yaml' >/dev/null 2>&1; then
  MISSING+=("python3-yaml (PyYAML, for decision cards)")
fi
if [[ ${#MISSING[@]} -gt 0 ]]; then
  note "missing tools: ${MISSING[*]}"
  fail "install them first: INSTALL.md section 1 (on Windows, the WSL prerequisites). Setup never runs sudo or apt-get."
fi

# ---------------------------------------------------------------------------
# B. resolve and validate the effective configuration (writes nothing)
# ---------------------------------------------------------------------------

# Read KEY from a dotenv-style file: last assignment wins, `export ` and one
# pair of surrounding quotes tolerated. Prints nothing if absent.
dotenv_get() {
  local file="$1" key="$2" line value="" re="^[[:space:]]*(export[[:space:]]+)?${2}[[:space:]]*=[[:space:]]*(.*)$"
  [[ -r "$file" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" =~ $re ]]; then
      value="${BASH_REMATCH[2]}"
      if [[ "$value" =~ ^\"([^\"]*)\" ]]; then value="${BASH_REMATCH[1]}"
      elif [[ "$value" =~ ^\'([^\']*)\' ]]; then value="${BASH_REMATCH[1]}"
      else
        value="${value%%#*}"
        value="${value%"${value##*[![:space:]]}"}"
      fi
    fi
  done < "$file"
  printf '%s' "$value"
}

HAVE_ENV=0
if [[ -e "$ENV_FILE" || -L "$ENV_FILE" ]]; then
  [[ -f "$ENV_FILE" && -r "$ENV_FILE" ]] || fail "$ENV_FILE exists but is not a readable file"
  HAVE_ENV=1
fi

# The launcher's precedence: process environment, else .env. Sets RV and RS.
resolve() {
  local name="$1" v
  v="${!name:-}"
  if [[ -n "$v" ]]; then RV="$v"; RS="the environment"; return; fi
  if [[ $HAVE_ENV -eq 1 ]]; then
    v="$(dotenv_get "$ENV_FILE" "$name")"
    if [[ -n "$v" ]]; then RV="$v"; RS="$ENV_FILE"; return; fi
  fi
  RV=""; RS=""
}

ENV_AGENTS_HOME="${AGENTS_HOME:-}"
DECK_HOME="${DECK_HOME_ARG:-$HOME/deck}"
AGENTS_HOME="${AGENTS_HOME_ARG:-$HOME/agents}"
[[ "$DECK_HOME" = /* ]] || fail "--deck-home must be an absolute path, got: $DECK_HOME"
[[ "$AGENTS_HOME" = /* ]] || fail "--agents-home must be an absolute path, got: $AGENTS_HOME"
DECK_HOME="${DECK_HOME%/}"; AGENTS_HOME="${AGENTS_HOME%/}"

declare -A ROOT
for pair in INBOX_ROOT:inbox ATTACHMENTS_ROOT:attachments PROJECTS_ROOT:projects DATA_ROOT:data; do
  var="${pair%%:*}"; dir="${pair##*:}"
  resolve "$var"
  if [[ -z "$RV" ]]; then
    # An existing .env is never edited, so a root it lacks is an error, not a default.
    [[ $HAVE_ENV -eq 0 ]] || fail "$var is not set in the environment or in $ENV_FILE. Setup does not edit an existing .env: add the line, or move the file aside."
    RV="$DECK_HOME/$dir"
  fi
  [[ "$RV" = /* ]] || fail "$var must be an absolute path, got: $RV (from ${RS:-the default})"
  [[ ! -e "$RV" || -d "$RV" ]] || fail "$var=$RV exists and is not a directory"
  ROOT[$var]="$RV"
done

resolve AGENTS_ROOT
if [[ -n "$RV" ]]; then
  [[ "$RV" == "$AGENTS_HOME" ]] || fail "AGENTS_ROOT is $RV (from $RS) but the agents home is $AGENTS_HOME. Deck and the scaffold would disagree; make them the same (--agents-home, or change AGENTS_ROOT)."
elif [[ $HAVE_ENV -eq 1 && "$AGENTS_HOME" != "$HOME/agents" ]]; then
  fail "AGENTS_ROOT is not set in $ENV_FILE and the agents home is not Deck's default ($HOME/agents). Add AGENTS_ROOT=$AGENTS_HOME to it."
fi
# The launcher scripts read AGENTS_HOME from the environment; a different one
# there would send boot to another folder than the scaffold.
if [[ -n "$ENV_AGENTS_HOME" && "${ENV_AGENTS_HOME%/}" != "$AGENTS_HOME" ]]; then
  fail "AGENTS_HOME is $ENV_AGENTS_HOME in the environment but the agents home is $AGENTS_HOME. Make them the same, or unset AGENTS_HOME."
fi

resolve MC_USER
if [[ -z "$RV" ]]; then
  [[ $HAVE_ENV -eq 0 ]] || fail "MC_USER is not set in the environment or in $ENV_FILE. Add MC_USER=<your name> to it (INSTALL.md, \"Who Deck thinks you are\")."
  RV="$(id -un)"; RS="your login name"
fi
[[ "$RV" =~ $NAME_RE ]] || fail "MC_USER=$RV (from $RS) is not a plain name: lowercase letters, digits and hyphens. It becomes a thread file name and the assistant's addressee. Set MC_USER."
MC_USER_VALUE="$RV"

resolve HOST
HOST_VALUE="${RV:-127.0.0.1}"
case "$HOST_VALUE" in
  127.0.0.1|localhost|::1) ;;
  *) fail "HOST=$HOST_VALUE (from ${RS}) is not loopback. Deck has no authentication, so setup will not start it on a network address. Use 127.0.0.1, or start Deck yourself (INSTALL.md, \"Reaching it from another machine\")." ;;
esac

resolve PORT
PORT_VALUE="${RV:-4242}"
[[ "$PORT_VALUE" =~ ^[0-9]+$ ]] && (( PORT_VALUE >= 1 && PORT_VALUE <= 65535 )) \
  || fail "PORT=$PORT_VALUE (from ${RS:-the default}) is not a port number"

DECK_SESSION_UP=0
tmux has-session -t "$DECK_SESSION" >/dev/null 2>&1 && DECK_SESSION_UP=1
if (: < "/dev/tcp/127.0.0.1/$PORT_VALUE") 2>/dev/null && [[ $DECK_SESSION_UP -eq 0 && $NO_START -eq 0 ]]; then
  fail "something is already listening on 127.0.0.1:$PORT_VALUE and it is not setup's own \"$DECK_SESSION\" tmux session. Stop it, or set PORT."
fi

INBOX_ROOT_VALUE="${ROOT[INBOX_ROOT]}"

# ---- starter names -----------------------------------------------------------

CREATE_COMMON=(--agents-home "$AGENTS_HOME" --inbox-root "$INBOX_ROOT_VALUE")

existing_of_kind() {
  local kind="$1" marker name
  for marker in "$AGENTS_HOME"/*/.kind; do
    [[ -f "$marker" ]] || continue
    if [[ "$(head -n1 "$marker" | tr -d '[:space:]')" == "$kind" ]]; then
      # A bare .kind proves nothing: only a whole scaffold counts as existing.
      name="$(basename "$(dirname "$marker")")"
      if [[ "$("$CREATE" --status "$name" --kind "$kind" "${CREATE_COMMON[@]}" 2>/dev/null)" == complete ]]; then
        printf '%s\n' "$name"
        return
      fi
    fi
  done
}
saved_peer() { head -n1 "$AGENTS_HOME/$1/.peer" 2>/dev/null | tr -d '[:space:]' || true; }

EXISTING_A="$(existing_of_kind assistant)"; EXISTING_P="$(existing_of_kind platform)"
A_NAME="$EXISTING_A"; P_NAME="$EXISTING_P"

ask_name() {
  local label="$1" default="$2" other="$3" reply
  while true; do
    printf '%s name [%s]: ' "$label" "$default" >&2
    read -r reply || fail "no $label name given"
    reply="${reply#"${reply%%[![:space:]]*}"}"; reply="${reply%"${reply##*[![:space:]]}"}"
    reply="${reply:-$default}"
    if [[ -n "$other" && "$reply" == "$other" ]]; then
      note "the two agents need different names"
    elif "$CREATE" --check-name "$reply" "${CREATE_COMMON[@]}" >/dev/null 2>&1; then
      printf '%s' "$reply"; return
    else
      "$CREATE" --check-name "$reply" "${CREATE_COMMON[@]}" 2>&1 >/dev/null | sed 's/^/  /' >&2 || true
    fi
  done
}

# A missing starter takes the survivor's saved peer name, as first-run.sh does.
if [[ -z "$EXISTING_A" && -n "$EXISTING_P" ]]; then
  s="$(saved_peer "$EXISTING_P")"; [[ -z "$s" ]] || A_NAME="$s"
fi
if [[ -z "$EXISTING_P" && -n "$EXISTING_A" ]]; then
  s="$(saved_peer "$EXISTING_A")"; [[ -z "$s" ]] || P_NAME="$s"
fi
if [[ -z "$EXISTING_A" && -z "$A_NAME" ]]; then
  if [[ -n "$ASSISTANT_ARG" ]]; then A_NAME="$ASSISTANT_ARG"
  elif [[ $YES -eq 1 ]]; then A_NAME="inkie"
  else A_NAME="$(ask_name assistant inkie "$PLATFORM_ARG")" || exit 1; fi
fi
if [[ -z "$EXISTING_P" && -z "$P_NAME" ]]; then
  if [[ -n "$PLATFORM_ARG" ]]; then P_NAME="$PLATFORM_ARG"
  elif [[ $YES -eq 1 ]]; then P_NAME="doctor"
  else P_NAME="$(ask_name "platform agent" doctor "$A_NAME")" || exit 1; fi
fi
[[ "$A_NAME" != "$P_NAME" ]] || fail "the two agents need different names, got \"$A_NAME\" twice. Nothing was written."
if [[ -z "$EXISTING_A" ]]; then
  "$CREATE" --check-name "$A_NAME" "${CREATE_COMMON[@]}" >/dev/null 2>&1 \
    || { "$CREATE" --check-name "$A_NAME" "${CREATE_COMMON[@]}" 2>&1 >/dev/null | sed 's/^/  /' >&2; fail "the assistant name was refused. Nothing was written."; }
fi
if [[ -z "$EXISTING_P" ]]; then
  "$CREATE" --check-name "$P_NAME" "${CREATE_COMMON[@]}" >/dev/null 2>&1 \
    || { "$CREATE" --check-name "$P_NAME" "${CREATE_COMMON[@]}" 2>&1 >/dev/null | sed 's/^/  /' >&2; fail "the platform agent name was refused. Nothing was written."; }
fi

# ---- model key state -----------------------------------------------------------

MARKER="$AGENTS_HOME/.setup-key-pending"
KEY_LINE_RE='^[[:space:]]*(export[[:space:]]+)?ANTHROPIC_API_KEY=(.*)$'

# The stored key in a file, printed to a variable by name (never to a terminal).
# Sets KEY_FOUND=1/0 and KEY_OF. An unreadable file is an error for the caller.
read_stored_key() {
  local file="$1" line
  KEY_FOUND=0; KEY_OF=""
  [[ -e "$file" ]] || return 0
  [[ -f "$file" && -r "$file" ]] || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" =~ $KEY_LINE_RE ]]; then KEY_FOUND=1; KEY_OF="${BASH_REMATCH[2]}"; fi
  done < "$file"
  return 0
}

file_mode() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1" 2>/dev/null; }
file_owner() { stat -c %u "$1" 2>/dev/null || stat -f %u "$1" 2>/dev/null; }

# A secrets file that exists must be a regular file we own that nobody else can
# write to, or setup will not read or write it.
check_secrets_file() {
  local f="$1" mode
  [[ -e "$f" || -L "$f" ]] || return 0
  [[ ! -L "$f" && -f "$f" ]] || fail "$f is a symlink or not a regular file; refusing to read or write a key through it"
  [[ "$(file_owner "$f")" == "$(id -u)" ]] || fail "$f is not owned by you; refusing to use it for a key"
  mode="$(file_mode "$f")"
  (( (8#$mode & 8#022) == 0 )) || fail "$f is writable by group or others (mode $mode); chmod 600 it, then run again"
}

# The spelling of a directory with trailing slashes, "." segments and doubled
# slashes removed (no ".." allowed: it cannot be normalised without resolving
# symlinks, and a credential path has no reason to contain one).
lexical_path() {
  local p="$1" out="" part IFS=/
  for part in $p; do
    case "$part" in
      ""|.) ;;
      ..) printf '%s' "$p"; return 1 ;;
      *) out="$out/$part" ;;
    esac
  done
  printf '%s' "${out:-/}"
}

# A directory must be what it is spelled as: no symlink anywhere in its path.
# Compared by the physical path (the shell's `pwd -P`), so a trailing "/.", a
# symlinked parent or a symlinked final component all show up.
assert_real_dir() {  # <dir that exists>
  local dir="$1" lex phys
  lex="$(lexical_path "$dir")" || fail "$dir contains a \"..\" component; give the agents home as a plain absolute path. Nothing was written."
  phys="$(cd -P -- "$dir" 2>/dev/null && pwd -P)" || fail "cannot resolve $dir"
  [[ "$lex" == "$phys" ]] || fail "$dir resolves through a symlink to $phys; refusing to store a key through it. Pass the real path with --agents-home. Nothing was written."
}

# Every part of a credential path, checked against the real filesystem. Run
# again after the lock is taken and again before the files are staged and
# renamed, because a directory can be swapped between a check and its use.
check_key_path() {  # <agent name>
  local dir="$AGENTS_HOME/$1" probe="$AGENTS_HOME"
  # The nearest directory that exists must be real; so must the home itself
  # and the agent's folder once they exist.
  while [[ ! -e "$probe" && ! -L "$probe" && "$probe" != / ]]; do probe="$(dirname "$probe")"; done
  [[ ! -L "$probe" ]] || fail "$probe is a symlink; refusing to store a key through it. Nothing was written."
  assert_real_dir "$probe"
  if [[ -e "$dir" || -L "$dir" ]]; then
    [[ ! -L "$dir" ]] || fail "$dir is a symlink; refusing to store a key through it"
    assert_real_dir "$dir"
  fi
  [[ ! -L "$dir/.env.secrets" ]] || fail "$dir/.env.secrets is a symlink; refusing to store a key through it"
}

# Credentials must not land in a checkout. Git is asked with its discovery
# limits removed (a ceiling variable could hide the repository); "not a git
# repository" is the only answer that counts as safe, and any other failure
# refuses.
assert_outside_git() {
  local probe="$AGENTS_HOME" out rc
  while [[ ! -d "$probe" && "$probe" != / ]]; do probe="$(dirname "$probe")"; done
  out="$(env -u GIT_CEILING_DIRECTORIES -u GIT_DIR -u GIT_WORK_TREE GIT_DISCOVERY_ACROSS_FILESYSTEM=1 \
    git -C "$probe" rev-parse --show-toplevel 2>&1)"; rc=$?
  if [[ $rc -eq 0 ]]; then
    fail "$AGENTS_HOME is inside the git work tree at $out, and a stored API key could end up committed. Choose an --agents-home outside any repository. Nothing was written."
  fi
  [[ "$out" == *"not a git repository"* ]] \
    || fail "could not tell whether $AGENTS_HOME is inside a git work tree (git said: $out). Refusing to store a key. Nothing was written."
}

LOCK="$AGENTS_HOME/.setup-key-lock"
LOCK_HELD=0
release_lock() { [[ $LOCK_HELD -eq 0 ]] || { rmdir -- "$LOCK" 2>/dev/null; LOCK_HELD=0; }; }
trap release_lock EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
lock_message() {
  printf '%s\n' "another setup run is writing the key files, or one was killed while it did: the lock directory $LOCK exists." \
    "If setup is still running in another terminal, wait for it. If nothing is running, it is a stale lock: check that no setup process is active, then remove it with: rmdir '$LOCK'" \
    "Leave $MARKER in place if it exists: the next run reconciles it. Nothing was written."
}
[[ ! -e "$LOCK" ]] || { lock_message >&2; exit 1; }

CLEAR_MARKER=0; MIXED_MARKER=0
MARKER_A=""; MARKER_P=""

# Read the pending marker and the two key states it names, and decide: nothing
# pending, resolved (the same key in both, or none), or mixed. Called before any
# write and again under the lock, so a decision is never made on a stale read.
reconcile_marker() {
  local mf_a mf_p ka kp ka_found kp_found
  CLEAR_MARKER=0; MIXED_MARKER=0; MARKER_A=""; MARKER_P=""
  [[ -e "$MARKER" || -L "$MARKER" ]] || return 0
  [[ -f "$MARKER" && ! -L "$MARKER" && -r "$MARKER" ]] || fail "mixed key state: $MARKER is unreadable. Resolve it by hand, then run again."
  { IFS= read -r MARKER_A; IFS= read -r MARKER_P; } < "$MARKER"
  [[ "$MARKER_A" =~ $NAME_RE && "$MARKER_P" =~ $NAME_RE ]] \
    || fail "mixed key state: $MARKER does not name two agents. Resolve it by hand, then run again."
  [[ "$MARKER_A" != "$MARKER_P" ]] \
    || fail "mixed key state: $MARKER names the same agent twice. Resolve it by hand, then run again."
  mf_a="$AGENTS_HOME/$MARKER_A/.env.secrets"; mf_p="$AGENTS_HOME/$MARKER_P/.env.secrets"
  check_key_path "$MARKER_A"; check_key_path "$MARKER_P"
  check_secrets_file "$mf_a"; check_secrets_file "$mf_p"
  read_stored_key "$mf_a" || fail "mixed key state: $mf_a is unreadable. Resolve it by hand, then run again."
  ka_found=$KEY_FOUND; ka="$KEY_OF"
  read_stored_key "$mf_p" || fail "mixed key state: $mf_p is unreadable. Resolve it by hand, then run again."
  kp_found=$KEY_FOUND; kp="$KEY_OF"
  if [[ $ka_found -eq $kp_found && "$ka" == "$kp" ]]; then
    CLEAR_MARKER=1
  elif [[ $REPLACE_KEY -eq 1 ]]; then
    # Replacement is bound to the marker's own two distinct agents.
    [[ "$MARKER_A" == "$A_NAME" && "$MARKER_P" == "$P_NAME" ]] \
      || fail "mixed key state belongs to $MARKER_A and $MARKER_P, but this run selects $A_NAME and $P_NAME. Repair the pair named in $MARKER: run setup again with --assistant $MARKER_A --platform $MARKER_P --replace-key. Nothing was written."
    MIXED_MARKER=1
    note "mixed key state in $MARKER_A and $MARKER_P: --replace-key was given, so the new key will replace both."
  else
    fail "mixed key state: the key in $MARKER_A and $MARKER_P differs, so a key write was interrupted. Nothing was verified or launched. Run again with --replace-key and enter the key again."
  fi
}
reconcile_marker

HAVE_KEY=0
for n in "$EXISTING_A" "$EXISTING_P"; do
  [[ -n "$n" ]] || continue
  f="$AGENTS_HOME/$n/.env.secrets"
  check_key_path "$n"
  check_secrets_file "$f"
  read_stored_key "$f" || fail "$f is unreadable"
  [[ $KEY_FOUND -eq 0 ]] || HAVE_KEY=1
done
KEY_OF=""

KEY_VALUE=""; WRITE_KEY=0
read_key_line() {
  # One line, from the terminal without echo or from stdin.
  if [[ $TTY -eq 1 ]]; then
    printf '%s' "$1" >&2
    IFS= read -rs KEY_VALUE || KEY_VALUE=""
    printf '\n' >&2
  else
    IFS= read -r KEY_VALUE || KEY_VALUE=""
  fi
  KEY_VALUE="${KEY_VALUE%$'\r'}"
}
if [[ $NO_KEY -eq 1 ]]; then
  :
elif [[ $HAVE_KEY -eq 1 && $REPLACE_KEY -eq 0 ]]; then
  note "an API key is already stored for the starter agents; keeping it (--replace-key changes it)."
elif [[ $KEY_STDIN -eq 1 ]]; then
  read_key_line "API key: "
  [[ -n "$KEY_VALUE" ]] || fail "--key-stdin: no key was read from stdin"
  WRITE_KEY=1
elif [[ $TTY -eq 1 && ( $YES -eq 0 || $REPLACE_KEY -eq 1 ) ]]; then
  if [[ $REPLACE_KEY -eq 1 ]]; then
    read_key_line "New Anthropic API key (hidden): "
    [[ -n "$KEY_VALUE" ]] || fail "no key entered"
    WRITE_KEY=1
  else
    printf 'Use an Anthropic API key instead of your Claude sign-in? [y/N] ' >&2
    reply=""; read -r reply || reply=""
    if [[ "$reply" =~ ^[Yy] ]]; then
      read_key_line "Anthropic API key (hidden): "
      [[ -n "$KEY_VALUE" ]] || fail "no key entered"
      WRITE_KEY=1
    fi
  fi
else
  note "no API key will be stored (--yes never chooses one); agents use your model CLI sign-in."
fi
if [[ $REPLACE_KEY -eq 1 && $WRITE_KEY -eq 0 ]]; then
  usage_error "--replace-key needs a new key: type it at the prompt, or pass --key-stdin"
fi
if [[ $MIXED_MARKER -eq 1 && $WRITE_KEY -eq 0 ]]; then
  fail "mixed key state is unresolved and no new key was given. Nothing was verified or launched."
fi
if [[ $WRITE_KEY -eq 1 ]]; then
  assert_outside_git
  [[ "$KEY_VALUE" =~ $KEY_RE ]] || { KEY_VALUE=""; fail "the API key is not valid: letters, digits, hyphens and underscores only, 8 to 256 characters. Nothing was written."; }
  note "a stored ANTHROPIC_API_KEY takes precedence over a subscription sign-in even when you are signed in, and each agent pane asks once to approve it. Setup answers none of those prompts."
fi

# ---------------------------------------------------------------------------
# C. write
# ---------------------------------------------------------------------------

export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# Install and build are noisy (update boxes, ignored-build-script lists,
# framework warnings), so their output goes to a log under the deck home and
# setup shows one status line. A failure prints the tail of the log, and the
# exit status is still the command's own: nothing is hidden, only moved.
LOG_DIR="$DECK_HOME/logs"
run_logged() {  # <label> <log name> <command...>
  local label="$1" log="$LOG_DIR/$2" rc
  shift 2
  mkdir -p "$LOG_DIR" 2>/dev/null || { "$@"; return $?; }
  say "setup: $label (log: $log)"
  (cd "$REPO" && "$@") > "$log" 2>&1
  rc=$?
  if [[ $rc -ne 0 ]]; then
    printf 'setup: %s failed (exit %s). Last lines of %s:\n' "$label" "$rc" "$log" >&2
    tail -n 30 "$log" >&2
  fi
  return $rc
}

if [[ $NO_INSTALL -eq 0 ]]; then
  run_logged "pnpm install" setup-install.log pnpm install || fail "pnpm install failed; see $LOG_DIR/setup-install.log"
fi

for var in INBOX_ROOT ATTACHMENTS_ROOT PROJECTS_ROOT DATA_ROOT; do
  mkdir -p "${ROOT[$var]}" || fail "could not create ${ROOT[$var]}"
done
mkdir -p "$AGENTS_HOME" || fail "could not create $AGENTS_HOME"

if [[ $HAVE_ENV -eq 0 ]]; then
  {
    printf 'INBOX_ROOT=%s\n' "${ROOT[INBOX_ROOT]}"
    printf 'ATTACHMENTS_ROOT=%s\n' "${ROOT[ATTACHMENTS_ROOT]}"
    printf 'PROJECTS_ROOT=%s\n' "${ROOT[PROJECTS_ROOT]}"
    printf 'DATA_ROOT=%s\n' "${ROOT[DATA_ROOT]}"
    printf 'AGENTS_ROOT=%s\n' "$AGENTS_HOME"
    printf 'MC_USER=%s\n' "$MC_USER_VALUE"
  } > "$ENV_FILE" || fail "could not write $ENV_FILE"
  say "setup: wrote $ENV_FILE"
else
  say "setup: keeping the existing $ENV_FILE"
fi

if [[ $NO_BUILD -eq 0 ]]; then
  run_logged "pnpm build" setup-build.log pnpm build || fail "pnpm build failed; see $LOG_DIR/setup-build.log"
fi

# The effective settings go to every child explicitly, so Deck, the scaffold,
# boot and the inbox CLI cannot disagree. The key is not among them.
child_env=(AGENTS_HOME="$AGENTS_HOME" AGENTS_ROOT="$AGENTS_HOME" INBOX_ROOT="$INBOX_ROOT_VALUE" MC_USER="$MC_USER_VALUE")

FR_ARGS=(--agents-home "$AGENTS_HOME" --inbox-root "$INBOX_ROOT_VALUE" --person "$MC_USER_VALUE" --no-verify)
[[ -z "$EXISTING_A" ]] && FR_ARGS+=(--assistant "$A_NAME")
[[ -z "$EXISTING_P" ]] && FR_ARGS+=(--platform "$P_NAME")
[[ -n "$MODEL" ]] && FR_ARGS+=(--model "$MODEL")
env "${child_env[@]}" "$FIRST_RUN" "${FR_ARGS[@]}" < /dev/null
fr=$?
# --no-verify returning 4 (created, unverified) or 0 (nothing to do) is success.
case "$fr" in 0|4) ;; *) fail "first-run.sh failed (exit $fr); the agents were not all created" ;; esac

A_NAME="$(existing_of_kind assistant)"; P_NAME="$(existing_of_kind platform)"
[[ -n "$A_NAME" && -n "$P_NAME" ]] || fail "after first-run.sh, the assistant and the platform agent are not both complete in $AGENTS_HOME"

clean_key_scratch() {
  local d
  for d in "$AGENTS_HOME/$1" "$AGENTS_HOME/$2"; do
    rm -f -- "$d"/.setup-key-stage.* "$d"/.setup-key-bak.* 2>/dev/null
  done
}

if [[ $CLEAR_MARKER -eq 1 || $WRITE_KEY -eq 1 ]]; then
  mkdir -- "$LOCK" 2>/dev/null || fail "another setup run holds $LOCK. Wait for it, then run again."
  LOCK_HELD=1
fi

if [[ $LOCK_HELD -eq 1 ]]; then
  # Decisions made before the lock may be stale: another run can have finished
  # a key write, or left a marker, since. Read the state again, now that nobody
  # else can change it, and only then decide to write or to clear.
  check_key_path "$A_NAME"; check_key_path "$P_NAME"
  reconcile_marker
  if [[ $WRITE_KEY -eq 1 && $REPLACE_KEY -eq 0 ]]; then
    for n in "$A_NAME" "$P_NAME"; do
      read_stored_key "$AGENTS_HOME/$n/.env.secrets" || fail "$AGENTS_HOME/$n/.env.secrets is unreadable"
      if [[ $KEY_FOUND -eq 1 ]]; then
        note "a key was stored by another run in the meantime; keeping it (--replace-key changes it)."
        WRITE_KEY=0; KEY_VALUE=""
        break
      fi
    done
  fi
  if [[ $MIXED_MARKER -eq 1 && $WRITE_KEY -eq 0 ]]; then
    fail "mixed key state is unresolved and no new key was given. Nothing was verified or launched."
  fi
  [[ $WRITE_KEY -eq 0 ]] || assert_outside_git
fi

if [[ $CLEAR_MARKER -eq 1 ]]; then
  clean_key_scratch "$MARKER_A" "$MARKER_P"
  rm -f -- "$MARKER" || fail "could not remove $MARKER"
  say "setup: the earlier key write had finished; cleared its marker"
fi

# Key commit. Two renames cannot be atomic together, so: write a marker naming
# the pair, stage private (0600) copies, rename both, remove the marker. If the
# second rename fails the first file is restored from its backup. If that fails,
# or the run is interrupted, the marker stays and the next run stops until the
# pair is reconciled.
commit_key() {
  local d1="$AGENTS_HOME/$A_NAME" d2="$AGENTS_HOME/$P_NAME" f1 f2 st1 st2 bk1="" bk2=""
  f1="$d1/.env.secrets"; f2="$d2/.env.secrets"
  # Checked again here, immediately before anything is staged.
  check_key_path "$A_NAME"; check_key_path "$P_NAME"; assert_outside_git
  clean_key_scratch "$A_NAME" "$P_NAME"
  (umask 077; printf '%s\n%s\n' "$A_NAME" "$P_NAME" > "$MARKER") || fail "could not write $MARKER"

  stage_one() {  # <dir> <file> -> sets STAGED, BACKUP
    local dir="$1" file="$2" line
    STAGED="$(umask 077; mktemp "$dir/.setup-key-stage.XXXXXX")" || return 1
    BACKUP=""
    if [[ -e "$file" ]]; then
      BACKUP="$(umask 077; mktemp "$dir/.setup-key-bak.XXXXXX")" || return 1
      cat -- "$file" > "$BACKUP" || return 1
    fi
    {
      if [[ -e "$file" ]]; then
        while IFS= read -r line || [[ -n "$line" ]]; do
          [[ "$line" =~ $KEY_LINE_RE ]] || printf '%s\n' "$line"
        done < "$file"
      fi
      printf 'export ANTHROPIC_API_KEY=%s\n' "$KEY_VALUE"
    } > "$STAGED" || return 1
  }
  abandon() {  # nothing was renamed: drop the scratch and the marker
    clean_key_scratch "$A_NAME" "$P_NAME"
    rm -f -- "$MARKER"
    fail "$1 Neither starter's key file was changed."
  }

  stage_one "$d1" "$f1" || abandon "could not stage the key file for $A_NAME."
  st1="$STAGED"; bk1="$BACKUP"
  stage_one "$d2" "$f2" || abandon "could not stage the key file for $P_NAME."
  st2="$STAGED"; bk2="$BACKUP"

  ( check_key_path "$A_NAME"; check_key_path "$P_NAME" ) >/dev/null 2>&1 || abandon "the path to a key file changed under setup."
  mv -f -- "$st1" "$f1" 2>/dev/null || abandon "could not write the key file for $A_NAME."
  if ! mv -f -- "$st2" "$f2" 2>/dev/null; then
    local restored=1
    if [[ -n "$bk1" ]]; then mv -f -- "$bk1" "$f1" 2>/dev/null || restored=0; else rm -f -- "$f1" || restored=0; fi
    if [[ $restored -eq 1 ]]; then
      clean_key_scratch "$A_NAME" "$P_NAME"
      rm -f -- "$MARKER"
      fail "could not write the key file for $P_NAME; $A_NAME's was put back. Neither starter's key file was changed."
    fi
    note "mixed key state: $A_NAME has the new key, $P_NAME does not, and $A_NAME's file could not be put back."
    fail "marker kept at $MARKER; nothing will be verified or launched until you run setup again with --replace-key and enter the key again."
  fi
  clean_key_scratch "$A_NAME" "$P_NAME"
  rm -f -- "$MARKER" || fail "the key was written but $MARKER could not be removed"
  say "setup: stored the API key for $A_NAME and $P_NAME (mode 0600, each .env.secrets)"
}

if [[ $WRITE_KEY -eq 1 ]]; then
  check_key_path "$A_NAME"; check_key_path "$P_NAME"
  check_secrets_file "$AGENTS_HOME/$A_NAME/.env.secrets"
  check_secrets_file "$AGENTS_HOME/$P_NAME/.env.secrets"
  commit_key
  KEY_VALUE=""
fi
unset KEY_VALUE
release_lock

# A marker still present here means the pair is unresolved: never verify or launch.
[[ ! -e "$MARKER" ]] || fail "mixed key state: $MARKER is still present. Nothing was verified or launched."

# Verify both starters (never reached while a key marker is pending: B stopped).
verify_one() {
  env "${child_env[@]}" "$CREATE" --verify-only "$1" "${CREATE_COMMON[@]}" < /dev/null
}
# With no agent CLI on PATH there is nothing to ask: say so once, plainly, at
# the end, instead of two near-identical CANNOT VERIFY reports.
NO_CLI=0
if ! command -v claude >/dev/null 2>&1; then
  NO_CLI=1; va=4; vp=4
else
  verify_one "$A_NAME"; va=$?
  verify_one "$P_NAME"; vp=$?
fi
VCODE=0
for v in "$va" "$vp"; do
  case "$v" in
    0) ;;
    3) [[ $VCODE -eq 1 ]] || VCODE=3 ;;
    4) [[ $VCODE -eq 1 || $VCODE -eq 3 ]] || VCODE=4 ;;
    *) VCODE=1 ;;
  esac
done
if [[ $VCODE -eq 1 ]]; then
  fail "could not verify the starter agents (assistant exit $va, platform exit $vp)"
fi

# ---------------------------------------------------------------------------
# D. start
# ---------------------------------------------------------------------------

URL="http://127.0.0.1:$PORT_VALUE/"
DECK_RUNNING=0
if [[ $NO_START -eq 1 ]]; then
  say "setup: --no-start given; Deck and the agents were not started"
else
  if [[ $DECK_SESSION_UP -eq 1 ]]; then
    curl -fsS -o /dev/null --max-time 5 "$URL" 2>/dev/null \
      || fail "the \"$DECK_SESSION\" tmux session exists but nothing answers at $URL. Look at it (tmux attach -t $DECK_SESSION) or stop it (tmux kill-session -t $DECK_SESSION), then run setup again."
    say "setup: Deck is already running in the \"$DECK_SESSION\" tmux session"
  else
    deck_cmd="$(printf 'env HOST=127.0.0.1 PORT=%q INBOX_ROOT=%q ATTACHMENTS_ROOT=%q PROJECTS_ROOT=%q DATA_ROOT=%q AGENTS_ROOT=%q MC_USER=%q node scripts/start-production.mjs' \
      "$PORT_VALUE" "${ROOT[INBOX_ROOT]}" "${ROOT[ATTACHMENTS_ROOT]}" "${ROOT[PROJECTS_ROOT]}" "${ROOT[DATA_ROOT]}" "$AGENTS_HOME" "$MC_USER_VALUE")"
    tmux new-session -d -s "$DECK_SESSION" -c "$DECK_DIR" "$deck_cmd" || fail "could not start the \"$DECK_SESSION\" tmux session"
    tmux set-option -t "$DECK_SESSION" remain-on-exit on >/dev/null 2>&1 || true
    ready=0; waited=0; limit="${SETUP_DECK_WAIT:-60}"
    while (( waited < limit )); do
      if tmux capture-pane -p -t "$DECK_SESSION" 2>/dev/null | grep -qF "app on http://127.0.0.1:$PORT_VALUE" \
         && curl -fsS -o /dev/null --max-time 3 "$URL" 2>/dev/null; then ready=1; break; fi
      sleep 1; waited=$((waited + 1))
    done
    if [[ $ready -ne 1 ]]; then
      note "Deck did not come up within ${limit}s. Its output:"
      tmux capture-pane -p -t "$DECK_SESSION" 2>/dev/null | grep -v '^$' | tail -12 >&2
      fail "Deck did not start. Fix the cause, then run setup again (stop the session first: tmux kill-session -t $DECK_SESSION)."
    fi
    say "setup: Deck is running at $URL"
  fi
  DECK_RUNNING=1
fi

FINAL=$VCODE
if [[ $DECK_RUNNING -eq 1 && $VCODE -eq 0 ]]; then
  # Exactly the two starters, by name: with no names the launcher starts every
  # agent in the folder.
  BOOT_OUT="$(env "${child_env[@]}" "$BOOT" "$A_NAME" "$P_NAME" 2>&1)"
  br=$?
  printf '%s\n' "$BOOT_OUT"
  case "$br" in
    0) FINAL=0 ;;
    3)
      # Pending means "waiting on you" only when every waiting agent is at a
      # dialog a person has to answer; a runtime that is not running is a failure.
      if [[ "$BOOT_OUT" =~ waiting-detail:\ prompts=([0-9]+)\ other=([0-9]+) ]] \
         && (( BASH_REMATCH[1] > 0 && BASH_REMATCH[2] == 0 )); then FINAL=5; else FINAL=1; fi ;;
    *) FINAL=1 ;;
  esac
fi

# ---------------------------------------------------------------------------
# E. report
# ---------------------------------------------------------------------------

no_cli_help() {
  say ""
  say "No agent CLI was found on PATH, so the agents could not be checked or started."
  say "A supported agent CLI must be installed and signed in. Quick setup supports:"
  say "  Claude Code   https://github.com/anthropics/claude-code"
  say "Codex (https://github.com/openai/codex) and Antigravity (https://antigravity.google/docs/install?tab=cli)"
  say "can be booted and messaged by the base once an agent is set up for them by hand,"
  say "but Quick setup does not scaffold or verify them: not yet."
  say "Install Claude Code, sign in by running claude once, then run setup again."
  say "Once the agents start, $A_NAME opens in its Deck thread by asking what you do,"
  say "and is then expected to propose up to three more agents on a card for you to approve."
}

say ""
if [[ $NO_START -eq 1 ]]; then
  case "$FINAL" in
    0) say "Both agents verified. Deck and the agents were not started (--no-start): run setup again without it." ;;
    4) say "Both agents exist but could not be verified. Deck and the agents were not started (--no-start)."
       [[ $NO_CLI -eq 0 ]] && say "Install and sign in to the model CLI, then run setup again." || no_cli_help ;;
    3) say "A starter agent failed its persona check. Deck and the agents were not started (--no-start). See the output above." ;;
  esac
else
  case "$FINAL" in
    0) say "Setup is done. Deck is running at $URL and $A_NAME and $P_NAME are started and ready." ;;
    5) say "Deck is running at $URL. $A_NAME and $P_NAME are started and waiting on you at their own prompts (folder trust, and key approval if you stored a key). Answer them in Deck's terminal view for each agent; setup answered none. Run setup again afterwards to check." ;;
    4) say "Deck is running at $URL. Your agents exist but were not started."
       [[ $NO_CLI -eq 0 ]] && say "Install and sign in to the model CLI, then run setup again." || no_cli_help ;;
    3) say "Deck is running at $URL. A starter agent failed its persona check, so the agents were not started. See the output above, then run setup again." ;;
    1) say "Setup failed while starting the agents. Deck is running at $URL. See the output above, then run setup again." ;;
  esac
fi
exit "$FINAL"
