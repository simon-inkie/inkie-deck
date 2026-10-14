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
- Commits: see branch
