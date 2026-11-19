# #214: Multi-harness wiring for Codex and Antigravity agents

- Issue: #214
- Branch: feat/multi-harness-wiring
- Started: 2026-11-18

## TL;DR

The base set up and verified Claude Code agents only. Codex and Antigravity
(`agy`) agents could be booted, but got CLAUDE.md-style persona files their
runtime never reads, no resume for `agy`, and no verification at all. This
change ports the generic cross-harness wiring from the maintainer's working
private platform: `create-agent.sh --runtime <claude|codex|agy>` writes the
persona file each runtime actually reads (AGENTS.md plus a Codex hooks file,
or GEMINI.md with the persona inlined), `boot-agents.sh` and `workspace.sh`
launch and resume all three runtimes, and verification is extended to Codex
and `agy` with local checks that call no model. A live probe for those two
runtimes exists but is off by default (`--live-probe`), so a Codex or `agy`
agent reports `CANNOT VERIFY` (exit 4) after its local checks pass unless the
probe is asked for.

Known limitation, live: Codex only runs a project's hooks once the project and
the hook are trusted, which is an interactive prompt on first launch. Until
that is answered, the persona-injection hook does not run and the agent has
only its AGENTS.md. The local check proves the hook works when run; it cannot
prove Codex has been told to trust it.

## Scope

In scope:

- `boot-agents.sh`: an `agy` launch branch with workspace-scoped resume
  (`--conversation <id>` from the CLI's history file), the GEMINI.md include
  sync before launch, `agy` recognised as a running runtime.
- `workspace.sh`: Codex and `agy` branches that use the same launch
  constructors as `boot-agents.sh`, so the two launchers cannot drift.
- A shared library, `bin/runtime-launch.sh`, holding the per-runtime launch
  constructors and session lookups. The Codex functions move there unchanged
  from `boot-agents.sh` (a move, not a rewrite), plus one addition: an
  optional `INBOX_ROOT` segment read from the agent's `.inbox-root` marker.
- Templates: `templates/AGENTS.md` (Codex), `templates/GEMINI.md` (agy),
  `templates/codex/hooks.json`.
- `create-agent.sh --runtime <claude|codex|agy>`: validates the runtime,
  writes the runtime's persona file and a `.runtime` marker, and for Codex
  and `agy` an `.inbox-root` marker the launchers pass on as `INBOX_ROOT`.
  `--verify-only` reads the runtime from the agent's own `.runtime`.
- Codex hooks: `bin/codex-persona-inject` (SessionStart, injects the persona
  files and a read-only inbox count) and `bin/codex-user-prompt-submit`
  (per-prompt, adds the unread summary only when something is unread). Both
  fail open.
- `bin/sync-gemini-includes.sh`: inlines persona and shared files into
  GEMINI.md between generated fences, idempotently.
- Verification for Codex and `agy`: local checks (hooks match the scaffold
  without running, real GEMINI.md refreshed and carrying the boot phrase),
  plus an opt-in live probe (`codex exec`,
  `agy -p`).
- `first-run.sh --runtime` passes the runtime through to both agents.
- Tests, docs (INSTALL.md, docs/adding-an-agent.md, packages/base/README.md)
  and a per-harness truth table.

Out of scope (and where it goes instead):

- README.md, which another branch is rewriting; its "not yet" sentence about
  Codex and Antigravity needs a follow-up once both land.
- Quota, cron, worker and provider-routing wrappers from the private platform.
- Memory hooks for Codex and `agy`. Memory stays Claude Code only and is
  reported `off` for the other runtimes.

### Port and not-port list

Ported (generalised: `$AGENTS_HOME` for every path, no private names):

| From the private platform | To | Notes |
| --- | --- | --- |
| `boot-agents.sh` agy branch | `bin/boot-agents.sh`, `bin/runtime-launch.sh` | history file path is a seam (`AGY_HISTORY_FILE`); the match is anchored through the closing quote so `ann` cannot resume `anna` |
| `workspace.sh` codex and agy branches | `bin/workspace.sh` | uses the shared constructors instead of a copied envelope |
| `bin/codex-persona-inject.sh` | `bin/codex-persona-inject` | injects the persona files themselves instead of a private CORE.md; truncation is announced, never silent |
| `bin/codex-user-prompt-submit.sh` | `bin/codex-user-prompt-submit` | the private memory call is removed; only the unread-inbox summary is kept |
| `bin/sync-gemini-includes.sh` | `bin/sync-gemini-includes.sh` | relative fence paths resolve against the GEMINI.md; a source with no final newline no longer breaks idempotence |
| agent homes: `.runtime`, `AGENTS.md`, `GEMINI.md`, `.codex/hooks.json` | `templates/` and `create-agent.sh` | |

Not ported, deliberately:

- `--dangerously-skip-permissions` for `agy` and
  `--dangerously-bypass-approvals-and-sandbox` for Codex. Both exist in the
  private launchers only because a private per-call classifier replaces the
  runtime's own approvals. Without that classifier they would leave an agent
  ungated, so the runtimes' own prompts stay on.
- The auto-mode config variable, the classifier PreToolUse hooks, and the
  memory Stop and PreCompact hooks in the private `hooks.json`.
- The memory call inside the per-prompt hook.
- The private CORE.md persona digest; the public hook reads the ordinary
  persona files.
- The hardcoded watcher list and the `--windowed` per-agent views in the
  private `boot-agents.sh`; the public opt-in marker already covers the first.
- The Codex provider-switch differences: the public tree already has its own.
- A first-boot day-one message for Codex and `agy`: the private platform has
  none either, and adding one is a separate change.

## Per-harness truth table

| | Claude Code | Codex | Antigravity (`agy`) |
| --- | --- | --- | --- |
| Persona file the runtime reads | CLAUDE.md with `@` imports | AGENTS.md, plus a SessionStart hook that injects the persona files | GEMINI.md, with the persona files inlined by the include sync |
| `create-agent.sh --runtime` | yes | yes | yes |
| Launch and resume | pinned session id | newest session for the workspace in the effective Codex home, fallback to fresh | newest complete conversation record for the workspace from the CLI history |
| `workspace.sh` | yes | yes, resumes, not verified | yes, resumes |
| Local verification (no model call) | import chain resolves | hooks file valid and both commands match the scaffold without running | real GEMINI.md is refreshed and carries the boot phrase |
| Live verification | on by default (`claude -p`) | opt-in, `--live-probe` (`codex exec`) | opt-in, `--live-probe` (`agy -p`) |
| Memory hooks | yes, when configured | no | no |
| First-boot day-one message | yes | no | no |
| Monitor auto-arm marker | yes | yes | yes |

## Test plan

- `packages/base/test/multi-harness.test.sh` (run by `shell-suites.test.ts`):
  launch command per runtime through `boot-agents.sh` and `workspace.sh`
  with `tmux`, `claude`, `codex` and `agy` stubbed on PATH, so no pane or
  runtime starts; Codex home precedence and fresh launch; `agy` history
  matches decoded paths and ignores unfinished records; include sync is
  idempotent with quoted markers and preserves the original on copy failure.
- `packages/base/test/create-agent-runtimes.test.ts`: each runtime writes the
  right files; existing and symlinked hook paths are refused; both commands
  are checked statically even with `--no-verify`; the hook itself is tested
  separately, including truncation of a large IDENTITY.md; the `agy` stub
  reads GEMINI.md, with both a stale-file refresh and a negative case where
  the identity fence has been removed; `first-run.sh --runtime`.
- Run the checks listed in DEVELOPMENT.md section 4. Deck's dirty-tree group
  needs a committed tree; the base setup suite needs loopback networking.

## Follow-ups

- Run the new "Choosing a runtime" section of docs/adding-an-agent.md on a
  clean machine with real, signed-in Codex and `agy`. That guide says every
  step was run that way; this section was written from the code and the stub
  tests, not from a live run.

- README.md still says Codex and Antigravity persona files and verification
  are "not yet" supported; update it once the README rewrite lands.
- A first-boot day-one message for Codex (`codex "<prompt>"`) and `agy`
  (`agy -i "<prompt>"`).
- Deck's runtime detection banner, scoped in #151's SPEC, should list all
  three runtimes.

## Log

### 2026-11-18: SPEC written before the port
- What changed: this file, with the scope, the port and not-port list and the
  truth table, written from a read of the private sources and the public
  launchers.
- Why: DEVELOPMENT.md; the port list is the review surface for "nothing
  private crossed over".
- Supersedes: nothing, additive.
- Commits: none yet (working tree only).

### 2026-11-18: port, tests and docs
- What changed: `bin/runtime-launch.sh` (Codex constructors moved from
  `boot-agents.sh` unchanged, plus the `INBOX_ROOT` marker and the `agy`
  constructors); the `agy` branch in `boot-agents.sh`; Codex and `agy`
  branches plus `WORKSPACE_DRY_RUN` in `workspace.sh`; templates; the two Codex
  hooks; the include sync; `create-agent.sh --runtime`, local checks and
  `--live-probe`; `first-run.sh --runtime`; two test files; INSTALL.md,
  docs/adding-an-agent.md and packages/base/README.md.
- Why: the scope above.
- Decisions on the way:
  - Missing `.runtime` values were read with `cat`, so a hand-written file
    with a trailing newline never matched `codex` or `agy`. Both launchers
    now trim whitespace.
  - `workspace.sh` runs under `set -euo pipefail`, where a `grep` with no
    match inside a command substitution exits the script. The `agy` lookup
    ends in `|| true` for that reason.
  - The dry run in `workspace.sh` skips the Claude day-one message, because
    deciding it writes the marker that stops it being sent twice.
  - A GEMINI.md behind its sources was first reported as FAILED. Superseded
    in the same session: the launchers re-sync before every start, so the
    check now syncs a copy and looks for the boot phrase in what the model
    will actually read, and reports staleness as a note.
  - The private sync script, given a source with no final newline, appended
    the END marker to the source's last line, so the next run swallowed that
    line. The port adds the newline.
  - Codex hooks are written into the agent's own `.codex/hooks.json`, as in
    the private homes; Codex asks to trust them on first launch. The
    `additionalContextLimit` key is copied from the working private hooks
    file; the hook caps itself below it either way.
  - Not verified against current docs: the documentation lookup tool was not
    available in this session, so the Codex hooks format, `codex exec`
    running SessionStart hooks, and `agy -p` taking the prompt are as the
    private platform and the CLIs' own `--help` show them. The live probes
    are opt-in partly for this reason.
- Supersedes: nothing, additive.
- Commits: none yet (working tree only).

### 2026-11-19: independent review follow-up
- Picked up on the existing branch with a clean working tree. Address all six
  findings offline, using stubbed runtimes and no live panes.
- Supersedes the earlier decisions to run a command from the Codex hooks file
  in the local check and to sync only a copy of GEMINI.md for verification.
- Fixed all six findings: exclusive, symlink-safe hook creation; exact static
  hook checks; whole-line include fences with atomic replacement; checks and
  probes using the same refreshed GEMINI.md; Codex session lookup using the
  launch home; decoded `agy` history and boot phrase retention on truncation.
- Offline validation: 158 base tests passed. Skipped `setup.test.ts` because
  it opens loopback sockets, and the deck dirty-tree group because the changes
  are uncommitted. Typecheck, boundaries, leak, licence, dash and diff checks
  passed.
- Commits: none (working tree only).

### 2026-11-19: runtime review follow-up
- What changed: The Codex live probe uses the launch home and stops if provider
  selection fails; read-only status checks the saved runtime's scaffold, so
  first-run skips only complete agents. Gemini sync rejects whole-line markers
  in includes without replacing the target, even inside Markdown code blocks.
- Why: The probe could use the wrong Codex home, status missed runtime files,
  and a marker copied from a Gemini source could corrupt the next sync.
- Supersedes: nothing, additive.
- Commits: 3d30207 fix(base): codex probe home, runtime-aware status and sync fence guard (#214)
