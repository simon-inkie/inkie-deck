# Agent inbox protocol

**Version:** 0.1 (draft)
**Status:** proposed. Not yet frozen. Breaking changes are still possible until 1.0.

This document is normative. It defines the on-disk format and the behaviour an
implementation must exhibit to interoperate. `bin/inbox.mts` in this repository
is *a* conforming implementation and is not itself the specification: where the
two disagree, one of them is a bug, and this document says which.

`SYSTEM.md` describes conventions for a team of agents and is not normative.
It is an example of a document that happens to use this protocol.

## 1. Terminology

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are used as in
RFC 2119.

- **Participant**: a named correspondent. A participant MAY be a human, an
  automated agent, or any other process.
- **Thread**: the complete ordered exchange between exactly two participants.
- **Message**: one immutable entry in a thread, plus its mutable delivery state.
- **Writer**: any process that appends a message or updates delivery state.
- **Reader**: any process that parses a thread.

## 2. Why the format is what it is

Two properties drive every decision below, and an implementation that
sacrifices either is not conforming even if it parses correctly.

**Concurrent writers are the normal case, not an edge case.** Several agents,
a scheduler, a UI and a human may write to the same thread at the same moment.
The format is append-only so that the common write is a single positional
append that cannot lose a concurrent one.

**The file is the interface.** There is no daemon and no database. Anything
that can append a line to a file can participate, in any language, with no
dependency on this implementation. That is the whole point of the design, and
it is why the format is plain text a human can read and repair by hand.

## 3. Storage layout

An implementation MUST be able to locate a thread from a pair of participant
names. The layout below is RECOMMENDED and is what the reference
implementation uses:

```
<root>/<owner>/inbox/<correspondent>.md
```

The following are conventions, not requirements. An implementation MUST NOT
assume any of them are true of a thread handed to it:

- the file extension `.md`
- one file per correspondent pair
- any particular root, home directory, or directory depth
- a central registry, roster, or configuration file listing participants

A thread file MAY be a symbolic link. See section 8.4.

Participant names are opaque to this protocol. An implementation MAY impose its
own constraints on them, and if it does it MUST NOT rely on another system
enforcing those constraints for correctness (see section 8.3).

## 4. Thread file structure

A thread file is a sequence of **blocks**. A block begins at a line that starts
with `## ` at column 0, and continues until the line before the next such line,
or end of file.

A line beginning with `## ` that does not match the header grammar in section 5
does NOT begin a block. Readers MUST skip it and treat it as part of the
preceding block's body, or as leading content if no block has begun. See
section 9.1: such lines occur in practice and MUST NOT be repaired.

## 5. Header grammar

A block header MUST match:

```
^## <timestamp> <sep> from: <sender> <sep> status: <status> <sep> subject:<subject>
```

where `<sep>` is one of:

| Separator | Codepoint |
|---|---|
| em dash | U+2014 |
| en dash | U+2013 |
| space hyphen space | U+0020 U+002D U+0020 |

Matching is case insensitive. Optional horizontal whitespace MAY surround each
separator and MAY follow each field label.

Field definitions:

| Field | Definition | Constraint |
|---|---|---|
| `timestamp` | a run of non whitespace characters | SHOULD be ISO 8601 in UTC, e.g. `2026-08-12T09:15:00Z` |
| `sender` | a run of non whitespace characters | the participant who wrote the message |
| `status` | `sent` or `read` | see section 6 |
| `subject` | the remainder of the line | MAY be empty |

Because `sender` is a run of non whitespace characters, it MAY contain a colon.
Implementations MUST account for this. See section 8.3.

### 5.1 Separators inside field values

Separator characters inside a field value are tolerated. The field labels
`from:`, `status:` and `subject:` disambiguate the header on backtracking, so a
sender such as `al{U+2013}ice` and a subject containing any dash both parse
correctly. This was verified empirically against the grammar rather than
assumed from reading it.

A deployment MAY impose a stricter rule for its own reasons. The reference
implementation rejects U+2014 anywhere in a subject or body and exits non zero,
which is an editorial policy of the project it came from rather than a
requirement of this protocol. An implementation without that policy is still
conforming.

### 5.2 Case

Matching is case insensitive, so `STATUS: SENT` parses. Writers MUST
nonetheless emit `status` values in lower case.

A writer that patches status in place verifies the four bytes before writing
them (section 8.2), and that check is byte exact. An uppercase `SENT` therefore
parses as unread but can never be transitioned, leaving the message
permanently unread. Readers SHOULD lower case the value for comparison;
writers MUST NOT rely on them doing so.

## 6. Delivery state

`status` is the only mutable part of a message. It has exactly two values:

- `sent`: written, not yet seen by the recipient
- `read`: the recipient has rendered it

Transitions:

- A writer MUST create a message with `status: sent`.
- A reader acting on behalf of the recipient MAY transition `sent` to `read`.
- `read` MUST NOT transition back to `sent`.
- A participant MUST NOT transition its own outbound messages to `read`.

The transition is the read receipt. There is no separate acknowledgement
message.

Both values are four bytes in ASCII. This is deliberate and load bearing: it
allows the transition to be a fixed length in place patch rather than a
rewrite. See section 8.2.

## 7. Message body

The body is everything after the header line, up to the start of the next
block.

For presentation, a reader MUST strip:

- leading and trailing whitespace
- any line whose trimmed content is exactly `---`

The `---` line is a visual delimiter for humans reading the raw file. It
carries no meaning and MUST NOT be treated as structure.

Bodies MAY contain any text, including lines beginning with `#`. A body line
beginning with `## ` that does not match the header grammar is body content
(section 4). Writers SHOULD avoid emitting one.

### 7.1 Structured metadata (optional extension)

A body MAY open with a metadata region so that a renderer can present the
message as a structured object rather than prose. This extension is OPTIONAL:
an implementation that ignores it entirely is still conforming, and MUST
render such a message as ordinary text.

If present, the metadata region:

- MUST begin on the first line of the body
- MUST be valid YAML
- MUST be terminated by a blank line, or by the end of the block
- consists of contiguous lines that are either a top level key matching
  `^[a-z][a-z0-9_-]*:` or an indented continuation matching `^\s+\S`

A writer emitting a metadata region MUST ensure the terminating blank line
exists. Without it the region runs into the prose and the whole block degrades
to plain text.

Any YAML scalar containing a colon MUST be quoted. An unquoted colon is
interpreted as a nested mapping and silently changes the parsed shape.

The meaning of particular keys is out of scope for this document.

## 8. Writer requirements

### 8.1 Appending

A writer MUST append a new block at end of file. A writer MUST NOT rewrite the
whole file to add a message.

A writer MUST serialise its append against other writers on the same file. The
reference implementation uses an advisory lock file at `<thread>.lock`, created
with `O_CREAT | O_EXCL`, holding an owner token, with a staleness timeout after
which the lock may be stolen by an atomic rename. Any equivalent mechanism is
acceptable. What is REQUIRED is the property: two concurrent appends both
survive, in some order, uncorrupted.

A writer MUST NOT implement an append as a read, modify and replace via a
temporary file plus rename. Rename swaps the inode, which silently discards any
append that landed on the original file in between. This is the single most
likely way to lose messages in a conforming looking implementation.

### 8.2 Changing status

A writer changing `sent` to `read` MUST patch the four bytes in place. It MUST
NOT rewrite the file.

The implementation MUST:

1. locate the `status` value using the header grammar of section 5, deriving
   the offset from the grammar's own match, not from a second, looser search
2. convert the character offset to a **byte** offset, since an earlier block
   may contain multi byte UTF-8
3. verify the four bytes at that offset read `sent` before writing
4. write exactly four bytes

Step 1 is not an optimisation. See section 8.3.

### 8.3 A specific failure this protocol requires you to avoid

`from:` precedes `status:` in the header. If an implementation locates the
status token with a loose search such as `status:\s*(sent)`, that search takes
the first match in the line, and a sender name containing the text
`status:sent` matches inside the **sender** field.

Verifying the bytes before writing does not catch this, because those four
bytes genuinely spell `sent`. It is the wrong `sent`, not a corrupted one. The
patch then rewrites the sender and leaves the real status untouched, so the
message is corrupted and stays permanently unread.

Deriving the offset from the anchored header grammar makes the whole class
impossible rather than merely unlikely.

Note that a deployment which constrains participant names to exclude colons is
not protected by that constraint. The guard would live in a different system
from the one performing the write, and any tool writing these files directly is
under no obligation to honour it.

### 8.4 Symbolic links

A writer MUST resolve the thread path and operate on the resolved file, in
place. A writer MUST NOT replace a symbolic link with a regular file, which is
what a write to the unresolved path followed by a rename would do.

A lock file or other sibling artefact SHOULD be created next to the resolved
path.

### 8.5 Encoding

Files are UTF-8. Where a length is reported to a user it SHOULD be counted in
Unicode code points, not UTF-16 code units, so that the number does not vary by
implementation language.

## 9. Reader requirements

### 9.1 Tolerate, never repair

A reader MUST tolerate malformed content and MUST NOT rewrite it. Specifically:

- a `## ` line that does not match the header grammar is skipped, not corrected
- a block with an unparseable timestamp is still a block
- unknown metadata keys are preserved, not stripped

Thread files accumulate content from multiple tools over long periods, and some
of it will be header shaped without being a header. Normalising it destroys
data that another implementation may depend on, and turns a read into a write.

### 9.2 Ordering

Blocks are ordered by position in the file, not by timestamp. A reader MUST NOT
reorder them. Timestamps come from writers with unsynchronised clocks and are
informational.

## 10. Conformance

An implementation is conforming if it satisfies every MUST in this document.
The suite in `tests/` exercises the following, and an implementation claiming
conformance SHOULD pass an equivalent set:

1. header parsing across all three separator forms, case insensitively
2. a dash character inside a sender name or subject parsing correctly
3. body cleaning, including `---` removal
4. the metadata region terminator rule
5. `sent` to `read` as a four byte in place patch, verified before write
6. correct patching when an earlier block contains multi byte UTF-8
7. correct patching when a sender name contains the text `status:sent`
8. concurrent appends from real separate processes, with none lost, duplicated
   or corrupted
9. a symlinked thread file remaining a symlink after a write
10. malformed blocks surviving a read and a write byte identically

## 11. Known deviations in the reference implementation

Stated here rather than omitted, because an implementer will otherwise
reproduce them by treating the code as the specification.

**Read is not atomic with the status flip.** `inbox read` prints the unread
blocks, then re derives which blocks are unread and patches them. A message
arriving between those two steps is marked read without having been displayed.
The message is not lost, which is what makes it dangerous: it looks like it was
already handled.

A conforming implementation SHOULD flip exactly the blocks it displayed,
identified individually, rather than re deriving the set.

**The initial read takes no lock**, so a concurrent append may be parsed mid
write. A conforming implementation SHOULD hold the same lock across the read
and the flip.

These two compound: the window is the whole print loop, so it widens with the
size of the backlog, and a large catch up read is exactly when another writer
is most likely to be active.

Both are preserved in the reference implementation for parity with the
original, and are tracked as defects rather than as behaviour to copy.

## 12. Versioning

This document is versioned independently of any implementation. Until 1.0,
breaking changes MAY be made. After 1.0:

- a new REQUIRED field, a changed field order, or a removed separator form is
  a major change
- a new OPTIONAL field, a new metadata key, or a new tolerated malformation is
  a minor change

Changes MUST be justified without reference to the needs of any single
consuming application, because a protocol shaped around one consumer stops
being a protocol.
