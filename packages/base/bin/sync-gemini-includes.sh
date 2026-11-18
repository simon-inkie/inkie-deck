#!/usr/bin/env bash
# sync-gemini-includes.sh - inline persona and shared files into an
# Antigravity (agy) agent's GEMINI.md.
#
# A Claude Code agent gets its persona files every turn because its CLAUDE.md
# @-imports them and Claude Code resolves the imports. Antigravity re-reads
# GEMINI.md every turn but has no include mechanism, so the files have to be
# physically copied into it. This script keeps the copies in step with their
# sources, so they never drift.
#
# How it works. It scans the target GEMINI.md for fenced regions of the form
#
#     <!-- BEGIN SYNCED:<source-path> (anything, usually a note) -->
#     ...generated content...
#     <!-- END SYNCED:<source-path> -->
#
# and replaces everything between each BEGIN and END marker with the current
# content of <source-path>. The source path lives in the marker itself, so the
# script has no file list of its own. A path is read up to the first space;
# a leading ~/ means $HOME, an absolute path is used as it is, and anything
# else is relative to the directory of the GEMINI.md being synced (so the
# persona template's fences, IDENTITY.md and so on, need no editing per agent).
#
# Idempotent: with unchanged sources a second run produces a byte-identical
# file. A source whose last line has no newline gets one added in the copy,
# because the END marker must start a line of its own or the next run would
# read it as part of the generated body.
#
# Safe on error: a missing or unreadable source, or a BEGIN with no END,
# leaves the target exactly as it was and exits non-zero.
#
# Usage:
#   sync-gemini-includes.sh [GEMINI.md ...]
#     With paths: sync each named file.
#     With none: sync every $AGENTS_HOME/*/GEMINI.md whose .runtime says agy.
#
# Exit status: 0 on success, 1 if any target or referenced source is missing,
# unreadable or malformed.

set -uo pipefail

AGENTS_HOME="${AGENTS_HOME:-$HOME/agents}"

# resolve_source <raw path> <directory of the target>
resolve_source() {
  local p="$1" base="$2"
  case "$p" in
    "~") printf '%s' "$HOME" ;;
    "~/"*) printf '%s/%s' "$HOME" "${p#\~/}" ;;
    /*) printf '%s' "$p" ;;
    *) printf '%s/%s' "$base" "$p" ;;
  esac
}

# Regenerate every SYNCED region in one GEMINI.md, in place.
sync_one() {
  local target="$1" status=0
  if [[ ! -f "$target" ]]; then
    printf 'sync-gemini-includes: target not found: %s\n' "$target" >&2
    return 1
  fi
  local base
  base="$(cd "$(dirname "$target")" && pwd)"

  local tmp
  tmp="$(mktemp "${target}.sync.XXXXXX")" || {
    printf 'sync-gemini-includes: could not create a temporary file beside %s\n' "$target" >&2
    return 1
  }

  local regions=0 in_region=0 line after raw_src src
  # Outside a region: copy each line. On a BEGIN marker: copy it, splice in the
  # source, and drop the old body up to the matching END marker, which is
  # copied in turn.
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$in_region" -eq 0 ]]; then
      printf '%s\n' "$line" >>"$tmp"
      if [[ "$line" == *"<!-- BEGIN SYNCED:"* ]]; then
        after="${line#*<!-- BEGIN SYNCED:}"
        raw_src="${after%% *}"
        src="$(resolve_source "$raw_src" "$base")"
        regions=$((regions + 1))
        in_region=1
        if [[ ! -f "$src" || ! -r "$src" ]]; then
          printf 'sync-gemini-includes: synced source not found or unreadable: %s (named in %s)\n' "$src" "$target" >&2
          status=1
        else
          cat "$src" >>"$tmp" || status=1
          # The END marker must start its own line; see the header.
          if [[ -s "$src" && -n "$(tail -c 1 "$src")" ]]; then printf '\n' >>"$tmp"; fi
        fi
      fi
    elif [[ "$line" == *"<!-- END SYNCED:"* ]]; then
      printf '%s\n' "$line" >>"$tmp"
      in_region=0
    fi
  done <"$target"

  if [[ "$in_region" -ne 0 ]]; then
    printf 'sync-gemini-includes: a BEGIN SYNCED fence has no END marker in %s\n' "$target" >&2
    status=1
  fi
  if [[ "$status" -ne 0 ]]; then
    rm -f "$tmp"
    return "$status"
  fi

  # Keep the original's permissions (GNU chmod; elsewhere the default stands).
  chmod --reference="$target" "$tmp" 2>/dev/null || true
  if cmp -s "$tmp" "$target"; then
    rm -f "$tmp"
  elif ! mv -f "$tmp" "$target"; then
    printf 'sync-gemini-includes: could not write %s\n' "$target" >&2
    rm -f "$tmp"
    return 1
  fi
  printf 'synced %s region(s) in %s\n' "$regions" "$target"
  return 0
}

discover_agy_geminis() {
  local d runtime
  for d in "$AGENTS_HOME"/*/; do
    [[ -f "${d}.runtime" && -f "${d}GEMINI.md" ]] || continue
    runtime="$(tr -d '[:space:]' < "${d}.runtime" 2>/dev/null)"
    [[ "$runtime" == agy ]] && printf '%s\n' "${d}GEMINI.md"
  done
}

main() {
  local -a targets=()
  local g t overall=0
  if [[ "$#" -gt 0 ]]; then
    targets=("$@")
  else
    while IFS= read -r g; do
      [[ -n "$g" ]] && targets+=("$g")
    done < <(discover_agy_geminis)
  fi
  if [[ "${#targets[@]}" -eq 0 ]]; then
    printf 'sync-gemini-includes: no GEMINI.md to sync (no arguments, and no agent under %s with .runtime agy)\n' "$AGENTS_HOME" >&2
    return 1
  fi
  for t in "${targets[@]}"; do
    sync_one "$t" || overall=1
  done
  return "$overall"
}

main "$@"
