# claude-binary-check.sh - warn when `claude` resolves to a Windows binary.
# Sourced, not run. Defines functions only; sourcing has no side effects.
#
# On WSL, PATH usually includes Windows directories, so `command -v claude` can
# resolve to claude.exe or claude.cmd under /mnt/c/... instead of the Linux
# install. That binary starts in a Windows process with Windows paths, so the
# agent's home, CLAUDE.md imports and session files are not where it looks, and
# the failure shows up later as a pane that does nothing useful.
#
# WARN, DO NOT STOP. A Windows claude can still run through WSL interop, and
# the path alone does not prove it is broken. Refusing to launch would lock out
# a setup that works, so this prints a warning to stderr and returns 0 either
# way. The launchers carry on.
#
# BEST-EFFORT. The check resolves `claude` in the calling script's shell, but
# the launchers start it in a tmux pane shell via send-keys, whose PATH can
# differ (rc files, .env.secrets). The warning can therefore be wrong in either
# direction. Symlinks are not followed, so a link into /mnt/ stays silent.
# Launchers call it once per run, not per agent.

# claude_binary_is_foreign <path>: success if the path looks like a Windows
# binary reached from WSL (under /mnt/, or ending in .exe or .cmd).
claude_binary_is_foreign() {
  case "${1:-}" in
    /mnt/*|*.exe|*.EXE|*.cmd|*.CMD) return 0 ;;
    *) return 1 ;;
  esac
}

# warn_if_foreign_claude [path]: with no argument, resolves `claude` on PATH.
# Prints nothing when it is absent or looks like a normal Linux install.
warn_if_foreign_claude() {
  local resolved="${1:-}"
  [[ -n "$resolved" ]] || resolved="$(command -v claude 2>/dev/null)" || return 0
  claude_binary_is_foreign "$resolved" || return 0
  {
    printf 'WARNING: `claude` resolves to %s\n' "$resolved"
    printf '  That looks like a Windows binary reached through WSL. Agents may fail to\n'
    printf '  start, or start against the wrong paths, with no clear error.\n'
    printf '  Fix: install the Linux build inside WSL, or put its directory earlier in\n'
    printf '  PATH than the Windows one (check with: command -v claude).\n'
  } >&2
  return 0
}
