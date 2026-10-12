#!/usr/bin/env bash
# Tests for bin/claude-binary-check.sh.
#
#   bash packages/base/test/claude-binary-check.test.sh
#
# Feeds the check fake paths. Nothing is executed or read from disk.
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../bin/claude-binary-check.sh"

PASS=0
FAILS=0
pass() { echo "PASS  $1"; PASS=$((PASS+1)); }
fail() { echo "FAIL  $1${2:+ -- $2}"; FAILS=$((FAILS+1)); }

# A Windows path warns, names the path, gives the fix, and does not fail.
out="$(warn_if_foreign_claude /mnt/c/tools/claude.exe 2>&1)"; rc=$?
[[ "$rc" == 0 ]] && pass "windows path: returns 0 (warn only)" || fail "windows path: returns 0" "rc=$rc"
[[ "$out" == *"/mnt/c/tools/claude.exe"* ]] && pass "windows path: warning names the path" || fail "windows path: names the path" "$out"
[[ "$out" == *"PATH"* && "$out" == *"Linux"* ]] && pass "windows path: warning says how to fix" || fail "windows path: says how to fix" "$out"

# Other Windows shapes.
for p in /mnt/d/tools/claude /opt/x/claude.cmd /usr/local/bin/claude.EXE; do
  [[ -n "$(warn_if_foreign_claude "$p" 2>&1)" ]] && pass "warns for $p" || fail "warns for $p"
done

# Normal Linux paths stay silent.
for p in /usr/local/bin/claude /opt/demo/bin/claude /opt/mnt/bin/claude; do
  [[ -z "$(warn_if_foreign_claude "$p" 2>&1)" ]] && pass "silent for $p" || fail "silent for $p"
done

# With no argument it resolves from PATH; a PATH without claude is silent.
[[ -z "$(PATH=/nonexistent warn_if_foreign_claude 2>&1)" ]] && pass "absent claude: silent" || fail "absent claude: silent"

echo "$PASS passed, $FAILS failed"
[[ "$FAILS" == 0 ]]
