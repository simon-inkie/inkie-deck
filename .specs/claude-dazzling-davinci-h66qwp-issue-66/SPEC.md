# #66: Basic text editor inside the Deck for drafting with agents

- Issue: #66
- Branch: claude/dazzling-davinci-h66qwp-issue-66
- Started: 2026-10-14

## TL;DR
First slice of a Markdown draft editor in the Deck. A draft is an ordinary
`<WORKSPACE_ROOT>/drafts/<name>.md` file, so an agent reads and writes it with
its normal file tools. The Deck gets a Drafts page (plain textarea) to open,
create and save drafts, showing when the file was last saved and whether the
current version was written by the person (via this editor) or by the agent
(anything else). If the file changes outside the editor while it is open, a
visible warning offers "load the newer copy" or "keep mine and overwrite".
No rich text, no multi-cursor, no external integrations, no new service.

Known limitations, stated up front:
- "Agent" means "changed outside this editor". A person using another tool
  also reads as "agent". It is an inference from a content hash, not identity.
- The conflict check is atomic against other saves through the Deck (shared
  advisory lock), but not against an external writer that lands between the
  check and the rename. The editor polls every 5 seconds to narrow this.
- The Drafts link is in the desktop top bar only, not the mobile agent strip.

## Scope
In scope:
- `WORKSPACE_ROOT` env (optional); Drafts route, `/api/drafts` seam, editor.
- Flat `*.md` names only, confined to the realpath of `drafts/`.
Out of scope (and where it goes instead):
- Large-paste handling and attachments: #65, untouched.
- Rich text, comments, suggestions, real-time collaboration, Google Docs.
- Per-draft history or diff view.

## Decisions
- Where drafts live: `<WORKSPACE_ROOT>/drafts/`. No existing "workspace root"
  existed in the Deck's root table, so a new optional env var was added; unset
  hides the feature. Not added to the required boot-time root table.
- Authorship: a hidden sidecar `drafts/.deck-drafts.json` stores the hash of
  the version the Deck last saved. Hash match = person, else agent. Chosen over
  front matter, which would pollute the file the agent reads.
- Conflicts: last write wins with a warning, as the issue suggested, not a
  lock. Save carries the loaded version; mismatch returns 409 with the current
  copy.
- Agent change notification: the editor polls the file; the existing file
  watch was not reused.

## Test plan
- `packages/deck/test/drafts.test.ts`: temp-workspace tests for create, save,
  list, authorship, conflicts, concurrency, symlink and traversal confinement,
  and the API route.
- `packages/deck/test/draft-editor.test.tsx`: jsdom render test for the status
  line and the external-change warning.
- Full check list from CONTRIBUTING.md.

## Follow-ups
- Mobile nav entry; a diff against the last person-saved version.

## Log
### 2026-10-14: slice implemented
- What changed: SPEC, server module, API route, Drafts page, tests.
- Why: first slice of #66.
- Supersedes: nothing, additive
- Commits: 40f5943 feat(deck): Markdown draft editor over workspace drafts folder (#66)

### 2026-10-14: review fixes
- What changed: saves normalise CRLF/CR to LF (browser multipart posts had
  turned LF into CRLF, leaving files CRLF and the editor permanently dirty);
  errors inside the save lock now return JSON (a directory at the draft path
  gives 400, other failures 500) instead of throwing; the shared sidecar
  read-modify-write takes its own lock; a relative WORKSPACE_ROOT now logs a
  warning instead of silently hiding the feature; added tests for each, and
  editor tests for save, "Load the newer copy" and "Keep mine and overwrite".
- Why: review findings on the PR, all fixed in the commit after 40f5943.
- Supersedes: nothing, additive
- Commits: fb5663b fix(deck): normalise draft line endings, JSON errors in save lock, lock sidecar (#66)

### 2026-10-14: second review round
- What changed: a draft removed outside the editor now shows a visible alert
  (from the poll's 404, or from a 409 save with no current copy) with "Keep mine
  and recreate" (force save); the poll compares against the version loaded
  after its GET returns, so a save finishing mid-poll raises no false alert;
  failures after the file is written (sidecar update, final read) no longer
  fail the save, the sidecar failure is logged and the result falls back to the
  version just written.
- Why: review findings 1 to 3 of the second review.
- Supersedes: nothing, additive
- Commits: e55184b fix(deck): surface removed drafts, avoid false poll conflict, keep save result after write (#66)

Known limitation added: `request.formData()` reads the whole request body
before the 1 MB content cap is applied, so the cap bounds what is stored, not
what is received. Fine for a loopback-only, unauthenticated Deck.

### 2026-10-15: third review round (two reviews and CodeRabbit)
- What changed:
  - Editor: switching drafts or creating one while edits are unsaved asks
    first (`window.confirm`); declining keeps the text. A save response is
    dropped if the editor's text was replaced meanwhile (switch, create, load
    newer copy), so one draft's save can no longer attach to another's text.
    An older open/create response is dropped when a newer one was issued.
  - Poll: replaced "compare after the await" with a generation counter. Any
    adopt or save start/finish since the GET began, or a save in flight, makes
    the answer be discarded, which also covers a GET that read the pre-save
    file and arrives after the save. A 200 now clears the "removed" alert and
    a matching version clears a stale conflict alert.
  - Server: the save result is the version this save wrote (content, hash,
    mtime taken right after the write), never a re-read, so another writer
    landing during the sidecar wait cannot be echoed back as the base for the
    next save. Confinement is re-checked inside the lock immediately before the
    write and before the sidecar write, so a `drafts/` folder swapped for a
    symlink while the save was queued cannot redirect it. Existing files over
    1 MB are never read (read answers 413, list shows them without reading,
    save refuses). A corrupt sidecar is copied to `.deck-drafts.json.bad` and
    logged before it is replaced.
  - API: browser cross-origin writes are refused with 403 (Sec-Fetch-Site not
    same-origin/none, or Origin host differing from Host). Header-less
    requests (agents using curl) pass.
  - Dev: the default dev workspace moved to `packages/deck/.workspace/`
    (gitignored) because `.runtime/` is deleted on every start.
- Why: review findings; the data-loss and confinement items were Major.
- Supersedes: the second-round poll comparison and the "fall back to the
  version just written" result path, both replaced as above.
- Commits: see the sha entry below.
- Deferred: `Claude-Session` trailers in 40f5943, fb5663b and b2edbbb need a
  history rewrite, which this work is not allowed to do; a maintainer can strip
  them on squash merge. Reads remain synchronous (now bounded to 1 MB each);
  case-insensitive filesystem collisions (`Draft.md` vs `draft.md`) were not
  examined.
