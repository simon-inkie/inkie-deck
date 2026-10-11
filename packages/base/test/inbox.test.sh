#!/usr/bin/env bash
# inbox.test.sh -- tmpdir-isolated test harness for ../bin/inbox
#
# Each test runs inside a fresh tmpdir used as INBOX_ROOT, so no real inbox is
# touched. The harness sets INBOX_ROOT itself per case; nothing needs to be
# exported before running it.
#
# Usage: bash packages/base/test/inbox.test.sh
# Exit:  0 if all pass, 1 if any fail

set -uo pipefail

BIN_DIR="$(cd "$(dirname "$0")/../bin" && pwd)"
INBOX="$BIN_DIR/inbox"

# The pure-function cases import `inbox` as a module, which would otherwise
# drop a __pycache__ directory into bin/ and leave the working tree dirty.
export PYTHONDONTWRITEBYTECODE=1
PASS=0
FAIL=0

# U+2014 / U+2013 are built at runtime from their UTF-8 bytes rather than
# written literally. The em-dash is protocol SYNTAX in this format (a header
# field separator), and a literal one in source is both a parsing hazard and
# denied repo-wide. $EM/$EN hold the REAL characters at runtime, so every case
# below still exercises the genuine separators.
EM=$(printf '\xe2\x80\x94')
EN=$(printf '\xe2\x80\x93')

ok() {
  local label="$1"
  echo "PASS: $label"
  PASS=$((PASS+1))
}

fail() {
  local label="$1" reason="${2:-}"
  echo "FAIL: $label${reason:+ -- $reason}"
  FAIL=$((FAIL+1))
}

# Run inbox with an isolated INBOX_ROOT and AGENT_NAME.
# Usage: run_inbox <root> <agent_name> <args...>
run_inbox() {
  local root="$1" agent="$2"
  shift 2
  INBOX_ROOT="$root" AGENT_NAME="$agent" python3 "$INBOX" "$@"
}

# Create the inbox dir for an agent under root.
make_inbox() {
  local root="$1" agent="$2"
  mkdir -p "$root/$agent/inbox"
}

# Write a thread file. Args: root, agent, correspondent, content.
write_thread() {
  local root="$1" agent="$2" corr="$3" content="$4"
  local path="$root/$agent/inbox/${corr}.md"
  printf '%s' "$content" > "$path"
  echo "$path"
}

# ---------------------------------------------------------------------------
# Case 1: read shows only unread, ignores own + already-read blocks
# ---------------------------------------------------------------------------
{
  T=$(mktemp -d)
  make_inbox "$T" "alpha"

  # own sent block (must be ignored)
  # already-read block from beta (must be ignored)
  # unread block from beta (must be shown)
  write_thread "$T" "alpha" "beta" "## 2026-01-01T10:00:00Z - from: alpha - status: sent - subject: my own msg

I sent this.

## 2026-01-01T10:01:00Z - from: beta - status: read - subject: already read

This was already read.

## 2026-01-01T10:02:00Z - from: beta - status: sent - subject: new message

Hello from beta." > /dev/null

  OUT=$(run_inbox "$T" "alpha" read beta 2>&1)

  if echo "$OUT" | grep -q "my own msg"; then
    fail "Case 1: own block should not appear" "got: $OUT"
  elif echo "$OUT" | grep -q "already read"; then
    fail "Case 1: read block should not appear" "got: $OUT"
  elif echo "$OUT" | grep -q "new message"; then
    ok "Case 1: read shows only unread, ignores own + already-read blocks"
  else
    fail "Case 1: unread block missing from output" "got: $OUT"
  fi
  rm -rf "$T"
}

# ---------------------------------------------------------------------------
# Case 2: read flips shown blocks sent->read
# ---------------------------------------------------------------------------
{
  T=$(mktemp -d)
  make_inbox "$T" "alpha"

  TPATH=$(write_thread "$T" "alpha" "beta" "## 2026-01-01T11:00:00Z - from: beta - status: sent - subject: flip me

Body text here.")

  run_inbox "$T" "alpha" read beta > /dev/null 2>&1

  FILE_CONTENT=$(cat "$TPATH")
  if echo "$FILE_CONTENT" | grep -q "status: read"; then
    ok "Case 2: read flips shown blocks sent->read"
  else
    fail "Case 2: block not flipped to read" "file: $FILE_CONTENT"
  fi
  rm -rf "$T"
}

# ---------------------------------------------------------------------------
# Case 3: mixed-delimiter fixture (em/en/hyphen) all parse + flip
# ---------------------------------------------------------------------------
{
  T=$(mktemp -d)
  make_inbox "$T" "alpha"

  # Three blocks: em-dash, en-dash, hyphen. $EM/$EN are the real U+2014/U+2013
  # characters (built at the top of this file), so this fixture is genuinely a
  # mixed-separator one.
  write_thread "$T" "alpha" "gamma" "## 2026-01-01T12:00:00Z ${EM} from: gamma ${EM} status: sent ${EM} subject: em-dash block

Em-dash body.

## 2026-01-01T12:01:00Z ${EN} from: gamma ${EN} status: sent ${EN} subject: en-dash block

En-dash body.

## 2026-01-01T12:02:00Z - from: gamma - status: sent - subject: hyphen block

Hyphen body." > /dev/null

  OUT=$(run_inbox "$T" "alpha" read gamma 2>&1)
  FILE_CONTENT=$(cat "$T/alpha/inbox/gamma.md")

  EM_SHOWN=$(echo "$OUT" | grep -c "em-dash block" || true)
  EN_SHOWN=$(echo "$OUT" | grep -c "en-dash block" || true)
  HY_SHOWN=$(echo "$OUT" | grep -c "hyphen block" || true)

  FLIPPED_COUNT=$(echo "$FILE_CONTENT" | grep -c "status: read" || true)

  if [ "$EM_SHOWN" -ge 1 ] && [ "$EN_SHOWN" -ge 1 ] && [ "$HY_SHOWN" -ge 1 ] && [ "$FLIPPED_COUNT" -eq 3 ]; then
    ok "Case 3: mixed delimiters (em/en/hyphen) all parse + flip"
  else
    fail "Case 3: not all delimiter types parsed/flipped" "shown: em=$EM_SHOWN en=$EN_SHOWN hy=$HY_SHOWN flipped=$FLIPPED_COUNT"
  fi
  rm -rf "$T"
}

# ---------------------------------------------------------------------------
# Case 4: symlink thread -- flip writes through, symlink survives
# ---------------------------------------------------------------------------
{
  T=$(mktemp -d)
  make_inbox "$T" "alpha"
  make_inbox "$T" "beta"

  # Real file in beta's inbox (beta initiated)
  REAL="$T/beta/inbox/alpha.md"
  printf '%s' "## 2026-01-01T13:00:00Z - from: beta - status: sent - subject: link test

Symlink body." > "$REAL"

  # Symlink in alpha's inbox pointing to the real file
  LINK="$T/alpha/inbox/beta.md"
  ln -s "$REAL" "$LINK"

  run_inbox "$T" "alpha" read beta > /dev/null 2>&1

  REAL_CONTENT=$(cat "$REAL")

  if ! [ -L "$LINK" ]; then
    fail "Case 4: symlink was replaced with a regular file" ""
  elif echo "$REAL_CONTENT" | grep -q "status: read"; then
    ok "Case 4: symlink survives; real file updated through symlink"
  else
    fail "Case 4: real file not updated through symlink" "real: $REAL_CONTENT"
  fi
  rm -rf "$T"
}

# ---------------------------------------------------------------------------
# Case 5: reply appends canonical hyphen block in correct field order
# ---------------------------------------------------------------------------
{
  T=$(mktemp -d)
  make_inbox "$T" "alpha"

  run_inbox "$T" "alpha" reply "delta" --subject "hello delta" --body "This is my reply." > /dev/null 2>&1

  TPATH="$T/alpha/inbox/delta.md"
  FILE_CONTENT=$(cat "$TPATH")

  # Must match the canonical header shape with hyphen separator, correct field order
  # ## <ts> - from: <name> - status: sent - subject: <text>
  if echo "$FILE_CONTENT" | grep -qP "^## \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z - from: alpha - status: sent - subject: hello delta"; then
    # Also confirm no em-dash in the header
    if echo "$FILE_CONTENT" | grep -q "$EM"; then
      fail "Case 5: em-dash found in written block header" "content: $FILE_CONTENT"
    else
      ok "Case 5: reply appends canonical hyphen block in correct field order"
    fi
  else
    fail "Case 5: header format incorrect or missing" "content: $FILE_CONTENT"
  fi
  rm -rf "$T"
}

# ---------------------------------------------------------------------------
# Case 6: reply with em-dash body -> non-zero exit, file unchanged
# ---------------------------------------------------------------------------
{
  T=$(mktemp -d)
  make_inbox "$T" "alpha"

  TPATH="$T/alpha/inbox/epsilon.md"

  # Pre-create the file with existing content so we can verify it is unchanged
  printf '%s' "## 2026-01-01T14:00:00Z - from: epsilon - status: sent - subject: existing

Existing content." > "$TPATH"

  BEFORE=$(cat "$TPATH")

  # Try to reply with an em-dash in the body
  set +e
  run_inbox "$T" "alpha" reply "epsilon" --subject "bad reply" --body "This reply contains an em-dash ${EM} which must be rejected." > /dev/null 2>&1
  EXIT_CODE=$?
  set -e

  AFTER=$(cat "$TPATH")

  if [ "$EXIT_CODE" -eq 0 ]; then
    fail "Case 6: em-dash body should have caused non-zero exit" "exit=$EXIT_CODE"
  elif [ "$BEFORE" != "$AFTER" ]; then
    fail "Case 6: file was modified despite em-dash rejection" ""
  else
    ok "Case 6: em-dash body -> non-zero exit, file unchanged"
  fi
  rm -rf "$T"
}

# ---------------------------------------------------------------------------
# Case 7: reply flips correspondent's last sent->read
# ---------------------------------------------------------------------------
{
  T=$(mktemp -d)
  make_inbox "$T" "alpha"

  TPATH=$(write_thread "$T" "alpha" "zeta" "## 2026-01-01T15:00:00Z - from: zeta - status: sent - subject: waiting for reply

Please reply to this.")

  run_inbox "$T" "alpha" reply "zeta" --subject "re: waiting" --body "Here is my reply." > /dev/null 2>&1

  FILE_CONTENT=$(cat "$TPATH")

  # The original sent block from zeta must now be read
  # And there must be a new block from alpha
  ZETA_READ=$(echo "$FILE_CONTENT" | grep -c "from: zeta.*status: read" || true)
  ALPHA_APPENDED=$(echo "$FILE_CONTENT" | grep -c "from: alpha.*status: sent" || true)

  if [ "$ZETA_READ" -ge 1 ] && [ "$ALPHA_APPENDED" -ge 1 ]; then
    ok "Case 7: reply flips correspondent's last sent->read and appends own block"
  else
    fail "Case 7: flip or append missing" "zeta_read=$ZETA_READ alpha_appended=$ALPHA_APPENDED file: $FILE_CONTENT"
  fi
  rm -rf "$T"
}

# ---------------------------------------------------------------------------
# Case 8: ack flip-only, no append
# ---------------------------------------------------------------------------
{
  T=$(mktemp -d)
  make_inbox "$T" "alpha"

  TPATH=$(write_thread "$T" "alpha" "eta" "## 2026-01-01T16:00:00Z - from: eta - status: sent - subject: fyi no reply needed

Just letting you know.")

  BEFORE_LINES=$(wc -l < "$TPATH")

  run_inbox "$T" "alpha" ack "eta" > /dev/null 2>&1

  FILE_CONTENT=$(cat "$TPATH")
  AFTER_LINES=$(wc -l < "$TPATH")

  ETA_READ=$(echo "$FILE_CONTENT" | grep -c "from: eta.*status: read" || true)
  ALPHA_BLOCKS=$(echo "$FILE_CONTENT" | grep -c "from: alpha" || true)

  if [ "$ETA_READ" -ge 1 ] && [ "$ALPHA_BLOCKS" -eq 0 ] && [ "$AFTER_LINES" -eq "$BEFORE_LINES" ]; then
    ok "Case 8: ack flip-only (no append, block flipped to read)"
  else
    fail "Case 8: ack either appended or did not flip" "eta_read=$ETA_READ alpha_blocks=$ALPHA_BLOCKS before=$BEFORE_LINES after=$AFTER_LINES"
  fi
  rm -rf "$T"
}

# ---------------------------------------------------------------------------
# Case 9: unread counts correct
# ---------------------------------------------------------------------------
{
  T=$(mktemp -d)
  make_inbox "$T" "alpha"

  # Two unread from theta, one read from theta, one unread from iota
  write_thread "$T" "alpha" "theta" "## 2026-01-01T17:00:00Z - from: theta - status: sent - subject: msg1

First unread.

## 2026-01-01T17:01:00Z - from: theta - status: read - subject: msg2

Already read.

## 2026-01-01T17:02:00Z - from: theta - status: sent - subject: msg3

Second unread." > /dev/null

  write_thread "$T" "alpha" "iota" "## 2026-01-01T17:03:00Z - from: iota - status: sent - subject: iota msg

One from iota." > /dev/null

  OUT=$(run_inbox "$T" "alpha" unread 2>&1)

  THETA_LINE=$(echo "$OUT" | grep "theta:" || true)
  IOTA_LINE=$(echo "$OUT" | grep "iota:" || true)

  THETA_COUNT=$(echo "$THETA_LINE" | grep -oP '\d+' || true)
  IOTA_COUNT=$(echo "$IOTA_LINE" | grep -oP '\d+' || true)

  if [ "$THETA_COUNT" = "2" ] && [ "$IOTA_COUNT" = "1" ]; then
    ok "Case 9: unread counts correct (theta=2, iota=1)"
  else
    fail "Case 9: unread counts wrong" "theta=$THETA_COUNT iota=$IOTA_COUNT output: $OUT"
  fi
  rm -rf "$T"
}

# ---------------------------------------------------------------------------
# Case 10: missing AGENT_NAME -> hard error (non-zero exit, clear message)
# ---------------------------------------------------------------------------
{
  T=$(mktemp -d)

  set +e
  OUT=$(INBOX_ROOT="$T" AGENT_NAME="" python3 "$INBOX" read 2>&1)
  EXIT_CODE=$?
  set -e

  if [ "$EXIT_CODE" -ne 0 ] && echo "$OUT" | grep -qi "AGENT_NAME"; then
    ok "Case 10: missing AGENT_NAME -> hard error with clear message"
  else
    fail "Case 10: expected non-zero exit + AGENT_NAME message" "exit=$EXIT_CODE output=$OUT"
  fi
  rm -rf "$T"
}

# ---------------------------------------------------------------------------
# Case 10a: missing INBOX_ROOT -> hard error (non-zero exit, names INBOX_ROOT)
#
# The inbox root is an env var with NO default. A default would be worse than
# an error here: the CLI would silently write to a root nothing else reads, and
# the split would only surface as "my messages never arrive". So the failure
# has to be loud, and it has to name the variable the operator must set.
# ---------------------------------------------------------------------------
{
  set +e
  OUT=$(env -u INBOX_ROOT AGENT_NAME=alpha python3 "$INBOX" read 2>&1)
  EXIT_CODE=$?
  set -e

  if [ "$EXIT_CODE" -ne 0 ] && echo "$OUT" | grep -q "INBOX_ROOT"; then
    ok "Case 10a: missing INBOX_ROOT -> hard error naming INBOX_ROOT"
  else
    fail "Case 10a: expected non-zero exit + INBOX_ROOT message" "exit=$EXIT_CODE output=$OUT"
  fi
}

# ---------------------------------------------------------------------------
# Case 10b: relative INBOX_ROOT -> hard error. A relative root resolves against
# whatever directory the caller happened to be in, so two callers of the same
# configuration would address different inboxes.
# ---------------------------------------------------------------------------
{
  set +e
  OUT=$(INBOX_ROOT="relative/inbox/root" AGENT_NAME=alpha python3 "$INBOX" read 2>&1)
  EXIT_CODE=$?
  set -e

  if [ "$EXIT_CODE" -ne 0 ] && echo "$OUT" | grep -qi "absolute"; then
    ok "Case 10b: relative INBOX_ROOT -> hard error demanding an absolute path"
  else
    fail "Case 10b: expected non-zero exit + absolute-path message" "exit=$EXIT_CODE output=$OUT"
  fi
}

# ---------------------------------------------------------------------------
# Case 11: no-clobber / in-place proof -- file length unchanged, only
#          sent->read bytes differ, everything else identical
# ---------------------------------------------------------------------------
{
  T=$(mktemp -d)
  make_inbox "$T" "alpha"

  TPATH=$(write_thread "$T" "alpha" "omega" "## 2026-01-01T20:00:00Z - from: omega - status: sent - subject: inplace test

Body for inplace test.")

  BEFORE=$(cat "$TPATH" | wc -c)
  BEFORE_BYTES=$(cat "$TPATH" | od -An -v -tx1 | tr -d ' \n')

  run_inbox "$T" "alpha" read omega > /dev/null 2>&1

  AFTER=$(cat "$TPATH" | wc -c)
  AFTER_BYTES=$(cat "$TPATH" | od -An -v -tx1 | tr -d ' \n')

  # Verify length unchanged
  if [ "$BEFORE" -ne "$AFTER" ]; then
    fail "Case 11: file length changed ($BEFORE -> $AFTER), not an in-place patch"
  else
    # Verify only "sent" -> "read" changed (73 65 6e 74 -> 72 65 61 64 in hex)
    # Both are 4 bytes so length stays equal; just check "read" now present and "sent" gone
    AFTER_CONTENT=$(cat "$TPATH")
    if echo "$AFTER_CONTENT" | grep -q "status: read"; then
      # Byte-exact: flipping the first "sent" to "read" in
      # the before-bytes must reproduce the after-bytes, so nothing else moved.
      EXPECTED_BYTES="${BEFORE_BYTES/73656e74/72656164}"
      if [ "$EXPECTED_BYTES" != "$AFTER_BYTES" ]; then
        fail "Case 11: bytes other than sent->read changed" "expected: $EXPECTED_BYTES
actual:   $AFTER_BYTES"
      elif ! echo "$AFTER_CONTENT" | grep -q "status: sent"; then
        ok "Case 11: in-place patch -- file length unchanged, sent->read flipped, nothing else moved"
      else
        fail "Case 11: status: sent still present after flip" "content: $AFTER_CONTENT"
      fi
    else
      fail "Case 11: status: read not found after flip" "content: $AFTER_CONTENT"
    fi
  fi
  rm -rf "$T"
}

# ---------------------------------------------------------------------------
# Case 12: concurrent-append survives a flip -- newly appended block intact
# ---------------------------------------------------------------------------
{
  T=$(mktemp -d)
  make_inbox "$T" "alpha"

  TPATH=$(write_thread "$T" "alpha" "kappa" "## 2026-01-01T21:00:00Z - from: kappa - status: sent - subject: flip this

Flip me.")

  # Simulate a concurrent append AFTER the CLI would read but BEFORE it writes.
  # We do it sequentially here: append a new block, then run ack (which reads +
  # patches in-place, so the append at EOF must survive).
  printf '\n## 2026-01-01T21:01:00Z - from: kappa - status: sent - subject: appended after\n\nAppended block body.\n' >> "$TPATH"

  run_inbox "$T" "alpha" ack kappa > /dev/null 2>&1

  FILE_CONTENT=$(cat "$TPATH")

  FIRST_FLIPPED=$(echo "$FILE_CONTENT" | grep -c "subject: flip this" || true)
  APPENDED_INTACT=$(echo "$FILE_CONTENT" | grep -c "subject: appended after" || true)
  READ_COUNT=$(echo "$FILE_CONTENT" | grep -c "status: read" || true)

  if [ "$FIRST_FLIPPED" -ge 1 ] && [ "$APPENDED_INTACT" -ge 1 ] && [ "$READ_COUNT" -ge 1 ]; then
    ok "Case 12: concurrent append survives in-place flip (both blocks intact)"
  else
    fail "Case 12: flip or append lost" "first=$FIRST_FLIPPED appended=$APPENDED_INTACT read=$READ_COUNT content=$FILE_CONTENT"
  fi
  rm -rf "$T"
}

# ---------------------------------------------------------------------------
# Case 13: multibyte-safe offset -- em-dash delimiter in header, flip still
#          lands on the correct "sent" token
# ---------------------------------------------------------------------------
{
  T=$(mktemp -d)
  make_inbox "$T" "alpha"

  # First block: em-dash delimiters, already read (must NOT be flipped again)
  # Second block: em-dash delimiter in subject text, status: sent (MUST be flipped)
  # $EM is the em-dash (U+2014, UTF-8: e2 80 94) built at the top of this file.
  write_thread "$T" "alpha" "lambda" "## 2026-01-01T22:00:00Z ${EM} from: lambda ${EM} status: read ${EM} subject: already read block

Already read, multibyte header.

## 2026-01-01T22:01:00Z ${EM} from: lambda ${EM} status: sent ${EM} subject: unread with ${EM} in subject

Unread body." > /dev/null

  BEFORE_LEN=$(wc -c < "$T/alpha/inbox/lambda.md")

  run_inbox "$T" "alpha" read lambda > /dev/null 2>&1

  AFTER_LEN=$(wc -c < "$T/alpha/inbox/lambda.md")
  FILE_CONTENT=$(cat "$T/alpha/inbox/lambda.md")

  READ_COUNT=$(echo "$FILE_CONTENT" | grep -c "status: read" || true)
  SENT_COUNT=$(echo "$FILE_CONTENT" | grep -c "status: sent" || true)

  if [ "$BEFORE_LEN" -ne "$AFTER_LEN" ]; then
    fail "Case 13: file length changed -- multibyte offset error likely" "before=$BEFORE_LEN after=$AFTER_LEN"
  elif [ "$READ_COUNT" -eq 2 ] && [ "$SENT_COUNT" -eq 0 ]; then
    ok "Case 13: multibyte offset safe -- unread em-dash block flipped, already-read untouched, length unchanged"
  else
    fail "Case 13: wrong flip result" "read_count=$READ_COUNT sent_count=$SENT_COUNT len_before=$BEFORE_LEN len_after=$AFTER_LEN"
  fi
  rm -rf "$T"
}

# ---------------------------------------------------------------------------
# Case 14: subject em-dash rejected -- non-zero exit, thread file unchanged
# ---------------------------------------------------------------------------
{
  T=$(mktemp -d)
  make_inbox "$T" "alpha"

  TPATH="$T/alpha/inbox/mu.md"
  printf '%s' "## 2026-01-01T23:00:00Z - from: mu - status: sent - subject: existing

Existing content in mu thread." > "$TPATH"

  BEFORE=$(cat "$TPATH")

  set +e
  run_inbox "$T" "alpha" reply "mu" --subject "bad subject${EM}here" --body "fine body" > /dev/null 2>&1
  EXIT_CODE=$?
  set -e

  AFTER=$(cat "$TPATH")

  if [ "$EXIT_CODE" -eq 0 ]; then
    fail "Case 14: em-dash subject should have caused non-zero exit" "exit=$EXIT_CODE"
  elif [ "$BEFORE" != "$AFTER" ]; then
    fail "Case 14: file was modified despite em-dash subject rejection"
  else
    ok "Case 14: subject em-dash rejected -- non-zero exit, file unchanged"
  fi
  rm -rf "$T"
}

# ---------------------------------------------------------------------------
# Case 15: symlink thread still a symlink after in-place flip
# ---------------------------------------------------------------------------
{
  T=$(mktemp -d)
  make_inbox "$T" "alpha"
  make_inbox "$T" "nu"

  # Real file in nu's inbox; symlink in alpha's inbox
  REAL="$T/nu/inbox/alpha.md"
  printf '%s' "## 2026-01-01T23:30:00Z - from: nu - status: sent - subject: symlink inplace test

Symlink inplace body." > "$REAL"

  LINK="$T/alpha/inbox/nu.md"
  ln -s "$REAL" "$LINK"

  BEFORE_LEN=$(wc -c < "$REAL")

  run_inbox "$T" "alpha" ack nu > /dev/null 2>&1

  AFTER_LEN=$(wc -c < "$REAL")
  REAL_CONTENT=$(cat "$REAL")

  if ! [ -L "$LINK" ]; then
    fail "Case 15: symlink was replaced with a regular file after in-place flip"
  elif [ "$BEFORE_LEN" -ne "$AFTER_LEN" ]; then
    fail "Case 15: real file length changed -- in-place patch did a full rewrite through symlink" "before=$BEFORE_LEN after=$AFTER_LEN"
  elif echo "$REAL_CONTENT" | grep -q "status: read"; then
    ok "Case 15: symlink survives in-place flip; real file updated with same length"
  else
    fail "Case 15: real file not updated through symlink" "real: $REAL_CONTENT"
  fi
  rm -rf "$T"
}

# ---------------------------------------------------------------------------
# Case 16: card bodies (decision-id:/action-id:) get NO blank line between
#          header and metadata (a blank line empties the card renderer's
#          metadata region, and the block de-cards into plain prose)
# ---------------------------------------------------------------------------
{
  T=$(mktemp -d)
  make_inbox "$T" "alpha"

  CARD_BODY="decision-id: foo
options:
  a: go
  b: hold"
  run_inbox "$T" "alpha" reply beta --subject "card test" --body "$CARD_BODY" > /dev/null 2>&1

  THREAD="$T/alpha/inbox/beta.md"
  # The line after the ## header must be "decision-id: foo" (no blank line)
  LINE_AFTER=$(awk '/^## /{found=1;next} found{print;exit}' "$THREAD")
  if [ "$LINE_AFTER" = "decision-id: foo" ]; then
    ok "Case 16: card body has no blank line separator between header and metadata"
  else
    fail "Case 16: card body has blank line before metadata (the card will de-card)" "line_after=${LINE_AFTER:-<empty>}"
  fi
  rm -rf "$T"
}

# ---------------------------------------------------------------------------
# Case 17: Plain message bodies still get a blank line separator
# ---------------------------------------------------------------------------
{
  T=$(mktemp -d)
  make_inbox "$T" "alpha"

  run_inbox "$T" "alpha" reply beta --subject "plain test" --body "just a regular body" > /dev/null 2>&1

  THREAD="$T/alpha/inbox/beta.md"
  LINE_AFTER=$(awk '/^## /{found=1;next} found{print;exit}' "$THREAD")
  if [ -z "$LINE_AFTER" ]; then
    ok "Case 17: plain message body preserves blank line separator after header"
  else
    fail "Case 17: plain message missing blank line separator" "line_after=${LINE_AFTER}"
  fi
  rm -rf "$T"
}

# ---------------------------------------------------------------------------
# Case 18: card via --body-file with LEADING NEWLINE -> decision-id: flush
#          (the bug: stripping detected a card but the ORIGINAL body was
#           emitted, leaving a blank line that breaks card rendering)
# ---------------------------------------------------------------------------
{
  T=$(mktemp -d)
  make_inbox "$T" "alpha"

  CARD_FILE=$(mktemp)
  # File starts with a leading newline then decision-id: -- the triggering shape
  printf '\ndecision-id: test-18\noptions:\n  a: go\n  b: hold\n' > "$CARD_FILE"

  run_inbox "$T" "alpha" reply beta --subject "card-18" --body-file "$CARD_FILE" > /dev/null 2>&1

  THREAD="$T/alpha/inbox/beta.md"
  LINE_AFTER=$(awk '/^## /{found=1;next} found{print;exit}' "$THREAD")

  if [ "$LINE_AFTER" = "decision-id: test-18" ]; then
    ok "Case 18: card via --body-file with leading newline -> decision-id: flush (no blank line)"
  else
    fail "Case 18: leading-newline body-file card has blank line before metadata" "line_after=${LINE_AFTER:-<empty>}"
  fi
  rm -rf "$T"
  rm -f "$CARD_FILE"
}

# ---------------------------------------------------------------------------
# Case 19: card via --body-file with NO leading newline -> still flush
#          (regression guard: the fix must not break already-correct bodies)
# ---------------------------------------------------------------------------
{
  T=$(mktemp -d)
  make_inbox "$T" "alpha"

  CARD_FILE=$(mktemp)
  printf 'decision-id: test-19\noptions:\n  a: go\n  b: hold\n' > "$CARD_FILE"

  run_inbox "$T" "alpha" reply beta --subject "card-19" --body-file "$CARD_FILE" > /dev/null 2>&1

  THREAD="$T/alpha/inbox/beta.md"
  LINE_AFTER=$(awk '/^## /{found=1;next} found{print;exit}' "$THREAD")

  if [ "$LINE_AFTER" = "decision-id: test-19" ]; then
    ok "Case 19: card via --body-file WITHOUT leading newline -> still flush (no regression)"
  else
    fail "Case 19: no-leading-newline card body unexpectedly has blank line" "line_after=${LINE_AFTER:-<empty>}"
  fi
  rm -rf "$T"
  rm -f "$CARD_FILE"
}

# ---------------------------------------------------------------------------
# Case 20: card via --body (inline) starting with decision-id: -> flush
# ---------------------------------------------------------------------------
{
  T=$(mktemp -d)
  make_inbox "$T" "alpha"

  run_inbox "$T" "alpha" reply beta --subject "card-20" --body "decision-id: test-20
options:
  a: go
  b: hold" > /dev/null 2>&1

  THREAD="$T/alpha/inbox/beta.md"
  LINE_AFTER=$(awk '/^## /{found=1;next} found{print;exit}' "$THREAD")

  if [ "$LINE_AFTER" = "decision-id: test-20" ]; then
    ok "Case 20: card via --body (inline) starting with decision-id: -> flush"
  else
    fail "Case 20: inline --body card has blank line before metadata" "line_after=${LINE_AFTER:-<empty>}"
  fi
  rm -rf "$T"
}

# ---------------------------------------------------------------------------
# Case 21: non-card body (plain prose) via --body-file -> blank line preserved
# ---------------------------------------------------------------------------
{
  T=$(mktemp -d)
  make_inbox "$T" "alpha"

  BODY_FILE=$(mktemp)
  printf 'Just a regular prose body.\nSecond line.' > "$BODY_FILE"

  run_inbox "$T" "alpha" reply beta --subject "plain-21" --body-file "$BODY_FILE" > /dev/null 2>&1

  THREAD="$T/alpha/inbox/beta.md"
  LINE_AFTER=$(awk '/^## /{found=1;next} found{print;exit}' "$THREAD")

  if [ -z "$LINE_AFTER" ]; then
    ok "Case 21: non-card body via --body-file -> blank line separator preserved"
  else
    fail "Case 21: non-card body missing blank line separator after header" "line_after=${LINE_AFTER}"
  fi
  rm -rf "$T"
  rm -f "$BODY_FILE"
}

# ---------------------------------------------------------------------------
# Case 22: action-id: card via --body-file with leading newline -> flush
# ---------------------------------------------------------------------------
{
  T=$(mktemp -d)
  make_inbox "$T" "alpha"

  CARD_FILE=$(mktemp)
  printf '\naction-id: test-22\ndo: something\n' > "$CARD_FILE"

  run_inbox "$T" "alpha" reply beta --subject "card-22" --body-file "$CARD_FILE" > /dev/null 2>&1

  THREAD="$T/alpha/inbox/beta.md"
  LINE_AFTER=$(awk '/^## /{found=1;next} found{print;exit}' "$THREAD")

  if [ "$LINE_AFTER" = "action-id: test-22" ]; then
    ok "Case 22: action-id: card via --body-file with leading newline -> flush"
  else
    fail "Case 22: action-id: leading-newline card has blank line before metadata" "line_after=${LINE_AFTER:-<empty>}"
  fi
  rm -rf "$T"
  rm -f "$CARD_FILE"
}

# ---------------------------------------------------------------------------
# Helper: replicate the card renderer's metadata-region rule.
# Usage: check_card_parses <thread_file>
# Prints "CARD" if the last appended block has a non-empty metadata region
# whose first line starts with decision-id: or action-id:.
# Prints "PROSE" otherwise (block will render as plain text).
# This mirrors the renderer contract: metadata region = lines from (header+1)
# up to the FIRST blank line.  Empty region -> plain prose.
# ---------------------------------------------------------------------------
check_card_parses() {
  local thread_file="$1"
  python3 - "$thread_file" <<'PYEOF'
import sys, re

path = sys.argv[1]
with open(path, "r", encoding="utf-8") as fh:
    content = fh.read()

lines = content.split("\n")

# Find the LAST ## header (the most-recently appended block)
header_idx = None
for i, line in enumerate(lines):
    if re.match(r"^## ", line):
        header_idx = i

if header_idx is None:
    print("PROSE")
    sys.exit(0)

# Metadata region: lines from header_idx+1 up to the first blank line
meta_lines = []
for line in lines[header_idx + 1:]:
    if line.strip() == "":
        break
    meta_lines.append(line)

if not meta_lines:
    print("PROSE")
    sys.exit(0)

first = meta_lines[0]
if first.startswith("decision-id:") or first.startswith("action-id:"):
    print("CARD")
else:
    print("PROSE")
PYEOF
}

# ---------------------------------------------------------------------------
# Case 23: card body with prose running straight on from lean: A (no blank)
#          -> emitted block parses as a card (blank auto-inserted before prose)
# ---------------------------------------------------------------------------
{
  T=$(mktemp -d)
  make_inbox "$T" "alpha"

  # Body: metadata run ends at "lean: A", then prose runs on with no blank.
  CARD_BODY="decision-id: test-23
options:
  - key: A
    label: Go
  - key: B
    label: Hold
lean: A
This is the rationale with no blank line before it."

  run_inbox "$T" "alpha" reply beta --subject "card-23" --body "$CARD_BODY" > /dev/null 2>&1

  THREAD="$T/alpha/inbox/beta.md"
  RESULT=$(check_card_parses "$THREAD")

  if [ "$RESULT" = "CARD" ]; then
    ok "Case 23: prose-after-metadata (no blank) -> blank auto-inserted, block parses as card"
  else
    fail "Case 23: block did not parse as card" "parser said: $RESULT"
  fi
  rm -rf "$T"
}

# ---------------------------------------------------------------------------
# Case 24: card body that ALREADY has a blank before prose -> idempotent
#          (still one blank, still parses as card)
# ---------------------------------------------------------------------------
{
  T=$(mktemp -d)
  make_inbox "$T" "alpha"

  CARD_BODY="decision-id: test-24
options:
  - key: A
    label: Go
lean: A

This rationale already has a blank line before it."

  run_inbox "$T" "alpha" reply beta --subject "card-24" --body "$CARD_BODY" > /dev/null 2>&1

  THREAD="$T/alpha/inbox/beta.md"

  # Count blank lines between lean: A and the prose (must be exactly 1, not 2)
  # We do this by checking the block content directly.
  BLOCK_CONTENT=$(awk '/^## /{p=1} p{print}' "$THREAD" | tail -n +2)
  DOUBLE_BLANK=$(printf '%s' "$BLOCK_CONTENT" | grep -c "^$" | awk '{if($1>=2) print "YES"; else print "NO"}' || echo "NO")

  RESULT=$(check_card_parses "$THREAD")

  if [ "$RESULT" = "CARD" ]; then
    ok "Case 24: already-has-blank card -> idempotent (still parses as card)"
  else
    fail "Case 24: idempotent card broke parsing" "parser said: $RESULT"
  fi
  rm -rf "$T"
}

# ---------------------------------------------------------------------------
# Case 25: pure-metadata card (ends at lean: A, no prose, no trailing blank)
#          -> emitted block parses as a card (terminator blank added by block
#             construction)
# ---------------------------------------------------------------------------
{
  T=$(mktemp -d)
  make_inbox "$T" "alpha"

  CARD_BODY="decision-id: test-25
options:
  - key: A
    label: Go
lean: A"

  run_inbox "$T" "alpha" reply beta --subject "card-25" --body "$CARD_BODY" > /dev/null 2>&1

  THREAD="$T/alpha/inbox/beta.md"
  RESULT=$(check_card_parses "$THREAD")

  if [ "$RESULT" = "CARD" ]; then
    ok "Case 25: pure-metadata card -> block construction adds terminator blank, parses as card"
  else
    fail "Case 25: pure-metadata card did not parse as card" "parser said: $RESULT"
  fi
  rm -rf "$T"
}

# ---------------------------------------------------------------------------
# Case 26: action-id card with prose-no-blank -> parses as card
# ---------------------------------------------------------------------------
{
  T=$(mktemp -d)
  make_inbox "$T" "alpha"

  CARD_BODY="action-id: test-26
priority: high
done: false
This prose has no blank before it."

  run_inbox "$T" "alpha" reply beta --subject "card-26" --body "$CARD_BODY" > /dev/null 2>&1

  THREAD="$T/alpha/inbox/beta.md"
  RESULT=$(check_card_parses "$THREAD")

  if [ "$RESULT" = "CARD" ]; then
    ok "Case 26: action-id card with prose-no-blank -> parses as card"
  else
    fail "Case 26: action-id prose-no-blank card did not parse as card" "parser said: $RESULT"
  fi
  rm -rf "$T"
}

# ---------------------------------------------------------------------------
# Case 27: multi-line options block then prose-no-blank -> metadata run
#          correctly spans indented lines, blank inserted only before prose,
#          parses as card with full options in the metadata region
# ---------------------------------------------------------------------------
{
  T=$(mktemp -d)
  make_inbox "$T" "alpha"

  CARD_BODY="decision-id: test-27
record: some-record
options:
  - key: A
    label: Accept
    detail: Accept the proposal as-is
  - key: B
    label: Defer
    detail: Come back next sprint
lean: A
Rationale prose with no preceding blank."

  run_inbox "$T" "alpha" reply beta --subject "card-27" --body "$CARD_BODY" > /dev/null 2>&1

  THREAD="$T/alpha/inbox/beta.md"
  RESULT=$(check_card_parses "$THREAD")

  # Also verify the full options block is present in the metadata region
  # (i.e. blank was inserted AFTER lean: A, not prematurely inside options)
  META_HAS_OPTIONS=$(python3 - "$THREAD" <<'PYEOF'
import sys, re
path = sys.argv[1]
with open(path, "r", encoding="utf-8") as fh:
    lines = fh.read().split("\n")
header_idx = None
for i, line in enumerate(lines):
    if re.match(r"^## ", line):
        header_idx = i
if header_idx is None:
    print("NO")
    sys.exit(0)
meta_lines = []
for line in lines[header_idx + 1:]:
    if line.strip() == "":
        break
    meta_lines.append(line)
has_options = any("options:" in l for l in meta_lines)
has_key_a = any("key: A" in l for l in meta_lines)
has_lean = any(l.startswith("lean:") for l in meta_lines)
print("YES" if (has_options and has_key_a and has_lean) else "NO")
PYEOF
)

  if [ "$RESULT" = "CARD" ] && [ "$META_HAS_OPTIONS" = "YES" ]; then
    ok "Case 27: multi-line options block + prose-no-blank -> full metadata in region, parses as card"
  else
    fail "Case 27: multi-line options card failed" "parser=$RESULT meta_has_options=$META_HAS_OPTIONS"
  fi
  rm -rf "$T"
}

# ---------------------------------------------------------------------------
# Case 28: NON-card body (plain prose) -> UNCHANGED (byte-identical behaviour)
#          Verifies the fix does not touch non-card sends.
# ---------------------------------------------------------------------------
{
  T=$(mktemp -d)
  make_inbox "$T" "alpha"

  # Send via the old path (non-card) -- result must be byte-for-byte identical
  # to what it would have been before the fix.  We verify: blank line after
  # header, prose content intact, no extra blank lines injected.
  PLAIN_BODY="This is plain prose.
Second line."

  run_inbox "$T" "alpha" reply beta --subject "plain-28" --body "$PLAIN_BODY" > /dev/null 2>&1

  THREAD="$T/alpha/inbox/beta.md"
  LINE_AFTER=$(awk '/^## /{found=1;next} found{print;exit}' "$THREAD")
  CONTENT=$(cat "$THREAD")

  # Non-card: line after header must be blank (sep="\n" path)
  # Content must contain both prose lines
  if [ -z "$LINE_AFTER" ] && echo "$CONTENT" | grep -q "This is plain prose." && echo "$CONTENT" | grep -q "Second line."; then
    ok "Case 28: non-card body unchanged (blank separator, content intact)"
  else
    fail "Case 28: non-card body behaviour changed" "line_after=${LINE_AFTER:-<empty>} content=$CONTENT"
  fi
  rm -rf "$T"
}

# ---------------------------------------------------------------------------
# Case 29 (E2E send to a scratch thread): card body with prose-no-blank via
#          --body-file -> appended block parses as card; scratch file deleted.
# Runs the CLI end-to-end with no stubbing of the write path at all: agent
# "courier", correspondent "scratch-card-test-e2e", under its own INBOX_ROOT.
# ---------------------------------------------------------------------------
{
  T=$(mktemp -d)
  SCRATCH_ROOT="$T"
  SCRATCH_CORR="scratch-card-test-e2e"
  SCRATCH_PATH="$SCRATCH_ROOT/courier/inbox/${SCRATCH_CORR}.md"

  # Remove scratch file if it already exists from a prior failed run.
  rm -f "$SCRATCH_PATH"

  CARD_FILE=$(mktemp)
  printf 'decision-id: e2e-test-29\noptions:\n  - key: A\n    label: Accept\n  - key: B\n    label: Defer\nlean: A\nThis rationale has no blank line before it.' > "$CARD_FILE"

  INBOX_ROOT="$SCRATCH_ROOT" AGENT_NAME=courier python3 "$INBOX" reply "$SCRATCH_CORR" \
    --subject "e2e card parse test" \
    --body-file "$CARD_FILE" > /dev/null 2>&1

  rm -f "$CARD_FILE"

  if [ ! -f "$SCRATCH_PATH" ]; then
    fail "Case 29 (E2E): scratch thread file was not created" ""
  else
    RESULT=$(check_card_parses "$SCRATCH_PATH")
    BLOCK_BYTES=$(cat "$SCRATCH_PATH")

    # Print the block bytes for the report
    echo "E2E block bytes:"
    echo "$BLOCK_BYTES"
    echo "---"
    echo "E2E parser-rule check: $RESULT"

    rm -f "$SCRATCH_PATH"

    if [ "$RESULT" = "CARD" ]; then
      ok "Case 29 (E2E): prose-no-blank card via --body-file -> parses as card; scratch file deleted"
    else
      fail "Case 29 (E2E): block did not parse as card" "parser said: $RESULT"
    fi
  fi
  rm -rf "$T"
}

# ---------------------------------------------------------------------------
# Cases 30-33: reply push integration (default-ON, INBOX_PUSH=0 per-send
# opt-out, INBOX_NO_PUSH=1 hard-off, best-effort, never-fail-send). Uses a stub
# inbox-push via INBOX_PUSH_BIN.
# ---------------------------------------------------------------------------

# make_push_stub <dir> <verdict> <rc> -> path to a stub that prints verdict + exits rc
make_push_stub() {
  local dir="$1" verdict="$2" rc="$3"
  local p="$dir/inbox-push-stub"
  cat > "$p" <<STUB
#!/usr/bin/env bash
echo "$verdict"
exit $rc
STUB
  chmod +x "$p"
  echo "$p"
}

# Case 30: push default ON -> reply emits "push: pushed"; INBOX_PUSH=0 opts out.
{
  T=$(mktemp -d); make_inbox "$T" alpha
  STUB=$(make_push_stub "$T" "pushed" 0)
  OUT=$(INBOX_PUSH_BIN="$STUB" run_inbox "$T" alpha reply bob --subject "hi" --body "hello" 2>&1)
  OUT_OPTOUT=$(INBOX_PUSH=0 INBOX_PUSH_BIN="$STUB" run_inbox "$T" alpha reply bob --subject "hi2" --body "hello" 2>&1)
  if echo "$OUT" | grep -q "replied to bob" && echo "$OUT" | grep -q "push: pushed" \
     && echo "$OUT_OPTOUT" | grep -q "replied to bob" && ! echo "$OUT_OPTOUT" | grep -q "push:"; then
    ok "Case 30: push default-on -> pushes; INBOX_PUSH=0 opts out"
  else
    fail "Case 30: push default-on + opt-out" "got: $OUT || optout: $OUT_OPTOUT"
  fi
  rm -rf "$T"
}

# Case 31: INBOX_PUSH=1 + stub "pushed" -> reply surfaces "push: pushed".
{
  T=$(mktemp -d); make_inbox "$T" alpha
  STUB=$(make_push_stub "$T" "pushed" 0)
  OUT=$(INBOX_PUSH=1 INBOX_PUSH_BIN="$STUB" run_inbox "$T" alpha reply bob --subject "hi" --body "hello" 2>&1)
  if echo "$OUT" | grep -q "replied to bob" && echo "$OUT" | grep -q "push: pushed"; then
    ok "Case 31: opt-in push -> surfaces pushed verdict"
  else
    fail "Case 31: opt-in push verdict" "got: $OUT"
  fi
  rm -rf "$T"
}

# Case 32: INBOX_PUSH=1 + stub fails (skip:busy rc2) -> send STILL succeeds and
# persists; the failure is reported, not fatal.
{
  T=$(mktemp -d); make_inbox "$T" alpha
  STUB=$(make_push_stub "$T" "skip:busy" 2)
  OUT=$(INBOX_PUSH=1 INBOX_PUSH_BIN="$STUB" run_inbox "$T" alpha reply bob --subject "uniqsubj32" --body "hello" 2>&1)
  THREAD="$T/alpha/inbox/bob.md"
  if echo "$OUT" | grep -q "replied to bob" \
     && echo "$OUT" | grep -q "push: skip:busy (persisted, not pushed)" \
     && grep -q "uniqsubj32" "$THREAD"; then
    ok "Case 32: push failure -> send succeeds + persists + reports skip"
  else
    fail "Case 32: push failure non-fatal" "got: $OUT ; thread exists: $([ -f "$THREAD" ] && echo yes)"
  fi
  rm -rf "$T"
}

# Case 32b: PERSIST HAPPENS BEFORE PUSH, not merely regardless of it.
#
# Case 32 proves a FAILING push still leaves the message on disk. That is the
# weaker half of the guarantee: it would also hold for an implementation that
# pushed first and persisted afterwards, as long as nothing threw in between.
# The ordering is the part that makes "a refused push is never a lost message"
# true under every failure, and reversing the two statements in cmd_reply would
# break it silently and only under conditions nobody exercises by hand.
#
# So this stub does not just report a verdict: it READS THE THREAD FILE while
# the push is in flight and fails if its own message is not already there. Only
# a persist-then-push order can satisfy it.
{
  T=$(mktemp -d); make_inbox "$T" alpha
  STUB="$T/inbox-push-ordering-stub"
  cat > "$STUB" <<STUB
#!/usr/bin/env bash
# \$2 is the pane payload; the thread file is where the record must already be.
if grep -q "uniqbody32b" "$T/alpha/inbox/bob.md" 2>/dev/null; then
  echo "persisted-before-push"
  exit 0
fi
echo "NOT-YET-PERSISTED"
exit 2
STUB
  chmod +x "$STUB"
  OUT=$(INBOX_PUSH=1 INBOX_PUSH_BIN="$STUB" run_inbox "$T" alpha reply bob --subject "s32b" --body "uniqbody32b" 2>&1)
  # BOTH directions. The positive check alone is not enough: an implementation
  # that pushed twice, or that pushed before persisting and again after, would
  # still emit the good line somewhere in the output and satisfy a grep for it.
  # Asserting the bad line is ABSENT is what makes this case able to fail.
  if echo "$OUT" | grep -q "push: persisted-before-push" \
     && ! echo "$OUT" | grep -q "NOT-YET-PERSISTED"; then
    ok "Case 32b: the block is on disk before inbox-push is invoked"
  else
    fail "Case 32b: persist must precede push" "got: $OUT"
  fi
  rm -rf "$T"
}

# Case 33: INBOX_NO_PUSH=1 hard-off overrides INBOX_PUSH=1 -> no push line.
{
  T=$(mktemp -d); make_inbox "$T" alpha
  STUB=$(make_push_stub "$T" "pushed" 0)
  OUT=$(INBOX_PUSH=1 INBOX_NO_PUSH=1 INBOX_PUSH_BIN="$STUB" run_inbox "$T" alpha reply bob --subject "hi" --body "hello" 2>&1)
  if echo "$OUT" | grep -q "replied to bob" && ! echo "$OUT" | grep -q "push:"; then
    ok "Case 33: INBOX_NO_PUSH hard-off overrides opt-in"
  else
    fail "Case 33: INBOX_NO_PUSH override" "got: $OUT"
  fi
  rm -rf "$T"
}

# make_capture_stub <dir> -> a stub that records its msg arg ($2) to <dir>/pushed-msg and exits 0
make_capture_stub() {
  local dir="$1"
  local p="$dir/inbox-push-capture"
  cat > "$p" <<STUB
#!/usr/bin/env bash
printf '%s' "\$2" > "$dir/pushed-msg"
echo "pushed"
exit 0
STUB
  chmod +x "$p"
  echo "$p"
}

# Case 34: full-text-to-pane is the DEFAULT (subject + body); INBOX_PUSH_FULLTEXT=0
# forces the subject-only notification nudge. Both carry the reply hint, which
# points a pane reader back at the inbox thread so the sender gets the answer.
{
  T=$(mktemp -d); make_inbox "$T" alpha
  STUB=$(make_capture_stub "$T")
  # default: full text -- subject + body joined
  INBOX_PUSH_BIN="$STUB" run_inbox "$T" alpha reply bob --subject "hi" --body "the full body here" >/dev/null 2>&1
  DEFAULT_MSG=$(cat "$T/pushed-msg" 2>/dev/null)
  # opt-out: subject-only nudge
  INBOX_PUSH_FULLTEXT=0 INBOX_PUSH_BIN="$STUB" run_inbox "$T" alpha reply bob --subject "hi" --body "the full body here" >/dev/null 2>&1
  OPTOUT_MSG=$(cat "$T/pushed-msg" 2>/dev/null)
  if echo "$DEFAULT_MSG" | grep -q "^\[inbox from alpha\] hi | the full body here  \[reply via inbox: inbox reply alpha\]$" \
     && [ "$OPTOUT_MSG" = "[inbox from alpha] hi  [reply via inbox: inbox reply alpha]" ]; then
    ok "Case 34: full-text default + reply hint; opt-out -> subject nudge + hint"
  else
    fail "Case 34: full-text default + opt-out" "default=[$DEFAULT_MSG] optout=[$OPTOUT_MSG]"
  fi
  rm -rf "$T"
}

# Case 35: full-text default flattens newlines (a raw newline in send-keys -l
# would submit the partial line early) and stays single-line.
{
  T=$(mktemp -d); make_inbox "$T" alpha
  STUB=$(make_capture_stub "$T")
  INBOX_PUSH_BIN="$STUB" run_inbox "$T" alpha reply bob \
    --subject "multi" --body "$(printf 'line one\nline two\n\nline three')" >/dev/null 2>&1
  FULL_MSG=$(cat "$T/pushed-msg" 2>/dev/null)
  LINES=$(printf '%s' "$FULL_MSG" | wc -l)
  if [ "$LINES" -eq 0 ] && echo "$FULL_MSG" | grep -q "line one line two line three"; then
    ok "Case 35: full-text default flattens newlines to a single line"
  else
    fail "Case 35: full-text newline flatten" "lines=$LINES msg=[$FULL_MSG]"
  fi
  rm -rf "$T"
}

# Case 37: over-cap body -> degrade to a NUDGE (no truncated pane dump), keeping
# the subject for triage and the reply hint.
#
# The nudge also SAYS it is truncated and carries a reconcilable count plus the
# read command. The original guarantee is unchanged and still asserted (no
# truncated dump, hint survives); what was added is that a subject-only nudge
# was indistinguishable from a genuinely short message, so the recipient could
# not tell "that is all they wrote" from "there is more".
{
  T=$(mktemp -d); make_inbox "$T" alpha
  STUB=$(make_capture_stub "$T")
  BIG=$(printf 'x%.0s' $(seq 1 2500))   # 2500 chars, over the 1900 cap
  INBOX_PUSH_BIN="$STUB" run_inbox "$T" alpha reply bob --subject "huge" --body "$BIG" >/dev/null 2>&1
  MSG=$(cat "$T/pushed-msg" 2>/dev/null)
  EXP="[inbox from alpha] huge | MESSAGE TOO LONG TO DELIVER IN FULL (2500 chars). Full text: inbox read alpha  [reply via inbox: inbox reply alpha]"
  if [ "$MSG" = "$EXP" ]; then
    ok "Case 37: over-cap body -> marked nudge + reply hint (not truncated dump)"
  else
    fail "Case 37: over-cap nudge" "len=${#MSG} msg=[${MSG:0:60}...]"
  fi
  rm -rf "$T"
}

# Case 38: a structured card (decision-id:) -> subject NUDGE, never prose-dumped,
# and NO reply hint (cards are answered by a tap in the card UI, not `inbox reply`).
{
  T=$(mktemp -d); make_inbox "$T" alpha
  STUB=$(make_capture_stub "$T")
  INBOX_PUSH_BIN="$STUB" run_inbox "$T" alpha reply bob --subject "choose" --body "$(printf 'decision-id: d1\noption-a: yes\noption-b: no')" >/dev/null 2>&1
  MSG=$(cat "$T/pushed-msg" 2>/dev/null)
  if [ "$MSG" = "[inbox from alpha] choose" ]; then
    ok "Case 38: card body -> subject nudge (not prose-dumped)"
  else
    fail "Case 38: card nudge" "msg=[$MSG]"
  fi
  rm -rf "$T"
}

# Case 36: --body-file - reads the body from stdin (no scratch temp file).
{
  T=$(mktemp -d); make_inbox "$T" alpha
  printf 'line A\nline B\n' | INBOX_NO_PUSH=1 run_inbox "$T" alpha reply bob \
    --subject "stdin test" --body-file - >/dev/null 2>&1
  THREAD="$T/alpha/inbox/bob.md"
  if grep -q "stdin test" "$THREAD" && grep -q "line A" "$THREAD" && grep -q "line B" "$THREAD"; then
    ok "Case 36: --body-file - reads body from stdin"
  else
    fail "Case 36: stdin body" "thread: $(cat "$THREAD" 2>/dev/null)"
  fi
  rm -rf "$T"
}

# ===========================================================================
# Attachment-path rewrite for live pane delivery
# ===========================================================================
# These cases run pure-function assertions against inbox's rewrite/resolve
# helpers by importing the (extensionless) script as a module. Each prints the
# function's return value on stdout so the case can diff it.

# Case 39: rewrite_attachment_paths - single markdown image ref rewritten.
{
  OUT=$(python3 - "$INBOX" <<'PY'
import importlib.util, sys
from importlib.machinery import SourceFileLoader
loader = SourceFileLoader("inbox", sys.argv[1])
m = importlib.util.module_from_spec(importlib.util.spec_from_loader("inbox", loader))
loader.exec_module(m)
print(m.rewrite_attachment_paths("![a.png](/attachments/2026-08/a.png)", "/root/assets"))
PY
)
  if [ "$OUT" = "![a.png](/root/assets/2026-08/a.png)" ]; then
    ok "Case 39: rewrite - single attachment ref rewritten"
  else
    fail "Case 39: single attachment rewrite" "got: [$OUT]"
  fi
}

# Case 40: rewrite - multiple refs all rewritten; no-attachment body unchanged;
# prose + non-image link left untouched (conservative match).
{
  OUT=$(python3 - "$INBOX" <<'PY'
import importlib.util, sys
from importlib.machinery import SourceFileLoader
loader = SourceFileLoader("inbox", sys.argv[1])
m = importlib.util.module_from_spec(importlib.util.spec_from_loader("inbox", loader))
loader.exec_module(m)
r = "/root/assets"
print(m.rewrite_attachment_paths("![a](/attachments/f/x/a.png) x ![b](/attachments/g/x/b.png)", r))
print(m.rewrite_attachment_paths("plain body no image", r))
print(m.rewrite_attachment_paths("see /attachments/foo and [n](/attachments/f/x/n.md)", r))
PY
)
  EXP=$(printf '%s\n%s\n%s' \
    "![a](/root/assets/f/x/a.png) x ![b](/root/assets/g/x/b.png)" \
    "plain body no image" \
    "see /attachments/foo and [n](/attachments/f/x/n.md)")
  if [ "$OUT" = "$EXP" ]; then
    ok "Case 40: rewrite - multiple refs; no-op; prose/non-image untouched"
  else
    fail "Case 40: multiple/no-op/prose" "got: [$OUT]"
  fi
}

# Case 41: resolve_attachments_root - the ATTACHMENTS_ROOT env var is the value
# used.
#
# PORT CHANGE. Upstream this case asserted that the env var took PRECEDENCE
# over an .env.production file parsed as a fallback. That fallback was dropped
# in the port (it was coupled to one deployment's filesystem layout), so there
# is nothing left for the env var to win against: the env var is now the single
# source, and that is what is asserted here.
{
  OUT=$(ATTACHMENTS_ROOT=/env/wins python3 - "$INBOX" <<'PY'
import importlib.util, sys
from importlib.machinery import SourceFileLoader
loader = SourceFileLoader("inbox", sys.argv[1])
m = importlib.util.module_from_spec(importlib.util.spec_from_loader("inbox", loader))
loader.exec_module(m)
print(m.resolve_attachments_root())
PY
)
  if [ "$OUT" = "/env/wins" ]; then
    ok "Case 41: resolve - env var supplies the attachments root"
  else
    fail "Case 41: env var resolution" "got: [$OUT]"
  fi
}

# Case 42: resolve_attachments_root - unset or blank env resolves to None, and
# the caller degrades to leaving the text unchanged.
#
# PORT CHANGE. Upstream this case asserted the .env.production PARSING fallback
# (a file supplying ATTACHMENTS_ROOT=, a missing file resolving to None). The
# fallback is gone in the port because it hardcoded one deployment's filesystem
# layout and was the piece least likely to be right anywhere else. What remains
# testable, and what the case now covers, is the OTHER half of the original
# assertion: an unresolvable root yields None rather than a guess or a crash.
{
  OUT=$(env -u ATTACHMENTS_ROOT python3 - "$INBOX" <<'PY'
import importlib.util, sys
from importlib.machinery import SourceFileLoader
loader = SourceFileLoader("inbox", sys.argv[1])
m = importlib.util.module_from_spec(importlib.util.spec_from_loader("inbox", loader))
loader.exec_module(m)
import os
print(m.resolve_attachments_root())
os.environ["ATTACHMENTS_ROOT"] = "   "
print(m.resolve_attachments_root())
PY
)
  EXP=$(printf '%s\n%s' "None" "None")
  if [ "$OUT" = "$EXP" ]; then
    ok "Case 42: resolve - unset and blank env both -> None (no file fallback)"
  else
    fail "Case 42: unset/blank env -> None" "got: [$OUT]"
  fi
}

# Case 43: END-TO-END - an attachment body pushed via `inbox reply` reaches the
# pane payload with the resolved fs path (proves the rewrite is wired into
# maybe_push, before the cap, not just unit-correct).
{
  T=$(mktemp -d); make_inbox "$T" alpha
  STUB=$(make_capture_stub "$T")
  ATTACHMENTS_ROOT=/live/root/assets INBOX_PUSH_BIN="$STUB" \
    run_inbox "$T" alpha reply bob --subject "pic" \
    --body "here it is ![shot.png](/attachments/bob/x/shot.png)" >/dev/null 2>&1
  MSG=$(cat "$T/pushed-msg" 2>/dev/null)
  if echo "$MSG" | grep -qF "/live/root/assets/bob/x/shot.png" \
     && ! echo "$MSG" | grep -qF "/attachments/bob/x/shot.png"; then
    ok "Case 43: end-to-end - pushed payload carries the resolved fs path"
  else
    fail "Case 43: e2e attachment rewrite in payload" "msg=[$MSG]"
  fi
  rm -rf "$T"
}

# Case 44: END-TO-END - a body with NO attachment is pushed byte-identical
# (rewrite is a no-op, no spurious mutation of ordinary messages).
{
  T=$(mktemp -d); make_inbox "$T" alpha
  STUB=$(make_capture_stub "$T")
  ATTACHMENTS_ROOT=/live/root/assets INBOX_PUSH_BIN="$STUB" \
    run_inbox "$T" alpha reply bob --subject "hi" --body "no image here" >/dev/null 2>&1
  MSG=$(cat "$T/pushed-msg" 2>/dev/null)
  if [ "$MSG" = "[inbox from alpha] hi | no image here  [reply via inbox: inbox reply alpha]" ]; then
    ok "Case 44: end-to-end - no-attachment body pushed unchanged"
  else
    fail "Case 44: e2e no-attachment no-op" "msg=[$MSG]"
  fi
  rm -rf "$T"
}

# Case 45: rewrite - path-traversal containment. A ../ escape, a single-.. escape,
# a leading-slash (absolute-segment) escape, and an interior ../../ escape are all
# left COMPLETELY UNCHANGED (never rewritten to a path outside attachments_root).
{
  OUT=$(python3 - "$INBOX" <<'PY'
import importlib.util, sys
from importlib.machinery import SourceFileLoader
loader = SourceFileLoader("inbox", sys.argv[1])
m = importlib.util.module_from_spec(importlib.util.spec_from_loader("inbox", loader))
loader.exec_module(m)
r = "/root/assets"
print(m.rewrite_attachment_paths("![x](/attachments/../../../etc/passwd)", r))
print(m.rewrite_attachment_paths("![x](/attachments/../secret)", r))
print(m.rewrite_attachment_paths("![x](/attachments//../etc/passwd)", r))
print(m.rewrite_attachment_paths("![x](/attachments/shots/../../etc/shadow)", r))
PY
)
  EXP=$(printf '%s\n%s\n%s\n%s' \
    "![x](/attachments/../../../etc/passwd)" \
    "![x](/attachments/../secret)" \
    "![x](/attachments//../etc/passwd)" \
    "![x](/attachments/shots/../../etc/shadow)")
  if [ "$OUT" = "$EXP" ]; then
    ok "Case 45: rewrite - traversal escapes left unchanged (contained)"
  else
    fail "Case 45: traversal containment" "got: [$OUT]"
  fi
}

# Case 46: rewrite - mixed body: a legitimate ref IS rewritten while a co-located
# traversal attempt is left unchanged (per-match reject, not all-or-nothing), and
# a legitimate DEEPLY-nested relPath (no ..) still rewrites correctly.
{
  OUT=$(python3 - "$INBOX" <<'PY'
import importlib.util, sys
from importlib.machinery import SourceFileLoader
loader = SourceFileLoader("inbox", sys.argv[1])
m = importlib.util.module_from_spec(importlib.util.spec_from_loader("inbox", loader))
loader.exec_module(m)
r = "/root/assets"
print(m.rewrite_attachment_paths(
    "ok ![a](/attachments/shots/x/a.png) bad ![b](/attachments/../../root/.ssh/id_rsa)", r))
print(m.rewrite_attachment_paths("![x](/attachments/shots/x/sub/x.png)", r))
PY
)
  EXP=$(printf '%s\n%s' \
    "ok ![a](/root/assets/shots/x/a.png) bad ![b](/attachments/../../root/.ssh/id_rsa)" \
    "![x](/root/assets/shots/x/sub/x.png)")
  if [ "$OUT" = "$EXP" ]; then
    ok "Case 46: rewrite - mixed legit+traversal; deep nested path rewrites"
  else
    fail "Case 46: mixed per-match reject" "got: [$OUT]"
  fi
}

# Case 47: over-cap body -> nudge SAYS it is truncated, with a reconcilable
# count and the read command. A bare subject nudge is indistinguishable from a
# genuinely short message, which is the ambiguity that once silently cost an
# agent 2974 characters of a brief.
{
  T=$(mktemp -d); make_inbox "$T" alpha
  STUB=$(make_capture_stub "$T")
  BIG=$(python3 -c "print('z' * 5000)")
  INBOX_PUSH_BIN="$STUB" run_inbox "$T" alpha reply bob --subject "the brief" --body "$BIG" >/dev/null 2>&1
  MSG=$(cat "$T/pushed-msg" 2>/dev/null)
  case "$MSG" in
    *"MESSAGE TOO LONG TO DELIVER IN FULL (5000 chars)."*"inbox read alpha"*)
      # And it must NOT carry the body.
      case "$MSG" in
        *zzzzzzzzzz*) fail "Case 47: over-cap nudge leaked body text" "msg=[$MSG]" ;;
        *) ok "Case 47: over-cap body -> marked nudge with reconcilable count" ;;
      esac
      ;;
    *) fail "Case 47: over-cap marker missing" "msg=[$MSG]" ;;
  esac
  rm -rf "$T"
}

# Case 48: the marker is scoped to the OVER-CAP case only. A card still gets the
# plain subject nudge: its body is card metadata answered by a tap in the card
# UI, not a truncated message, so labelling it "too long" would be a lie.
{
  T=$(mktemp -d); make_inbox "$T" alpha
  STUB=$(make_capture_stub "$T")
  INBOX_PUSH_BIN="$STUB" run_inbox "$T" alpha reply bob --subject "choose" --body "$(printf 'decision-id: d1\noption-a: yes\noption-b: no')" >/dev/null 2>&1
  MSG=$(cat "$T/pushed-msg" 2>/dev/null)
  if [ "$MSG" = "[inbox from alpha] choose" ]; then
    ok "Case 48: card nudge unaffected by the over-cap marker"
  else
    fail "Case 48: card nudge changed" "msg=[$MSG]"
  fi
  rm -rf "$T"
}

# Case 49: a short message is still delivered whole and carries NO marker, so
# the marker cannot be read as boilerplate.
{
  T=$(mktemp -d); make_inbox "$T" alpha
  STUB=$(make_capture_stub "$T")
  INBOX_PUSH_BIN="$STUB" run_inbox "$T" alpha reply bob --subject "quick" --body "all fine here" >/dev/null 2>&1
  MSG=$(cat "$T/pushed-msg" 2>/dev/null)
  case "$MSG" in
    *"TOO LONG"*) fail "Case 49: short message wrongly marked" "msg=[$MSG]" ;;
    *"all fine here"*) ok "Case 49: short message delivered whole, unmarked" ;;
    *) fail "Case 49: short message body missing" "msg=[$MSG]" ;;
  esac
  rm -rf "$T"
}

# ---------------------------------------------------------------------------
# Context-gate carve-out: handover and compaction messages must always get
# through, even to an agent over its context ceiling. Tested END-TO-END through
# `inbox reply`, not just at inbox-push's private env var: an exemption with no
# caller is a claim, not a feature.
# ---------------------------------------------------------------------------

# make_env_stub <dir> -> stub that reports whether the exemption env var reached it
make_env_stub() {
  local dir="$1" p
  # NOT a combined `local dir="$1" p="$dir/..."`: bash expands every word of a
  # `local` before executing it, so $dir is still unset there under `set -u`.
  p="$dir/inbox-push-envstub"
  cat > "$p" <<'STUB'
#!/usr/bin/env bash
echo "allow=${INBOX_PUSH_ALLOW_CTX_OVER:-unset}"
exit 0
STUB
  chmod +x "$p"
  echo "$p"
}

# Case 50: the flag reaches the send path; its absence leaves the var unset.
{
  T=$(mktemp -d); make_inbox "$T" alpha
  STUB=$(make_env_stub "$T")
  OUT_ON=$(INBOX_PUSH_BIN="$STUB" run_inbox "$T" alpha reply bob --subject "h" --body "b" --allow-when-full 2>&1)
  OUT_OFF=$(INBOX_PUSH_BIN="$STUB" run_inbox "$T" alpha reply bob --subject "h" --body "b" 2>&1)
  if echo "$OUT_ON" | grep -q "allow=1" && echo "$OUT_OFF" | grep -q "allow=unset"; then
    ok "Case 50: --allow-when-full reaches inbox-push; absent by default"
  else
    fail "Case 50: exemption flag propagation" "on: $OUT_ON || off: $OUT_OFF"
  fi
  rm -rf "$T"
}

# Case 51: END-TO-END through the REAL inbox-push against a 92% pane.
# This is the case that proves the carve-out actually works in production, rather
# than only when a test sets inbox-push's private state directly.
{
  T=$(mktemp -d); make_inbox "$T" alpha
  REAL_PUSH="$BIN_DIR/inbox-push"
  FULL_PANE=$'some transcript output\n\n> \n  bob │ Opus 5 │ ~/agents/bob │ █████████░ 92%'
  OUT_BLOCKED=$(PANE_OVERRIDE="$FULL_PANE" INBOX_PUSH_BIN="$REAL_PUSH" \
    run_inbox "$T" alpha reply bob --subject "routine" --body "b" 2>&1)
  OUT_EXEMPT=$(PANE_OVERRIDE="$FULL_PANE" INBOX_PUSH_BIN="$REAL_PUSH" \
    run_inbox "$T" alpha reply bob --subject "compact" --body "b" --allow-when-full 2>&1)
  if echo "$OUT_BLOCKED" | grep -q "skip:ctx-over" \
     && ! echo "$OUT_EXEMPT" | grep -q "skip:ctx-over" \
     && echo "$OUT_BLOCKED" | grep -q "replied to bob" \
     && echo "$OUT_EXEMPT" | grep -q "replied to bob"; then
    ok "Case 51: end-to-end -- 92% blocks a routine reply, --allow-when-full delivers"
  else
    fail "Case 51: end-to-end carve-out" "blocked: $OUT_BLOCKED || exempt: $OUT_EXEMPT"
  fi
  rm -rf "$T"
}

# ---------------------------------------------------------------------------
# Case 52: a markdown heading INSIDE a message body must not truncate it.
#
# Found in live use: block boundaries came off every column-0
# "## " line, not only lines that actually parse as a header. A message
# containing a markdown heading -- ordinary content, we all write in markdown
# -- ended its own block early and everything after the heading vanished from
# the rendered body. No error, no gap: the bytes stayed on disk and the
# reader simply never showed them. Reproduced live against this file's own
# inbox: a real message was severed at its own embedded example
# and the remainder rendered as a second message from a sender who does not
# exist.
#
# Ported with the fix from the implementation bin/inbox was copied from, where
# it was written and reviewed first. Corpus case body-markdown-heading states
# the same defect against docs/protocol.md, for both readers at once.
# ---------------------------------------------------------------------------
{
  T=$(mktemp -d)
  make_inbox "$T" "alpha"

  write_thread "$T" "alpha" "beta" "## 2026-01-01T10:00:00Z - from: beta - status: sent - subject: test

Here is my message.

## A markdown heading someone typed

This trailing paragraph is AFTER the heading and must survive." > /dev/null

  OUT=$(run_inbox "$T" "alpha" read beta 2>&1)
  # Review: the previous negative assertion here checked for
  # "from: alice", a string this fixture never contains regardless of the parser,
  # so it could not fail and was testing nothing. The real invariant is that a
  # malformed heading must not split the message into a second block at all --
  # exactly one "from:" line, not two.
  from_lines=$(echo "$OUT" | grep -c "^from ")
  if echo "$OUT" | grep -q "must survive" && [ "$from_lines" -eq 1 ]; then
    ok "Case 52: a body heading does not truncate the message or split it into a second block"
  else
    fail "Case 52: markdown heading in body" "from-lines=$from_lines :: $OUT"
  fi
  rm -rf "$T"
}

# ===========================================================================
# Cases 53-59: the card-metadata YAML hard stop.
#
# `bin/inbox` refuses to send a body whose metadata region is not valid YAML.
# The reason it is a REFUSAL and not a warning is that the failure is silent
# downstream: an unquoted colon inside a label or detail value is read as a
# nested mapping, the parse breaks, the renderer degrades the block to plain
# prose, and its re-serialiser locks it in that shape. The sender sees
# "replied to ..." and has no way to learn otherwise. The write is the only
# point at which it is catchable, so these cases assert the two halves
# together every time: non-zero exit AND nothing on disk.
# ===========================================================================

# ---------------------------------------------------------------------------
# Case 53: unquoted colon in a top-level detail field -> refused, and the
#          thread file is never even created.
# ---------------------------------------------------------------------------
{
  T=$(mktemp -d)
  make_inbox "$T" "alpha"

  CARD_BODY="decision-id: test-53
detail: Ship it: today
lean: A"

  # set +e around every expected-refusal call in this file: errexit is on from
  # case 14 onward, and a non-zero exit from a case that is TESTING a non-zero
  # exit would otherwise end the run rather than record a result.
  set +e
  OUT=$(INBOX_NO_PUSH=1 run_inbox "$T" "alpha" reply beta --subject "card-53" --body "$CARD_BODY" 2>&1)
  RC=$?
  set -e

  THREAD="$T/alpha/inbox/beta.md"
  if [ "$RC" -eq 0 ]; then
    fail "Case 53: colon-in-detail card was accepted" "exit 0, out: $OUT"
  elif [ -e "$THREAD" ]; then
    fail "Case 53: refused but wrote a thread file anyway" "$(cat "$THREAD")"
  elif echo "$OUT" | grep -q "does not parse as valid YAML"; then
    ok "Case 53: unquoted colon in detail -> refused, nothing written"
  else
    fail "Case 53: refused with the wrong message" "out: $OUT"
  fi
  rm -rf "$T"
}

# ---------------------------------------------------------------------------
# Case 54: the same defect nested inside an options list (label:), against an
#          EXISTING thread. Asserts the stronger property that case 53 cannot:
#          the file is byte-identical afterwards, so the refusal did not
#          append a partial or de-carded block.
# ---------------------------------------------------------------------------
{
  T=$(mktemp -d)
  make_inbox "$T" "alpha"

  TPATH=$(write_thread "$T" "alpha" "beta" "## 2026-01-01T09:00:00Z - from: beta - status: read - subject: earlier

Something already in the thread.")

  BEFORE=$(cksum < "$TPATH")

  CARD_BODY="decision-id: test-54
options:
  - key: A
    label: Ship it: now
  - key: B
    label: Hold
lean: A"

  set +e
  OUT=$(INBOX_NO_PUSH=1 run_inbox "$T" "alpha" reply beta --subject "card-54" --body "$CARD_BODY" 2>&1)
  RC=$?
  set -e

  AFTER=$(cksum < "$TPATH")
  if [ "$RC" -eq 0 ]; then
    fail "Case 54: colon-in-label card was accepted" "exit 0, out: $OUT"
  elif [ "$BEFORE" != "$AFTER" ]; then
    fail "Case 54: refused but the thread file changed" "before=$BEFORE after=$AFTER"
  else
    ok "Case 54: colon nested in an options label -> refused, thread byte-identical"
  fi
  rm -rf "$T"
}

# ---------------------------------------------------------------------------
# Case 55: the check is not over-broad. The SAME value, quoted, is legal YAML
#          and must go through and still parse as a card. Without this case a
#          guard that rejected every card would score as a pass on 53 and 54.
# ---------------------------------------------------------------------------
{
  T=$(mktemp -d)
  make_inbox "$T" "alpha"

  CARD_BODY='decision-id: test-55
detail: "Ship it: today"
lean: A'

  INBOX_NO_PUSH=1 run_inbox "$T" "alpha" reply beta --subject "card-55" --body "$CARD_BODY" > /dev/null 2>&1
  RC=$?

  THREAD="$T/alpha/inbox/beta.md"
  RESULT=$(check_card_parses "$THREAD")
  if [ "$RC" -ne 0 ]; then
    fail "Case 55: quoted colon was rejected" "exit $RC"
  elif [ "$RESULT" = "CARD" ]; then
    ok "Case 55: quoted colon -> accepted and still parses as a card"
  else
    fail "Case 55: quoted-colon card did not parse as card" "parser said: $RESULT"
  fi
  rm -rf "$T"
}

# ---------------------------------------------------------------------------
# Case 56: validate_card_metadata rejects a region carrying NEITHER
#          decision-id nor action-id.
#
# Driven as a pure function rather than through `reply`, deliberately and not
# for convenience: `cmd_reply` only calls the validator for a body that
# already begins with one of those two keys, so that branch is unreachable
# from the CLI and an end-to-end case claiming to cover it would be testing
# the is_card gate instead. The branch exists for any other caller of the
# validator; this is the only honest way to hold it.
# ---------------------------------------------------------------------------
{
  set +e
  OUT=$(python3 - "$INBOX" <<'PY' 2>&1
import importlib.util, sys
from importlib.machinery import SourceFileLoader
loader = SourceFileLoader("inbox", sys.argv[1])
m = importlib.util.module_from_spec(importlib.util.spec_from_loader("inbox", loader))
loader.exec_module(m)
print(m.validate_card_metadata("subject-id: x\nlean: A") or "NONE")
PY
)
  set -e
  if echo "$OUT" | grep -q "missing both decision-id and action-id"; then
    ok "Case 56: metadata region with neither id -> rejected by validate_card_metadata"
  else
    fail "Case 56: no-id region was not rejected" "got: $OUT"
  fi
}

# ---------------------------------------------------------------------------
# Case 57: validate_card_metadata rejects a region that parses to something
#          other than a mapping, and ACCEPTS a well-formed one. Both in one
#          case so the negative cannot pass by rejecting everything.
# ---------------------------------------------------------------------------
{
  set +e
  OUT=$(python3 - "$INBOX" <<'PY' 2>&1
import importlib.util, sys
from importlib.machinery import SourceFileLoader
loader = SourceFileLoader("inbox", sys.argv[1])
m = importlib.util.module_from_spec(importlib.util.spec_from_loader("inbox", loader))
loader.exec_module(m)
print("SCALAR:", m.validate_card_metadata("just a bare scalar") or "NONE")
print("VALID:", m.validate_card_metadata("decision-id: x\nlean: A") or "NONE")
PY
)
  SCALAR_LINE=$(echo "$OUT" | grep "^SCALAR:")
  VALID_LINE=$(echo "$OUT" | grep "^VALID:")
  set -e
  if ! echo "$SCALAR_LINE" | grep -q "did not parse to a mapping"; then
    fail "Case 57: non-mapping region was not rejected" "got: $SCALAR_LINE"
  elif [ "$VALID_LINE" != "VALID: NONE" ]; then
    fail "Case 57: a valid region was rejected" "got: $VALID_LINE"
  else
    ok "Case 57: non-mapping region rejected, valid region accepted"
  fi
}

# ---------------------------------------------------------------------------
# Case 58: PyYAML absent -> a CARD send is refused (never sent unchecked), and
#          nothing is written.
#
# The import is defeated with a shadowing yaml.py on PYTHONPATH that raises
# ImportError, which is the same thing the interpreter does when the package
# genuinely is not installed. This is the environment a stock python3 with no
# pip installs is actually in, so it is the default for a stranger rather
# than an exotic case.
# ---------------------------------------------------------------------------
{
  T=$(mktemp -d)
  SHIM=$(mktemp -d)
  make_inbox "$T" "alpha"
  printf 'raise ImportError("PyYAML is not installed")\n' > "$SHIM/yaml.py"

  set +e
  OUT=$(PYTHONPATH="$SHIM" INBOX_NO_PUSH=1 run_inbox "$T" "alpha" reply beta \
          --subject "card-58" --body "decision-id: test-58
lean: A" 2>&1)
  RC=$?
  set -e

  THREAD="$T/alpha/inbox/beta.md"
  if [ "$RC" -eq 0 ]; then
    fail "Case 58: card sent unchecked with PyYAML absent" "exit 0, out: $OUT"
  elif [ -e "$THREAD" ]; then
    fail "Case 58: refused but wrote a thread file" "$(cat "$THREAD")"
  elif echo "$OUT" | grep -q "PyYAML"; then
    ok "Case 58: PyYAML absent -> card refused by name, nothing written"
  else
    fail "Case 58: refused without naming the missing dependency" "out: $OUT"
  fi
  rm -rf "$T" "$SHIM"
}

# ---------------------------------------------------------------------------
# Case 59: PyYAML absent -> a PLAIN body still sends. The dependency is scoped
#          to the card check alone, which is what lets the README keep saying
#          this CLI needs python3 and nothing else for ordinary use.
# ---------------------------------------------------------------------------
{
  T=$(mktemp -d)
  SHIM=$(mktemp -d)
  make_inbox "$T" "alpha"
  printf 'raise ImportError("PyYAML is not installed")\n' > "$SHIM/yaml.py"

  OUT=$(PYTHONPATH="$SHIM" INBOX_NO_PUSH=1 run_inbox "$T" "alpha" reply beta \
          --subject "plain-59" --body "ordinary prose, no metadata region" 2>&1)
  RC=$?

  THREAD="$T/alpha/inbox/beta.md"
  if [ "$RC" -ne 0 ]; then
    fail "Case 59: plain reply failed with PyYAML absent" "exit $RC, out: $OUT"
  elif grep -q "ordinary prose" "$THREAD" 2>/dev/null; then
    ok "Case 59: PyYAML absent -> an ordinary prose reply still sends"
  else
    fail "Case 59: plain reply did not reach the thread file" "out: $OUT"
  fi
  rm -rf "$T" "$SHIM"
}

# ===========================================================================
# Cases 60-66: the bare-reference check.
#
# Refuses to send a message carrying an issue or change-request id that is not
# inside a markdown link, so a reader gets something they can follow rather
# than a token they have to go and look up. OFF unless a pattern is
# configured, because this tool cannot know whether the person running it has
# a tracker, or what its ids look like.
#
# REF_PAT below is the shape the deployment this was ported from uses,
# rewritten in invented conventions: a change-request sigil and a
# project-prefixed ticket id. It is a test fixture, not a default.
# ===========================================================================
REF_PAT='!\d+|(?<![A-Za-z0-9])ENG-\d+'

# ---------------------------------------------------------------------------
# Case 60: OFF by default. With no pattern configured, a body that is nothing
#          but bare references sends normally.
#
# This is the case that keeps the feature honest for a stranger: a public tool
# that started refusing messages over one deployment's ticket syntax would be
# a bug, not a guard.
# ---------------------------------------------------------------------------
{
  T=$(mktemp -d)
  make_inbox "$T" "alpha"

  OUT=$(INBOX_NO_PUSH=1 run_inbox "$T" "alpha" reply beta --subject "ENG-1 and !2" \
          --body "see ENG-793 and !856" 2>&1)
  RC=$?

  THREAD="$T/alpha/inbox/beta.md"
  if [ "$RC" -ne 0 ]; then
    fail "Case 60: unconfigured check refused a send" "exit $RC, out: $OUT"
  elif grep -q "ENG-793" "$THREAD" 2>/dev/null; then
    ok "Case 60: bare-ref check is off unless configured"
  else
    fail "Case 60: message did not reach the thread file" "out: $OUT"
  fi
  rm -rf "$T"
}

# ---------------------------------------------------------------------------
# Case 61: configured + bare ref in the BODY -> refused, nothing written.
# ---------------------------------------------------------------------------
{
  T=$(mktemp -d)
  make_inbox "$T" "alpha"

  set +e
  OUT=$(INBOX_BARE_REF_PATTERN="$REF_PAT" INBOX_NO_PUSH=1 \
          run_inbox "$T" "alpha" reply beta --subject "status" \
          --body "picked this up from ENG-793 this morning" 2>&1)
  RC=$?
  set -e

  THREAD="$T/alpha/inbox/beta.md"
  if [ "$RC" -eq 0 ]; then
    fail "Case 61: bare body reference was accepted" "exit 0, out: $OUT"
  elif [ -e "$THREAD" ]; then
    fail "Case 61: refused but wrote a thread file" "$(cat "$THREAD")"
  elif echo "$OUT" | grep -q "bare reference 'ENG-793'"; then
    ok "Case 61: bare reference in body -> refused by name, nothing written"
  else
    fail "Case 61: refused with the wrong message" "out: $OUT"
  fi
  rm -rf "$T"
}

# ---------------------------------------------------------------------------
# Case 62: configured + the SAME ref properly linked -> sends.
#
# The pass-through half of case 61, and the case that actually exercises the
# implementation's strategy: markdown link spans are stripped before the scan,
# so a ref inside [text](url) never reaches it. A guard that simply searched
# the raw text would fail here while passing 61.
# ---------------------------------------------------------------------------
{
  T=$(mktemp -d)
  make_inbox "$T" "alpha"

  OUT=$(INBOX_BARE_REF_PATTERN="$REF_PAT" INBOX_NO_PUSH=1 \
          run_inbox "$T" "alpha" reply beta --subject "status" \
          --body "picked up [ENG-793](https://tracker.example/ENG-793) this morning" 2>&1)
  RC=$?

  THREAD="$T/alpha/inbox/beta.md"
  if [ "$RC" -ne 0 ]; then
    fail "Case 62: a correctly linked reference was refused" "exit $RC, out: $OUT"
  elif grep -q "tracker.example/ENG-793" "$THREAD" 2>/dev/null; then
    ok "Case 62: a reference inside a markdown link passes through"
  else
    fail "Case 62: linked message did not reach the thread file" "out: $OUT"
  fi
  rm -rf "$T"
}

# ---------------------------------------------------------------------------
# Case 63: the SUBJECT is checked too, not only the body. A subject is the
#          half a reader sees in a list view, so a bare id there is exactly
#          the unfollowable reference this exists to stop.
# ---------------------------------------------------------------------------
{
  T=$(mktemp -d)
  make_inbox "$T" "alpha"

  set +e
  OUT=$(INBOX_BARE_REF_PATTERN="$REF_PAT" INBOX_NO_PUSH=1 \
          run_inbox "$T" "alpha" reply beta --subject "!856 is ready" \
          --body "no references in this body at all" 2>&1)
  RC=$?
  set -e

  THREAD="$T/alpha/inbox/beta.md"
  if [ "$RC" -eq 0 ]; then
    fail "Case 63: bare subject reference was accepted" "exit 0, out: $OUT"
  elif [ -e "$THREAD" ]; then
    fail "Case 63: refused but wrote a thread file" "$(cat "$THREAD")"
  elif echo "$OUT" | grep -q "subject to beta contains a bare reference"; then
    ok "Case 63: bare reference in subject -> refused, and the field is named"
  else
    fail "Case 63: refused with the wrong message" "out: $OUT"
  fi
  rm -rf "$T"
}

# ---------------------------------------------------------------------------
# Case 64: INBOX_BARE_REF_TO narrows the audience. The identical message is
#          refused to a listed correspondent and accepted for an unlisted one.
#
# Both halves in one case on purpose: either alone is satisfied by a check
# that is simply always on, or always off.
# ---------------------------------------------------------------------------
{
  T=$(mktemp -d)
  make_inbox "$T" "alpha"

  BODY="have a look at !856"

  set +e
  OUT_LISTED=$(INBOX_BARE_REF_PATTERN="$REF_PAT" INBOX_BARE_REF_TO="beta,gamma" \
    INBOX_NO_PUSH=1 run_inbox "$T" "alpha" reply beta --subject "s" --body "$BODY" 2>&1)
  RC_LISTED=$?

  OUT_OTHER=$(INBOX_BARE_REF_PATTERN="$REF_PAT" INBOX_BARE_REF_TO="beta,gamma" \
    INBOX_NO_PUSH=1 run_inbox "$T" "alpha" reply delta --subject "s" --body "$BODY" 2>&1)
  RC_OTHER=$?
  set -e

  if [ "$RC_LISTED" -eq 0 ]; then
    fail "Case 64: listed correspondent was not checked" "out: $OUT_LISTED"
  elif [ "$RC_OTHER" -ne 0 ]; then
    fail "Case 64: unlisted correspondent was checked anyway" "out: $OUT_OTHER"
  elif [ -e "$T/alpha/inbox/beta.md" ]; then
    fail "Case 64: refused send still wrote a thread file"
  elif grep -q "!856" "$T/alpha/inbox/delta.md" 2>/dev/null; then
    ok "Case 64: INBOX_BARE_REF_TO scopes the check to the named correspondents"
  else
    fail "Case 64: allowed message did not reach the unlisted thread" "out: $OUT_OTHER"
  fi
  rm -rf "$T"
}

# ---------------------------------------------------------------------------
# Case 65: an INBOX_BARE_REF_PATTERN that does not compile is a hard error,
#          not a silently skipped check.
#
# A typo that turned the guard off would leave every message looking as though
# it had passed, which is the same silent-success shape the guard exists to
# remove.
# ---------------------------------------------------------------------------
{
  T=$(mktemp -d)
  make_inbox "$T" "alpha"

  set +e
  OUT=$(INBOX_BARE_REF_PATTERN='!(\d+' INBOX_NO_PUSH=1 \
          run_inbox "$T" "alpha" reply beta --subject "s" --body "nothing suspicious" 2>&1)
  RC=$?
  set -e

  THREAD="$T/alpha/inbox/beta.md"
  if [ "$RC" -eq 0 ]; then
    fail "Case 65: an uncompilable pattern silently allowed the send" "out: $OUT"
  elif [ -e "$THREAD" ]; then
    fail "Case 65: refused but wrote a thread file" "$(cat "$THREAD")"
  elif echo "$OUT" | grep -q "INBOX_BARE_REF_PATTERN is not a valid"; then
    ok "Case 65: an uncompilable pattern is a hard error naming the variable"
  else
    fail "Case 65: refused with the wrong message" "out: $OUT"
  fi
  rm -rf "$T"
}

# ---------------------------------------------------------------------------
# Case 66: link-stripping is per-occurrence, not whole-message. A body holding
#          the same ref twice, once linked and once bare, is still refused.
#
# The failure this pins: a guard that gave up as soon as it saw one link, or
# that stripped only the first span, would pass case 62 and let the real
# mistake through here. Bare-in-the-same-body is also the shape the mistake
# actually takes, since it comes from writing a second mention in a hurry.
# ---------------------------------------------------------------------------
{
  T=$(mktemp -d)
  make_inbox "$T" "alpha"

  set +e
  OUT=$(INBOX_BARE_REF_PATTERN="$REF_PAT" INBOX_NO_PUSH=1 \
          run_inbox "$T" "alpha" reply beta --subject "s" \
          --body "opened [!856](https://forge.example/mr/856), which supersedes !412" 2>&1)
  RC=$?
  set -e

  THREAD="$T/alpha/inbox/beta.md"
  if [ "$RC" -eq 0 ]; then
    fail "Case 66: a second, bare reference slipped past a linked one" "out: $OUT"
  elif [ -e "$THREAD" ]; then
    fail "Case 66: refused but wrote a thread file" "$(cat "$THREAD")"
  elif echo "$OUT" | grep -q "bare reference '!412'"; then
    ok "Case 66: a bare ref alongside a linked one is still caught, and named"
  else
    fail "Case 66: refused with the wrong message" "out: $OUT"
  fi
  rm -rf "$T"
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "Results: $PASS passed, $FAIL failed"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
