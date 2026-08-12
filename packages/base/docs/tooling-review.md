# Tooling review

Status of the scripts behind the pattern this repo describes: which are
ported, which are reviewed-only, and why.

## Ported: `bin/workspace.sh`, `bin/boot-agents.sh`

Both are tmux orchestration: resume or launch one window per agent, handle a
couple of optional runtime integrations, stay idempotent. No concurrency-
correctness properties to preserve, so porting them was genuinely mechanical:
parameterise the one hardcoded path assumption (`AGENTS_HOME`, defaulting to
`~/agents` to match `templates/`), and replace a hardcoded list of which
agents get their watcher auto-armed with a per-agent marker file
(`.auto-arm-watcher`), consistent with the marker-file convention the scripts
already use for runtime/model overrides.

One simplification made deliberately, not by oversight: the source scripts
carry real integration code for two additional non-Claude runtimes, each with
its own hard-won env-var and timing quirks specific to those tools. That's
implementation detail for specific third-party CLIs, not part of the
persona/identity pattern this repo is about, so it's dropped here in favour of
a generic "any other runtime" branch with a comment on the general principle
(some runtimes need env vars set before the process starts, not just
hook-declared). If you need one of those integrations, treat it as a
runtime-specific extension, not core.

## Ported, with tests: `bin/inbox`

This is the actual inbox DM protocol implementation, the concrete counterpart
to the description in `SYSTEM.md`. It carries real concurrency-correctness
properties: a cross-process advisory lock (so a CLI send and a concurrent
rewrite from elsewhere don't clobber each other) and an in-place byte-offset
patch for flipping a message's status without rewriting the whole file.
Porting that kind of code without a test suite landing in the same pass would
be the same mistake as shipping a redacted copy of a live document: it looks
finished and might not be. So the port and `tests/` shipped together, not one
before the other.

What changed from the internal source, concretely:

1. **Two hardcoded paths that assumed a specific team's other
   infrastructure are now configurable.** The inbox root is `$SILO_HOME/<name>/inbox`
   (`SILO_HOME` defaults to `~/.agent-silo`). The attachments-root feature
   (below) is now purely `ATTACHMENTS_ROOT`-env-driven, no file-parsing
   fallback that assumed a specific sibling product's config file existed.
2. **The attachment-path rewrite is still here but fully optional.** It
   rewrites a web-relative `/attachments/...` image link to a real filesystem
   path, useful if you build a companion app that serves images over HTTP and
   also want a terminal-pane push to be able to open them locally. Off by
   default (no-op unless `ATTACHMENTS_ROOT` is set); its path-traversal
   containment guard is preserved exactly, since that's a real security
   property worth keeping regardless of whether you use the feature.
3. **Every comment was rewritten to keep the technical rationale and drop
   the names, dates, and specific incidents** that motivated a given design
   choice internally. The reasoning survives; the internal history doesn't.
4. **The companion live-wake script (`inbox-push`) is still out of scope.**
   The CLI already degrades gracefully without it (checks the configured
   binary exists via `INBOX_PUSH_BIN`, no-ops if not), so sending and reading
   messages works with just this file. A way to nudge a long-running
   recipient process the moment a message lands is a real, separate piece of
   work, not required for the protocol itself.
5. **Tests**: `tests/inbox.test.ts` covers identity resolution, header
   parsing across all three accepted separator forms, em-dash rejection, the
   card-metadata blank-line logic, and the attachment rewrite (including the
   path-traversal rejection). `tests/concurrency.test.ts` is a genuine stress
   test: real OS subprocesses, not worker threads in one process, hammering
   the same thread file concurrently, verifying every message survives intact
   with none lost, corrupted, or duplicated. Vitest, a dev dependency only.

### Language: Python to TypeScript

The original was Python 3, stdlib only. It is now `bin/inbox.mts`: TypeScript
with no runtime dependencies, run directly by Node's native type stripping
with no build step. The on-disk format, the header regex, the lock protocol
and every command's output are unchanged, and the port was checked against the
Python original byte for byte on the same inputs, including the file contents
after a status flip.

Node's standard library covers everything Python's did, but four places needed
a deliberate equivalent rather than a translation. Each is commented in the
source at the point it matters:

- **The lock's backoff sleep.** Python's `time.sleep` has no synchronous
  equivalent in Node. `Atomics.wait` on a throwaway `SharedArrayBuffer` is the
  only stdlib way to block the thread, and blocking is required here: an
  `await` would let other work interleave inside the critical section.
- **Path containment for the attachment rewrite.** `node:path`'s `posix.join`
  does NOT match `posixpath.join`: an absolute second argument replaces the
  first in Python but is appended in Node. A body containing
  `/attachments//etc/passwd` would therefore have been judged "inside the
  root" and rewritten, defeating the traversal guard. Python's `join` and
  `normpath` are reimplemented rather than approximated.
- **Character counts.** The "message too long" notice reports a length. Python
  counted code points; `String.length` counts UTF-16 code units, which is one
  higher per emoji. The port counts code points, so the number a recipient
  sees is unchanged. Code points is now stated in the source as the reference
  definition for anyone building a second implementation of this protocol.
- **Writing to stdout before exiting.** Node's `process.stdout` is
  asynchronous when it is a pipe, so a `console.log` immediately followed by
  `process.exit` can vanish. Every write goes through `fs.writeSync` on the
  raw file descriptor instead, which is synchronous everywhere.

One behaviour was deliberately NOT preserved, because it was a bug. The status
flip located the `sent` token with a loose `status:\s*(sent)` search of the
header line. That takes the FIRST match, and `from:` precedes `status:` in the
grammar, so a correspondent named `status:sentinel` matched inside the SENDER
field. Verifying the four bytes before overwriting did not catch it: those
bytes genuinely spell `sent`, so the check passed on the wrong occurrence. The
flip rewrote the sender to `status:readinel` and left the real status at
`sent`, corrupting the file and leaving the message permanently unread. The
port derives the offset from the header grammar's own `status` capture group
instead, which makes the whole class impossible rather than unlikely. Every
other input, well-formed or malformed, behaves exactly as before.

Worth being precise about how bad that was, because the honest version is a
better argument than the alarming one: it was not reachable in practice.
Senders are written from `AGENT_NAME`, which is constrained to lowercase
alphanumerics and hyphens, so no valid agent name could contain a colon. The
reason to fix it anyway is that the only thing standing between the loose
pattern and a corrupted file was a naming convention enforced in a different
system from the one doing the write, and a header written by any other tool
against this format is under no obligation to honour it.

### Known behaviour carried across deliberately, bugs included

Parity was the brief, and a port that quietly improves semantics is a port you
can no longer differential-test against the original. Two known defects were
therefore reproduced rather than fixed, and are recorded here rather than left
to be rediscovered:

- **`read` prints, then flips.** The status flip re-reads the file under the
  lock and re-derives which blocks are unread, so a block that arrives between
  the print loop and the flip is marked read without ever being displayed. The
  message is not lost, which is what makes it nasty: it looks like it was
  already handled.
- **The initial read takes no lock at all,** so a concurrent append can be
  parsed mid-write. Same function, second way in.

These compound: the window is the whole print loop, so it widens with the
unread backlog, and a large catch-up read is exactly when someone else is most
likely to be writing. Fixing the first is cheap (flip by the identity of what
was actually printed rather than by re-deriving the predicate), but it is a
behaviour change and belongs in its own commit, with its own tests, on the
other side of the port.

Malformed history is tolerated, never repaired. A column-0 `## ` line that is
not a valid header (a markdown heading inside a message body, or a
header-shaped artefact from an older writer) is skipped, exactly as the Python
skipped it, and is never rewritten, normalised or "fixed". Only the four
status bytes of a matched block are ever written, and writes always resolve
`realpath` first and mutate in place, so a symlinked thread file stays a
symlink.
