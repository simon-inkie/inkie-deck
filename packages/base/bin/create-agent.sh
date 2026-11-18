#!/usr/bin/env bash
# create-agent.sh - create an agent, then prove its persona reached the model.
#
# The missing third sibling of boot-agents.sh and workspace.sh. Those two
# LAUNCH agents. This one brings one into existence, in both of the places that
# have to agree before an agent is real:
#
#   1. $AGENTS_HOME/<name>/        the persona files. The launcher's definition
#                                  of an agent is "a directory holding SOUL.md".
#   2. $INBOX_ROOT/<name>/inbox/   the message surface. The application's
#                                  definition is "a directory under the inbox
#                                  root".
#
# Those two definitions are independent, so an agent can be bootable and
# invisible, or visible and unbootable. Making both true at once is this
# script's whole job description on the filesystem side.
#
# Then it does the part that matters more. It asks the new agent, in one
# non-interactive turn from the agent's own home directory, to state its name
# and the boot phrase written into its identity file at creation.
#
# Why that check and not a cheaper one: FILES EXISTING IS WHAT EVERY FAILURE
# MODE IN THIS AREA LOOKS LIKE. A persona that silently never reached the model
# leaves behind exactly the same directory tree as one that did. Only an answer
# that comes back THROUGH the mechanism can distinguish them.
#
# And why the boot phrase rather than the name: the agent's NAME leaks into
# context through the working directory, so a persona-less generic session can
# answer "what is your name" convincingly and the check would pass while
# nothing worked. The boot phrase is random at creation and exists nowhere but
# the persona file, so it cannot be answered without the import chain having
# actually delivered that file to the model.
#
# Usage:
#   bin/create-agent.sh <name> [--role "<tagline>"] [--runtime <runtime>]
#                              [--model <id>] [--verify | --no-verify]
#                              [--inbox-root <path>]
#                              [--agents-home <path>] [--no-install-path]
#                              [--memory-root <path> | --no-memory]
#   bin/create-agent.sh --verify-only <name>
#   bin/create-agent.sh --check-name <name>
#   bin/create-agent.sh                          # interactive, prompts for a name
#
#   --model <id>                 write <agent home>/.model, which boot-agents.sh
#                                and workspace.sh pass as `--model <id>`. Without
#                                it the agent uses the runtime's own default,
#                                which may be a costlier model on a paid plan.
#   --kind assistant|platform    write <agent home>/.kind (read by Deck to pin the
#                                assistant first) and stamp a short role brief
#                                from templates/kinds/<kind>.md into CLAUDE.md.
#                                bin/first-run.sh uses this; it is optional.
#   --peer <name>                the other shipped agent's name, stamped into the
#                                role brief so each knows who to hand work to. Also
#                                saved as <agent home>/.peer, so a re-run of
#                                first-run.sh binds to it rather than to new input.
#   --check-name <name>          validate the name and that both homes are free,
#                                print the usual complaint if not, write nothing.
#                                Exit 0 (usable) or 1 (not).
#   --no-install-path            skip the $HOME/.local/bin/inbox symlink that
#                                makes `inbox` resolve as a bare command name.
#   --memory-root <path>         checkout of the memory layer (default:
#                                $MEMORY_LAYER_ROOT). When it holds a built
#                                install, this agent's own .claude/settings.json
#                                gets the memory hooks and its memory silo is
#                                seeded. Absent, unbuilt or failing: memory is
#                                reported OFF and creation carries on. It never
#                                changes the exit code.
#   --no-memory                  leave memory off even if a checkout is present.
#
# USER_NAME (environment, optional) is written into the agent's settings env
# block when memory is on, so the memory prompts can name the person.
#
# Exit codes. Four terminal states, never collapsed into one another:
#
#   0  VERIFIED        created (if asked to) AND the persona demonstrably
#                      arrived in the model's context.
#   1  SCAFFOLD ERROR  nothing was created, or creation stopped part way.
#   3  FAILED          the model replied and did NOT know its boot phrase.
#                      The persona did not reach it. The reply is printed,
#                      because the reply is the diagnostic.
#   4  CANNOT VERIFY   there was no usable runtime to ask, so nothing about
#                      the persona was proven either way.
#
# There is deliberately no exit code meaning "created, assume verified", and
# "created" and "verified" are always separate words in the output. An empty
# reply with a zero exit status is FAILED, never a pass.

set -uo pipefail

EXIT_VERIFIED=0
EXIT_SCAFFOLD_ERROR=1
EXIT_FAILED=3
EXIT_CANNOT_VERIFY=4

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATES_DIR="${CREATE_AGENT_TEMPLATES:-$SCRIPT_DIR/../templates}"

PERSONA_FILES=(IDENTITY.md SOUL.md TOOLS.md USER.md CLAUDE.md)
NAME_RE='^[a-z0-9][a-z0-9-]*$'

# ---------------------------------------------------------------------------
# output helpers
# ---------------------------------------------------------------------------

say()  { printf '%s\n' "$*"; }
warn() { printf 'create-agent: warning: %s\n' "$*" >&2; }

# Every abnormal exit goes through here, so a verdict line is never skipped.
die_scaffold() {
  local arg line
  printf '\n' >&2
  printf 'create-agent: SCAFFOLD ERROR\n' >&2
  for arg in "$@"; do
    while IFS= read -r line; do printf '  %s\n' "$line" >&2; done <<< "$arg"
  done
  exit "$EXIT_SCAFFOLD_ERROR"
}

# The header comment IS the help text. Printed by walking it rather than by a
# hardcoded line range, so editing the header can never silently truncate --help.
usage() {
  local line
  local first=1
  while IFS= read -r line; do
    if [[ $first -eq 1 ]]; then first=0; continue; fi   # shebang
    [[ "$line" == \#* ]] || break
    printf '%s\n' "${line/#\# /}" | sed 's/^#$//'
  done < "${BASH_SOURCE[0]}"
}

# ---------------------------------------------------------------------------
# node fragments
#
# Bash owns the orchestration; node owns anything involving JSON, HTML-comment
# stripping or arbitrary user text landing inside a file. Arguments go in as
# environment variables so no value is ever interpolated into a quoted string.
# node >= 22 is already this repository's engine floor.
# ---------------------------------------------------------------------------

node_run() { node --input-type=module - 7>&-; }

gen_nonce() {
  node_run <<'JS'
import { randomBytes } from "node:crypto";
process.stdout.write("boot-" + randomBytes(8).toString("hex"));
JS
}

# Substitute the three marked placeholders the templates carry, and nothing
# else. Self-authoring placeholders are left exactly as they are: they are the
# new agent's first piece of work, not this script's.
stamp_templates() {
  node_run <<'JS'
import * as fs from "node:fs";
import * as path from "node:path";

const home = process.env.CA_HOME;
const name = process.env.CA_NAME;
const role = process.env.CA_ROLE;
const nonce = process.env.CA_NONCE;
const inboxCli = process.env.CA_INBOX_CLI;
const kindFile = process.env.CA_KIND_FILE;
const peer = process.env.CA_PEER;
const agentsHome = process.env.CA_AGENTS_HOME;
const createCli = process.env.CA_CREATE_CLI;

const identityPath = path.join(home, "IDENTITY.md");
let identity = fs.readFileSync(identityPath, "utf8");
identity = identity.replace("- **Name:** <name>", `- **Name:** ${name}`);

// The boot phrase. A permanent creation stamp, kept rather than stripped after
// verification: stripping it would add a mutation path over the persona chain
// for no gain, and keeping it means --verify-only still works months later.
identity +=
  "\n---\n\n" +
  `- **Boot phrase:** ${nonce}\n\n` +
  "Written at creation, and used to prove this file actually reaches the model\n" +
  "rather than merely existing on disk. Quote it when asked for your boot\n" +
  "phrase. Safe to keep; it grants nothing and identifies nothing.\n";
fs.writeFileSync(identityPath, identity);

const claudePath = path.join(home, "CLAUDE.md");
let claude = fs.readFileSync(claudePath, "utf8");
claude = claude.replace(
  "# <Name>, <role tagline>",
  role ? `# ${name}, ${role}` : `# ${name}`,
);
// The role brief, when this agent was created with --kind. Appended after the
// imports so the persona chain is unchanged; the placeholders are per-agent for
// the same reason the inbox CLI path is.
if (kindFile) {
  const brief = fs
    .readFileSync(kindFile, "utf8")
    .replaceAll("<peer>", peer || "the other agent")
    .replaceAll("<agents-home>", agentsHome)
    .replaceAll("<create-agent-cli>", createCli);
  claude = claude.replace(/\n*$/, "\n\n") + brief.replace(/\n*$/, "\n");
}
fs.writeFileSync(claudePath, claude);

// The inbox section of TOOLS.md. Stamped rather than shipped verbatim because
// every line of it is per-agent: the CLI lives at an absolute path that depends
// on where this package was checked out, and the agent has to see its OWN name
// to know which side of a thread it is writing.
const toolsPath = path.join(home, "TOOLS.md");
let tools = fs.readFileSync(toolsPath, "utf8");
tools = tools.replace(
  "<inbox commands: stamped at creation>",
  [
    `You are **${name}**. Teammates reach you by that name, and the CLI that reads`,
    "and writes those messages is:",
    "",
    "```",
    inboxCli,
    "```",
    "",
    "It is also on your PATH as plain `inbox` unless the symlink install was",
    "skipped, which is why message hints elsewhere say `inbox reply <name>` with",
    "no path in front of it.",
    "",
    "```bash",
    "inbox unread                    # who is waiting on you, and how many",
    "inbox read                      # print unread messages, mark them read",
    "inbox read basalt               # only that correspondent's thread",
    'inbox reply basalt --subject "re: the migration" --body "Done, on main."',
    "inbox ack basalt                # mark read without printing",
    "```",
    "",
    "`AGENT_NAME` says who you are and `INBOX_ROOT` says where the messages live.",
    "Both are set for you in `.claude/settings.json`; the CLI hard-errors without",
    "them rather than guessing.",
  ].join("\n"),
);
fs.writeFileSync(toolsPath, tools);
JS
}

# Deep-merge our keys into an existing settings file, adding only what is
# missing. NEVER a fresh write over an existing file: other systems keep their
# hooks in that same file, and a replacing write deletes them silently, with
# nothing anywhere to say it happened.
merge_settings() {
  node_run <<'JS'
import * as fs from "node:fs";

const file = process.env.CA_SETTINGS;
const name = process.env.CA_NAME;
const role = process.env.CA_ROLE;
const inboxRoot = process.env.CA_INBOX_ROOT;

// INBOX_ROOT rides along with AGENT_NAME because the settings env block is the
// one channel proven to reach the environment of the commands the agent runs,
// and the inbox CLI refuses to start without it. It is stamped rather than
// defaulted for the same reason the CLI has no default: the CLI and the
// application must resolve the SAME root, and a default on either side would
// quietly split an agent's messages away from the application while both halves
// carried on looking like they worked.
const additions = {
  env: { AGENT_NAME: name, INBOX_ROOT: inboxRoot },
  // Claude Code's ghost/auto-suggest text has no detection in Deck's
  // compose-push (unlike Codex's dim-SGR-wrapped hints), so an agent left on
  // the default silently drops pushed messages. Off by default closes that
  // gap without relying on every adopter finding it the hard way.
  promptSuggestionEnabled: false,
};
if (role) additions.env.AGENT_ROLE = role;

let existing = {};
if (fs.existsSync(file)) {
  const raw = fs.readFileSync(file, "utf8");
  if (raw.trim()) {
    try {
      existing = JSON.parse(raw);
    } catch (err) {
      // Refuse rather than clobber. A file we cannot parse is a file whose
      // contents we cannot promise to preserve.
      process.stderr.write(`unparseable JSON in ${file}: ${err.message}\n`);
      process.exit(1);
    }
    if (existing === null || typeof existing !== "object" || Array.isArray(existing)) {
      process.stderr.write(`${file} is not a JSON object\n`);
      process.exit(1);
    }
  }
}

/** Additive merge: anything already present wins, including nested. */
function mergeInto(base, add) {
  for (const [key, value] of Object.entries(add)) {
    const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
    if (isPlainObject(value)) {
      if (!(key in base)) base[key] = {};
      if (!isPlainObject(base[key])) continue; // an existing scalar/array stays
      mergeInto(base[key], value);
    } else if (!(key in base)) {
      base[key] = value;
    }
  }
  return base;
}

fs.writeFileSync(file, JSON.stringify(mergeInto(existing, additions), null, 2) + "\n");
JS
}

# Static check of the @-import chain declared by CLAUDE.md.
#
# This is NOT a substitute for the live probe and is never reported as one. A
# script that resolved the import chain itself would be testing its own
# reimplementation of the runtime's loader, which can agree with itself while
# disagreeing with the thing that actually runs.
#
# Note the HTML-comment strip: the shipped CLAUDE.md template carries example
# @-imports inside a comment block, which the runtime does not import and this
# check must not demand.
check_chain() {
  node_run <<'JS'
import * as fs from "node:fs";
import * as path from "node:path";

const home = process.env.CA_HOME;
const source = fs.readFileSync(path.join(home, "CLAUDE.md"), "utf8");
const active = source.replace(/<!--[\s\S]*?-->/g, "");

const targets = [];
for (const line of active.split("\n")) {
  const match = /^@(\S+)\s*$/.exec(line.trim());
  if (match) targets.push(match[1]);
}

const problems = [];
for (const target of targets) {
  const resolved = target.startsWith("~/")
    ? path.join(process.env.HOME ?? "", target.slice(2))
    : path.resolve(home, target);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    problems.push(`${target}: no such file (${resolved})`);
    continue;
  }
  if (!stat.isFile()) problems.push(`${target}: not a regular file`);
  else if (stat.size === 0) problems.push(`${target}: empty`);
  else {
    try {
      fs.accessSync(resolved, fs.constants.R_OK);
    } catch {
      problems.push(`${target}: not readable`);
    }
  }
}

process.stdout.write(JSON.stringify({ targets, problems }));
JS
}

# ---------------------------------------------------------------------------
# the PATH install
#
# THE ONLY THING THIS SCRIPT WRITES OUTSIDE $AGENTS_HOME AND $INBOX_ROOT.
#
# Why it writes anything there at all: the notification the application pushes
# into an agent's terminal reads "[reply via inbox: inbox reply <name>]", a BARE
# command name. That instruction is only true if `inbox` resolves on PATH, and
# boot-agents.sh already prepends $HOME/.local/bin, so one symlink there makes
# the hint honest for every agent on the machine.
#
# Never destructive. Anything already sitting at that path was put there by
# something else, and something else's file is not ours to replace. Every skip
# is a warning and never fatal: the absolute path is stamped into TOOLS.md, so
# an agent whose symlink was skipped can still use the CLI.
# ---------------------------------------------------------------------------

PATH_INSTALL_REPORT="not attempted"

resolve_path() { readlink -f "$1" 2>/dev/null || printf '%s' "$1"; }

install_inbox_on_path() {
  local source="$SCRIPT_DIR/inbox"
  local target_dir="$HOME/.local/bin"
  local target="$target_dir/inbox"
  local source_real; source_real="$(resolve_path "$source")"

  if [[ ! -f "$source" ]]; then
    PATH_INSTALL_REPORT="skipped (no CLI at $source)"
    warn "no inbox CLI at $source, so nothing was linked onto PATH."
    warn "  The agent can still run it by absolute path once one exists."
    return
  fi

  # An `inbox` that already answers on PATH and is not this one wins by
  # possession. Replacing whatever it is would be the same clobber as
  # overwriting the file, one indirection further away.
  local found found_real
  found="$(command -v inbox 2>/dev/null)"
  if [[ -n "$found" ]]; then
    found_real="$(resolve_path "$found")"
    if [[ "$found_real" == "$source_real" ]]; then
      PATH_INSTALL_REPORT="already on PATH at $found"
      return
    fi
    PATH_INSTALL_REPORT="skipped (a different inbox is already on PATH at $found)"
    warn "a different \`inbox\` already resolves on PATH:"
    warn "    $found  ->  $found_real"
    warn "  Nothing was linked or replaced. Use the absolute path in TOOLS.md,"
    warn "  or resolve the clash yourself:"
    warn "    $source"
    return
  fi

  if [[ -e "$target" || -L "$target" ]]; then
    local target_real; target_real="$(resolve_path "$target")"
    if [[ -L "$target" && "$target_real" == "$source_real" ]]; then
      PATH_INSTALL_REPORT="already linked  $target"
      return
    fi
    PATH_INSTALL_REPORT="skipped (something else already occupies $target)"
    warn "$target already exists and is not a link to this package's CLI."
    warn "  It was left exactly as found; this script never removes or"
    warn "  overwrites a file it did not create. The agent can still run:"
    warn "    $source"
    return
  fi

  if ! mkdir -p "$target_dir" 2>/dev/null; then
    PATH_INSTALL_REPORT="skipped (could not create $target_dir)"
    warn "could not create $target_dir, so \`inbox\` is not on PATH."
    warn "  The absolute path stamped into TOOLS.md still works: $source"
    return
  fi

  if ! ln -s "$source" "$target" 2>/dev/null; then
    PATH_INSTALL_REPORT="skipped (could not link $target)"
    warn "could not create the symlink $target, so \`inbox\` is not on PATH."
    warn "  The absolute path stamped into TOOLS.md still works: $source"
    return
  fi

  PATH_INSTALL_REPORT="linked  $target  ->  $source"
}

# ---------------------------------------------------------------------------
# the memory loop (opt-in safe)
#
# Wires the memory layer's hooks into THIS agent's own settings.json (never a
# global one) and seeds the agent's memory silo, by running the layer's own
# non-interactive install command against a checkout it was already given.
# Deck imports nothing from it; the integration is files on disk.
#
# Memory is optional, so nothing in here may fail the creation. Every outcome
# lands in MEMORY_REPORT as "on" or "off (reason)" and the run carries on. The
# silo is routed by AGENT_NAME, which merge_settings already stamped, so no
# --link pointer is written into the agent home.
# ---------------------------------------------------------------------------

MEMORY_REPORT="off (MEMORY_LAYER_ROOT not set)"
MEMORY_PENDING=0     # 1 while memory is still to be wired on the way out
MEMORY_PRINT=0       # 1 when the final "memory ..." line must be printed
MEMORY_WIRING=0      # 1 only while the memory install command is in flight
MEMORY_SNAPSHOT=""   # copy of the settings file taken before the installer ran
MEMORY_IN_EXIT=0     # 1 once the exit handler is running (memory is wired there)
MEMORY_ARMED=0       # 1 when this run set out to wire memory (not --verify-only)
MEMORY_STAGE=""      # "", "ran" (installer returned, unchecked), "installed", "stamped"

# Containment of the per-agent settings, done in node so that it works the same
# on Linux and macOS and FAILS CLOSED: a node that cannot run, or a path it
# cannot examine, is "not contained". The rules, for a write that is to land in
# <agents home>/<name>/.claude/settings.json and nowhere else:
#   - the agent home is not a symlink and resolves to <agents home>/<name>, where
#     the agents home is resolved through any symlinked ancestor even when it
#     does not exist yet;
#   - .claude, if present, is not a symlink and resolves to <that>/.claude;
#   - settings.json, if present, is a regular file, not a symlink, and has a link
#     count of one (a hard link would write through to the other name);
#   - it is not the same file as the user's own global settings
#     ($HOME/.claude/settings.json, or $CLAUDE_CONFIG_DIR/settings.json), by
#     resolved path or by device and inode, which also catches a link pointing
#     the other way;
#   - mode "tree" adds: nothing anywhere under .claude is a symlink, and no
#     regular file there has a link count above one. The memory layer's
#     installer writes a temporary file and a backup beside settings.json and
#     follows links, so a planted link under any name can redirect a write.
# This is a check at one moment. A link planted afterwards is only caught by the
# check that runs again after the install, which is too late to prevent the write.
contain_check() {
  CA_MODE="$1" CA_AGENTS_HOME="$AGENTS_HOME" CA_AGENT_HOME="$AGENT_HOME" CA_NAME="$NAME" \
    node_run <<'JS' >/dev/null 2>&1
import * as fs from "node:fs";
import * as path from "node:path";

const { CA_MODE: mode, CA_AGENTS_HOME, CA_AGENT_HOME, CA_NAME: name } = process.env;

// A ".." is resolved by the kernel through real directories but by text here,
// and the two disagree whenever a symlink sits before it (the check would then
// pass for one directory while the files land in another). Refuse it outright.
if ([CA_AGENTS_HOME, CA_AGENT_HOME].some((p) => p.split(path.sep).includes(".."))) process.exit(1);

// realpath that tolerates a path whose last components do not exist yet: resolve
// the deepest existing ancestor and append the rest.
function loose(p) {
  const rest = [];
  let cur = path.resolve(p);
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...rest.reverse());
    } catch (err) {
      if (err.code !== "ENOENT" && err.code !== "ENOTDIR") throw err;
      const parent = path.dirname(cur);
      if (parent === cur) throw err;
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}
const lstat = (p) => {
  try { return fs.lstatSync(p); } catch (err) { if (err.code === "ENOENT") return null; throw err; }
};
const fail = () => process.exit(1);

const want = path.join(loose(CA_AGENTS_HOME), name);
const home = path.resolve(CA_AGENT_HOME);
const homeStat = lstat(home);
if (homeStat && homeStat.isSymbolicLink()) fail();
if (loose(home) !== want) fail();

const claude = path.join(home, ".claude");
const claudeStat = lstat(claude);
if (claudeStat) {
  if (claudeStat.isSymbolicLink() || !claudeStat.isDirectory()) fail();
  if (loose(claude) !== path.join(want, ".claude")) fail();
}

const settings = path.join(claude, "settings.json");
const settingsStat = lstat(settings);
if (settingsStat) {
  if (settingsStat.isSymbolicLink() || !settingsStat.isFile() || settingsStat.nlink !== 1) fail();
}

// Never the user's own global settings, whichever way a link points.
const globals = [];
if (process.env.HOME) globals.push(path.join(process.env.HOME, ".claude", "settings.json"));
if (process.env.CLAUDE_CONFIG_DIR) globals.push(path.join(process.env.CLAUDE_CONFIG_DIR, "settings.json"));
const mine = path.join(want, ".claude", "settings.json");
for (const g of globals) {
  if (loose(g) === mine) fail();
  const gs = lstat(g);
  if (gs && settingsStat) {
    const real = fs.statSync(g, { throwIfNoEntry: false });
    if (real && real.dev === settingsStat.dev && real.ino === settingsStat.ino) fail();
  }
}

if (mode === "tree" && claudeStat) {
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink()) fail();
      if (st.isDirectory()) walk(full);
      else if (st.isFile() && st.nlink !== 1) fail();
    }
  };
  walk(claude);
}
JS
}

settings_is_contained() { contain_check scaffold; }
memory_dir_is_clean() { contain_check tree; }

# Before the install only: a brand-new agent home holds no settings.json.<x>
# entries, so any that exist were put there by someone else and are the place a
# planted link would hide. After the install the installer's own backup is
# expected, so this is not part of memory_dir_is_clean.
no_foreign_settings_extras() {
  [[ -z "$(list_settings_extras)" ]]
}

# Files the installer may leave beside settings.json (temporary, backup). Used
# to remove only what it created, after a restore.
MEMORY_PRESEED=""
list_settings_extras() {
  local f
  for f in "$AGENT_HOME/.claude"/settings.json.*; do
    [[ -e "$f" || -L "$f" ]] && printf '%s\n' "$f"
  done
}
remove_new_settings_extras() {
  local f
  while IFS= read -r f; do
    [[ -n "$f" ]] || continue
    grep -qxF -- "$f" <<< "$MEMORY_PRESEED" && continue
    [[ -f "$f" && ! -L "$f" ]] && rm -f -- "$f"
  done < <(list_settings_extras)
}

# Give up on wiring, say why on the final line, and leave settings alone.
memory_skip() {
  MEMORY_PENDING=0
  MEMORY_PRINT=1
  MEMORY_STAGE="done"
  MEMORY_REPORT="off ($1)"
}

print_memory_line() {
  say
  say "create-agent: memory $MEMORY_REPORT"
}

# The signal handler prints through fd 7, a copy of the script's own stdout made
# when the exit handler starts and closed again for every child it launches, so
# a detached grandchild cannot hold the caller's pipe open. A trap runs inside whatever redirection the interrupted command had
# (the installer and the containment check both run with their output sent to
# /dev/null), so printing to plain stdout from there would be silently lost.
print_memory_line_signal() {
  if { true >&7; } 2>/dev/null; then
    { say; say "create-agent: memory $MEMORY_REPORT"; } >&7
  else
    print_memory_line
  fi
}

restore_settings() {
  [[ -n "$MEMORY_SNAPSHOT" && -f "$MEMORY_SNAPSHOT" ]] || return 1
  # Redirect rather than cp: it keeps the file's mode and fails when the target
  # is no longer a regular file, instead of quietly copying into a directory.
  # Not into a shared inode either: a hard-linked settings file would put the
  # snapshot into another file's contents.
  memory_dir_is_clean || return 1
  cat "$MEMORY_SNAPSHOT" > "$AGENT_HOME/.claude/settings.json" || return 1
  remove_new_settings_extras
}

drop_snapshot() {
  [[ -n "$MEMORY_SNAPSHOT" ]] && rm -f "$MEMORY_SNAPSHOT"
  MEMORY_SNAPSHOT=""
}

# Add USER_NAME to the settings env block unless one is already there.
stamp_user_name() {
  node_run <<'JS'
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
const file = process.env.CA_SETTINGS;
const user = process.env.CA_USER_NAME;
const data = JSON.parse(fs.readFileSync(file, "utf8"));
data.env = data.env && typeof data.env === "object" ? data.env : {};
if (!("USER_NAME" in data.env)) data.env.USER_NAME = user;
// Temporary file in the same directory, then a rename: a signal or a crash can
// never leave the settings truncated half way. The name does not begin with
// "settings.json." so it cannot be mistaken for the installer's own files.
const mode = fs.statSync(file).mode & 0o777;
// A random name opened with "wx" (create, never follow or reuse), so a link
// planted under a guessable name cannot be written through. The mode option is
// masked by the umask, so set it explicitly before the rename.
const tmp = path.join(path.dirname(file), `.settings-stamp-${crypto.randomBytes(8).toString("hex")}.tmp`);
fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { flag: "wx", mode: 0o600 });
fs.chmodSync(tmp, mode);
fs.renameSync(tmp, file);
JS
}

wire_memory() {
  local root="$1" installer status
  installer="$root/scripts/install.sh"

  if [[ $NO_MEMORY -eq 1 ]]; then
    MEMORY_REPORT="off (--no-memory)"; return
  fi
  if [[ -z "$root" ]]; then
    MEMORY_REPORT="off (MEMORY_LAYER_ROOT not set)"; return
  fi
  if [[ ! -f "$installer" ]]; then
    MEMORY_REPORT="off (no install command at $installer)"
    warn "memory is off: $root is not a memory layer checkout. Deck carries on without it."
    return
  fi
  # Everything the installer needs is checked BEFORE it runs. The real one
  # merges the hooks first and only then looks for tsx, so a missing tsx would
  # leave hooks written while memory was reported off.
  local missing="" script
  for script in user-prompt-submit on-stop on-pre-compact; do
    [[ -f "$root/dist/claude-code/bin/$script.sh" ]] || missing="$missing dist/claude-code/bin/$script.sh"
  done
  [[ -x "$root/node_modules/.bin/tsx" ]] || missing="$missing node_modules/.bin/tsx"
  if [[ -n "$missing" ]]; then
    MEMORY_REPORT="off (not built: missing${missing})"
    warn "memory is off: the memory layer checkout at $root is not built and installed."
    warn "  Build it, then re-run its install command with --agent $NAME. Settings were not touched."
    return
  fi

  # Silo routing is by env.AGENT_NAME in this very settings file. merge_settings
  # keeps a value that was already there, so a settings file carrying another
  # agent's name would seed one silo and route the hooks to a different one.
  local routed
  if ! memory_dir_is_clean; then
    memory_skip "the agent's .claude is not contained, or holds a symlink or hard link; nothing written"
    warn "memory is off: $AGENT_HOME/.claude is outside the agent's own directory, or is or contains a"
    warn "  symlink or hard link. The memory install writes files there and would follow it. Remove the"
    warn "  link, then run the install command with --agent $NAME."
    return
  fi
  if ! no_foreign_settings_extras; then
    memory_skip "unexpected settings.json.* entries in the agent's .claude; nothing written"
    warn "memory is off: $AGENT_HOME/.claude holds files named settings.json.<something> that this run"
    warn "  did not create. The memory install writes files with such names. Remove them, then run the"
    warn "  install command with --agent $NAME."
    return
  fi
  routed="$(CA_SETTINGS="$AGENT_HOME/.claude/settings.json" node_run <<'JS'
import * as fs from "node:fs";
const d = JSON.parse(fs.readFileSync(process.env.CA_SETTINGS, "utf8"));
process.stdout.write(typeof d?.env?.AGENT_NAME === "string" ? d.env.AGENT_NAME : "");
JS
)" || { memory_skip "could not read the agent's settings"; return; }
  if [[ "$routed" != "$NAME" ]]; then
    memory_skip "settings env.AGENT_NAME is \"$routed\", not \"$NAME\""
    warn "memory is off: the agent's settings route memory to \"$routed\", not \"$NAME\"."
    warn "  Wiring it would seed one silo and send the hooks to another. Fix env.AGENT_NAME, then"
    warn "  run the memory layer's install command with --agent $NAME. Settings were not touched."
    return
  fi

  # Keep a copy so a failure after the hooks merged can be undone.
  # Created 0600 from the start: the settings can hold secrets and a copy in
  # $TMPDIR must not be wider than the original.
  MEMORY_SNAPSHOT="$(umask 077; mktemp)" || { memory_skip "could not snapshot the agent's settings"; return; }
  cat "$AGENT_HOME/.claude/settings.json" > "$MEMORY_SNAPSHOT" \
    || { drop_snapshot; memory_skip "could not snapshot the agent's settings"; return; }
  MEMORY_PRESEED="$(list_settings_extras)"

  # --skip-build: building is a one-off for the checkout, not a per-agent step.
  MEMORY_WIRING=1
  bash "$installer" --skip-build --settings "$AGENT_HOME/.claude/settings.json" \
    --agent "$NAME" </dev/null >/dev/null 7>&-
  status=$?
  MEMORY_STAGE="ran"
  MEMORY_WIRING=0
  # Re-check after the installer and before anything else is written or claimed:
  # a link that appeared meanwhile means writes may have gone elsewhere.
  if ! memory_dir_is_clean; then
    drop_snapshot
    memory_skip "PARTIAL: the agent's .claude failed its containment check after the install (a link appeared, or settings.json was replaced); check where it points"
    warn "memory is NOT reported on: $AGENT_HOME/.claude failed its containment check after the install ran."
    warn "  Nothing further was written. Inspect the link target and $AGENT_HOME/.claude/settings.json."
    return
  fi
  if [[ $status -ne 0 ]]; then
    if restore_settings; then
      memory_skip "memory install exited $status; settings restored, nothing wired"
      warn "memory is off: the memory layer's install command exited $status."
      warn "  The agent's settings were restored to what they were before. The silo may be partly"
      warn "  seeded; the install command is idempotent, so fix the cause and run it again with"
      warn "  --agent $NAME. Deck carries on."
    else
      memory_skip "PARTIAL: memory install exited $status and settings could NOT be restored"
      warn "memory is PARTLY wired: the install command exited $status and the previous settings"
      warn "  could not be put back. Check $AGENT_HOME/.claude/settings.json for memory hooks and"
      warn "  remove them, or fix the cause and re-run the install command with --agent $NAME."
    fi
    return
  fi

  MEMORY_STAGE="installed"
  if [[ -n "${USER_NAME:-}" ]]; then
    MEMORY_STAGE="stamping"
    CA_SETTINGS="$AGENT_HOME/.claude/settings.json" CA_USER_NAME="$USER_NAME" stamp_user_name \
      || warn "could not write USER_NAME into the agent's settings; memory prompts will not name you."
    # Fail closed once more before claiming anything: the stamp wrote a file.
    if ! memory_dir_is_clean; then
      memory_skip "PARTIAL: the agent's .claude failed its containment check after USER_NAME was stamped; check $AGENT_HOME/.claude/settings.json"
      return
    fi
  else
    warn "USER_NAME is not set, so the memory prompts will not name the person. Set it and re-run, or edit the agent's settings env."
  fi
  MEMORY_STAGE="stamped"
  MEMORY_REPORT="on (hooks wired in $AGENT_HOME/.claude/settings.json, silo seeded)"
}

# ---------------------------------------------------------------------------
# argument parsing
# ---------------------------------------------------------------------------

NAME=""
ROLE=""
RUNTIME="claude"
VERIFY="auto"      # auto | yes | no
VERIFY_ONLY=0
INBOX_ROOT_ARG=""
AGENTS_HOME_ARG=""
INSTALL_PATH=1
MEMORY_ROOT_ARG=""
NO_MEMORY=0
MODEL=""
KIND=""
PEER=""
CHECK_NAME=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)      usage; exit 0 ;;
    --role)         [[ $# -ge 2 ]] || die_scaffold "--role needs a value";        ROLE="$2";            shift 2 ;;
    --runtime)      [[ $# -ge 2 ]] || die_scaffold "--runtime needs a value";     RUNTIME="$2";         shift 2 ;;
    --model)        [[ $# -ge 2 ]] || die_scaffold "--model needs a value";        MODEL="$2";           shift 2 ;;
    --inbox-root)   [[ $# -ge 2 ]] || die_scaffold "--inbox-root needs a value";  INBOX_ROOT_ARG="$2";  shift 2 ;;
    --agents-home)  [[ $# -ge 2 ]] || die_scaffold "--agents-home needs a value"; AGENTS_HOME_ARG="$2"; shift 2 ;;
    --kind)         [[ $# -ge 2 ]] || die_scaffold "--kind needs a value";         KIND="$2";            shift 2 ;;
    --peer)         [[ $# -ge 2 ]] || die_scaffold "--peer needs a value";         PEER="$2";            shift 2 ;;
    --check-name)   [[ $# -ge 2 ]] || die_scaffold "--check-name needs a name"
                    [[ "$2" != -* ]] || die_scaffold "\"$2\" cannot be an agent name" "a name does not start with a hyphen"
                    CHECK_NAME=1; NAME="$2"; shift 2 ;;
    --no-install-path) INSTALL_PATH=0; shift ;;
    --memory-root)  [[ $# -ge 2 ]] || die_scaffold "--memory-root needs a value"; MEMORY_ROOT_ARG="$2";  shift 2 ;;
    --no-memory)    NO_MEMORY=1; shift ;;
    --verify)       VERIFY="yes"; shift ;;
    --no-verify)    VERIFY="no"; shift ;;
    --verify-only)  VERIFY_ONLY=1; VERIFY="yes"; shift ;;
    --)             shift; break ;;
    -*)             die_scaffold "unknown flag: $1" "run with --help for usage" ;;
    *)
      [[ -n "$NAME" ]] && die_scaffold "more than one name given: '$NAME' and '$1'" \
        "a name is one word: lowercase letters, digits and hyphens"
      NAME="$1"; shift ;;
  esac
done

# ---------------------------------------------------------------------------
# roots
# ---------------------------------------------------------------------------

# AGENTS_HOME is what the launcher scripts read; AGENTS_ROOT is what the
# application reads. That split predates this script. Honour both rather than
# picking a winner, and say so out loud when they disagree, because silently
# choosing one is how an agent ends up created in a directory that only half
# the system is looking at.
if [[ -n "$AGENTS_HOME_ARG" ]]; then
  AGENTS_HOME="$AGENTS_HOME_ARG"
elif [[ -n "${AGENTS_HOME:-}" && -n "${AGENTS_ROOT:-}" ]]; then
  if [[ "$AGENTS_HOME" != "$AGENTS_ROOT" ]]; then
    warn "AGENTS_HOME and AGENTS_ROOT are both set and differ."
    warn "  AGENTS_HOME=$AGENTS_HOME  (used here, and by the launcher scripts)"
    warn "  AGENTS_ROOT=$AGENTS_ROOT  (read elsewhere)"
    warn "  The agent will be created under AGENTS_HOME only. Point them at the"
    warn "  same directory, or pass --agents-home explicitly."
  fi
elif [[ -n "${AGENTS_ROOT:-}" ]]; then
  AGENTS_HOME="$AGENTS_ROOT"
else
  AGENTS_HOME="${AGENTS_HOME:-$HOME/agents}"
fi

INBOX_ROOT_SOURCE="INBOX_ROOT"
if [[ -n "$INBOX_ROOT_ARG" ]]; then
  INBOX_ROOT="$INBOX_ROOT_ARG"
  INBOX_ROOT_SOURCE="--inbox-root"
elif [[ -n "${INBOX_ROOT:-}" ]]; then
  INBOX_ROOT="${INBOX_ROOT}"
else
  # Do not guess silently. Propose, explain, and record the choice in the
  # output, so an inbox created in the wrong place is visible at the moment it
  # happens rather than the first time a message goes missing.
  #
  # This value is the silo layout this project ships, NOT a reading of the
  # deployment. It used to be announced as "the value from the application's
  # .env.example", which was never true - that file ships INBOX_ROOT empty,
  # because there is no default - and it invited the reader to trust a
  # guess as though something had confirmed it.
  INBOX_ROOT="$HOME/.the-vault/agents"
  INBOX_ROOT_SOURCE="default (INBOX_ROOT was unset)"
  warn "INBOX_ROOT is not set. The application reads agents from that directory,"
  warn "so an agent created outside it exists for the launcher and not for the"
  warn "application. Nothing here knows where YOUR inbox root is: the value"
  warn "below is this project's default layout, and it is a guess."
  warn "    $INBOX_ROOT"
  warn "Set INBOX_ROOT, or pass --inbox-root, to put it somewhere else."
fi

[[ "$AGENTS_HOME" = /* ]] || die_scaffold "agents home must be an absolute path, got: $AGENTS_HOME"
[[ "$INBOX_ROOT" = /* ]] || die_scaffold "inbox root must be an absolute path, got: $INBOX_ROOT"

# ---------------------------------------------------------------------------
# name
# ---------------------------------------------------------------------------

suggest_name() {
  # Turn what they typed into something that would have been accepted, so the
  # error tells them what to do rather than only what was wrong.
  printf '%s' "$1" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -e 's/[^a-z0-9]\+/-/g' -e 's/^-\+//' -e 's/-\+$//'
}

name_complaint() {
  local candidate="$1" suggestion
  suggestion="$(suggest_name "$candidate")"
  printf '"%s" cannot be an agent name.\n' "$candidate"
  printf 'A name is lowercase letters, digits and hyphens, starting with a letter or digit.\n'
  printf 'It is used as a directory name, a tmux window name and a message address, so it\n'
  printf 'has to survive all three unchanged.\n'
  if [[ -n "$suggestion" && "$suggestion" =~ $NAME_RE ]]; then
    printf 'Try "%s".\n' "$suggestion"
  fi
}

if [[ -z "$NAME" ]]; then
  if [[ ! -t 0 ]]; then
    die_scaffold "no agent name given" "usage: create-agent.sh <name> [--role \"<tagline>\"]"
  fi
  say "Naming an agent."
  say
  say "The name is the agent's address in the system: the directory its persona"
  say "files live in, the tmux window it runs in, and the name teammates put on"
  say "messages to it. Short and lowercase works best. What the agent is CALLED,"
  say "in the sense that matters, it will write for itself on its first day, in"
  say "IDENTITY.md and SOUL.md. Those files are scaffolded with the prompts left"
  say "in place on purpose: a hand-authored personality reads as costume, and the"
  say "agent drifts back out of it. This is only the handle."
  say
  while [[ -z "$NAME" ]]; do
    printf 'name: '
    read -r reply || die_scaffold "no name given"
    # Trim the ends only. Interior spaces are left alone on purpose: "Red Kite"
    # has to reach the validator intact for it to suggest "red-kite" back.
    reply="${reply#"${reply%%[![:space:]]*}"}"
    reply="${reply%"${reply##*[![:space:]]}"}"
    if [[ -z "$reply" ]]; then
      say "A name is needed to continue. Ctrl-C to stop."
      continue
    fi
    if [[ "$reply" =~ $NAME_RE ]]; then
      NAME="$reply"
    else
      say
      name_complaint "$reply"
      say
    fi
  done
  say
fi

if [[ ! "$NAME" =~ $NAME_RE ]]; then
  die_scaffold "$(name_complaint "$NAME")"
fi

AGENT_HOME="$AGENTS_HOME/$NAME"
AGENT_INBOX="$INBOX_ROOT/$NAME/inbox"

# The launchers put .model on a shell command line unquoted, so only a plain
# model id is accepted.
if [[ -n "$MODEL" && ! "$MODEL" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]*$ ]]; then
  die_scaffold "--model '$MODEL' is not a plain model id" \
    "use letters, digits, dots, colons and hyphens, for example claude-sonnet-5-5"
fi
MODEL_ARGS=()
[[ -n "$MODEL" ]] && MODEL_ARGS=(--model "$MODEL")

case "$KIND" in
  ""|assistant|platform) ;;
  *) die_scaffold "--kind '$KIND' is not a kind" "use assistant or platform" ;;
esac
if [[ -n "$PEER" && ! "$PEER" =~ $NAME_RE ]]; then
  die_scaffold "--peer '$PEER' cannot be an agent name" \
    "a name is lowercase letters, digits and hyphens"
fi
[[ -z "$PEER" || "$PEER" != "$NAME" ]] || die_scaffold "--peer is the other agent, not '$NAME' itself"

# ---------------------------------------------------------------------------
# create
# ---------------------------------------------------------------------------

refuse_if_occupied() {
  # Refuse to overwrite, and name BOTH paths when either is occupied. Whoever
  # hits this knows about one of the two directories, almost never both.
  #
  # "Occupied" is any persona file being present, not the directory merely
  # existing. An empty directory, or one holding only a .claude/ that a hook
  # installer put there before the agent was scaffolded, is not an agent, and
  # refusing on it would send someone to delete a directory another tool owns.
  PERSONA_PRESENT=0
  for template in "${PERSONA_FILES[@]}"; do
    [[ -e "$AGENT_HOME/$template" ]] && PERSONA_PRESENT=1
  done
  [[ -e "$AGENT_HOME/.runtime" ]] && PERSONA_PRESENT=1
  INBOX_PRESENT=0
  [[ -e "$AGENT_INBOX" ]] && INBOX_PRESENT=1

  if [[ $PERSONA_PRESENT -eq 1 || $INBOX_PRESENT -eq 1 ]]; then
    {
      printf '\n'
      printf 'create-agent: SCAFFOLD ERROR\n'
      printf '  An agent named "%s" already occupies at least one of its two homes.\n' "$NAME"
      printf '  Nothing was created or changed.\n'
      printf '\n'
      printf '    persona files  %s  %s\n' \
        "$([[ $PERSONA_PRESENT -eq 1 ]] && echo "EXISTS " || echo "free   ")" "$AGENT_HOME"
      printf '    inbox          %s  %s\n' \
        "$([[ $INBOX_PRESENT -eq 1 ]] && echo "EXISTS " || echo "free   ")" "$INBOX_ROOT/$NAME"
      printf '\n'
      printf '  An agent is both of those directories, not either one. Remove what is\n'
      printf '  there, or choose another name.\n'
    } >&2
    exit "$EXIT_SCAFFOLD_ERROR"
  fi
}

# --check-name: everything a creation would refuse on, and nothing written.
if [[ $CHECK_NAME -eq 1 ]]; then
  [[ -n "$NAME" ]] || die_scaffold "--check-name needs a name"
  refuse_if_occupied
  say "create-agent: \"$NAME\" is a usable name and both homes are free"
  exit "$EXIT_VERIFIED"
fi

# Write a marker without following a symlink already at that path: refuse it,
# otherwise write a temp file beside it and rename.
write_marker() {
  local target="$1" value="$2" tmp
  [[ ! -L "$target" ]] || die_scaffold "$target is a symlink; refusing to write through it"
  tmp="$(mktemp "$target.XXXXXX")" || die_scaffold "could not write $target"
  printf '%s' "$value" > "$tmp" && mv -f -- "$tmp" "$target" \
    || { rm -f -- "$tmp"; die_scaffold "could not write $target"; }
}

NONCE=""

if [[ "$VERIFY_ONLY" -eq 1 ]]; then
  [[ -d "$AGENT_HOME" ]] || die_scaffold "no agent home at $AGENT_HOME" \
    "--verify-only checks an agent that already exists"
  NONCE="$(grep -oE 'boot-[0-9a-f]{16}' "$AGENT_HOME/IDENTITY.md" 2>/dev/null | head -n1)"
  [[ -n "$NONCE" ]] || die_scaffold \
    "no boot phrase found in $AGENT_HOME/IDENTITY.md" \
    "the boot phrase is written at creation; an agent scaffolded by hand has none," \
    "and there is no way to verify one without it."
else
  refuse_if_occupied

  for template in "${PERSONA_FILES[@]}"; do
    [[ -f "$TEMPLATES_DIR/$template" ]] || die_scaffold \
      "template not found: $TEMPLATES_DIR/$template" \
      "expected the templates/ directory alongside bin/ in this package"
  done

  if [[ -n "$KIND" && ! -f "$TEMPLATES_DIR/kinds/$KIND.md" ]]; then
    die_scaffold "template not found: $TEMPLATES_DIR/kinds/$KIND.md"
  fi

  settings_is_contained || die_scaffold "refusing to write settings outside the agent's own directory:" "  $AGENT_HOME, its .claude or its settings.json is a symlink, or resolves" "  somewhere other than $AGENTS_HOME/$NAME. The settings are written in place," "  so they could land in a global file. Remove the link, or choose another name."
  mkdir -p "$AGENT_HOME" || die_scaffold "could not create $AGENT_HOME"
  for template in "${PERSONA_FILES[@]}"; do
    cp "$TEMPLATES_DIR/$template" "$AGENT_HOME/$template" \
      || die_scaffold "could not copy $template into $AGENT_HOME"
  done

  NONCE="$(gen_nonce)" || die_scaffold "could not generate a boot phrase (is node on PATH?)"
  [[ -n "$NONCE" ]] || die_scaffold "could not generate a boot phrase"

  CA_HOME="$AGENT_HOME" CA_NAME="$NAME" CA_ROLE="$ROLE" CA_NONCE="$NONCE" \
    CA_INBOX_CLI="$SCRIPT_DIR/inbox" CA_PEER="$PEER" CA_AGENTS_HOME="$AGENTS_HOME" \
    CA_CREATE_CLI="$SCRIPT_DIR/create-agent.sh" \
    CA_KIND_FILE="${KIND:+$TEMPLATES_DIR/kinds/$KIND.md}" stamp_templates \
    || die_scaffold "could not write the persona files in $AGENT_HOME"

  # .runtime is written explicitly even though the launcher defaults it. The
  # default is the launcher's business and can change; what this agent runs on
  # is a property of the agent.
  printf '%s' "$RUNTIME" > "$AGENT_HOME/.runtime" \
    || die_scaffold "could not write $AGENT_HOME/.runtime"

  if [[ -n "$MODEL" ]]; then
    printf '%s' "$MODEL" > "$AGENT_HOME/.model" \
      || die_scaffold "could not write $AGENT_HOME/.model"
  fi

  mkdir -p "$AGENT_HOME/.claude" || die_scaffold "could not create $AGENT_HOME/.claude"
  CA_SETTINGS="$AGENT_HOME/.claude/settings.json" CA_NAME="$NAME" CA_ROLE="$ROLE" \
    CA_INBOX_ROOT="$INBOX_ROOT" merge_settings \
    || die_scaffold "could not write $AGENT_HOME/.claude/settings.json"

  mkdir -p "$AGENT_INBOX" || die_scaffold "could not create $AGENT_INBOX"

  # .kind and .peer go LAST, once both homes exist. first-run.sh reads .kind as
  # "this agent is complete", so writing it earlier would let a scaffold that
  # failed part way be reported as already done on the next run.
  [[ -z "$KIND" ]] || write_marker "$AGENT_HOME/.kind" "$KIND"
  [[ -z "$PEER" ]] || write_marker "$AGENT_HOME/.peer" "$PEER"

  if [[ $INSTALL_PATH -eq 1 ]]; then
    install_inbox_on_path
  else
    PATH_INSTALL_REPORT="skipped (--no-install-path)"
  fi

  say
  say "create-agent: CREATED $NAME"
  say "  persona files  $AGENT_HOME"
  say "  inbox          $AGENT_INBOX"
  say "  inbox root     $INBOX_ROOT  [$INBOX_ROOT_SOURCE]"
  say "  inbox CLI      $PATH_INSTALL_REPORT"
  say "  runtime        $RUNTIME"
  [[ -z "$KIND" ]] || say "  kind           $KIND"
  if [[ $NO_MEMORY -eq 1 ]]; then
    say "  memory         off (--no-memory)"
  elif [[ -z "${MEMORY_ROOT_ARG:-${MEMORY_LAYER_ROOT:-}}" ]]; then
    say "  memory         off (MEMORY_LAYER_ROOT not set)"
  else
    say "  memory         to be wired after verification (see the last line)"
  fi
  say "  model          ${MODEL:-"(runtime default; see INSTALL.md)"}"
  say "  boot phrase    $NONCE"
  say
  say "  IDENTITY.md and SOUL.md are scaffolded, not written. The agent fills"
  say "  those in itself on its first session; that is the point of them."

  if [[ -n "${MC_INBOX_AGENT_ALLOWLIST:-}" ]]; then
    say
    warn "MC_INBOX_AGENT_ALLOWLIST is set in this environment:"
    warn "    $MC_INBOX_AGENT_ALLOWLIST"
    warn "That list is read once at application boot and gates BOTH visibility and"
    warn "writes. Until \"$NAME\" is added to it and the application is restarted,"
    warn "the agent is invisible in the application AND messages to it are refused."
  fi
fi

# ---------------------------------------------------------------------------
# the static chain check
#
# Necessary, not sufficient, and labelled as such wherever it is printed.
# ---------------------------------------------------------------------------

CHAIN_JSON="$(CA_HOME="$AGENT_HOME" check_chain)" || die_scaffold \
  "could not read $AGENT_HOME/CLAUDE.md to check its imports"

CHAIN_PROBLEMS="$(
  CA_JSON="$CHAIN_JSON" node_run <<'JS'
const { problems } = JSON.parse(process.env.CA_JSON);
process.stdout.write(problems.join("\n"));
JS
)"

if [[ -n "$CHAIN_PROBLEMS" ]]; then
  die_scaffold "CLAUDE.md declares imports that will not resolve:" "$CHAIN_PROBLEMS"
fi

# ---------------------------------------------------------------------------
# the live probe
# ---------------------------------------------------------------------------

report_cannot_verify() {
  local reason="$1"
  shift
  printf '\n'
  printf 'create-agent: CANNOT VERIFY %s\n' "$NAME"
  printf '  %s\n' "$reason"
  local line
  if [[ $# -gt 0 ]]; then
    printf '\n'
    for line in "$@"; do
      [[ -z "$line" ]] && { printf '\n'; continue; }
      printf '  %s\n' "$line"
    done
  fi
  printf '\n'
  printf '  What IS true: the files are in place, and every file CLAUDE.md imports\n'
  printf '  exists, is non-empty and is readable.\n'
  printf '\n'
  printf '  What is NOT true: this has NOT verified that the persona reaches the\n'
  printf '  model. Every way this breaks leaves the files exactly where they are,\n'
  printf '  so the check above cannot tell a working agent from a broken one.\n'
  printf '\n'
  printf '  Run this once a runtime is available and signed in:\n'
  printf '      %s --verify-only %s\n' "$0" "$NAME"
  exit "$EXIT_CANNOT_VERIFY"
}

# Memory is wired on the way out, AFTER the probe below. The probe runs the
# agent's real `claude -p` from its home, which would fire any memory hooks
# already in its settings and seed a probe turn as the agent's first memory.
# Every exit from here on, whatever the verdict, goes through the trap.
memory_on_exit() {
  local rc=$?
  MEMORY_IN_EXIT=1
  exec 7>&1
  rm -f "${PROBE_OUT:-}" "${PROBE_ERR:-}"
  local show=$MEMORY_PRINT
  if [[ $MEMORY_PENDING -eq 1 ]]; then
    MEMORY_PENDING=0
    wire_memory "${MEMORY_ROOT_ARG:-${MEMORY_LAYER_ROOT:-}}"
    show=1
  fi
  [[ $show -eq 1 || $MEMORY_PRINT -eq 1 ]] && print_memory_line
  drop_snapshot
  exit "$rc"
}

# A run interrupted or killed before its verdict must not wire memory, and one
# interrupted while the memory install is in flight must leave a visible report
# and the settings as they were. The handler prints in that case because it may
# be running inside the EXIT trap, where a further exit skips the trap's print.
# Bash runs a trap only after the foreground command it is waiting on ends. A
# signal sent to this script alone therefore lets the installer finish, and the
# settings are restored afterwards. A terminal Ctrl-C or a hangup goes to the
# whole process group and also stops the installer and its helper wherever they
# are, which is exactly the case the restore and the snapshot cleanup are for.
on_signal() {
  local code="$1"
  MEMORY_PENDING=0
  if [[ $MEMORY_WIRING -eq 1 ]]; then
    MEMORY_WIRING=0
    if restore_settings; then
      MEMORY_REPORT="off (interrupted during memory install; settings restored, nothing wired)"
    else
      MEMORY_REPORT="off (PARTIAL: interrupted during memory install and settings could NOT be restored; check $AGENT_HOME/.claude/settings.json)"
    fi
    print_memory_line_signal
    MEMORY_PRINT=0
  elif [[ $MEMORY_IN_EXIT -eq 1 && $MEMORY_ARMED -eq 1 ]]; then
    # Inside the exit handler but not in the installer: before it ran, after it
    # returned, or while USER_NAME was being stamped. Say which, because the
    # exit handler's own print is skipped when this exits.
    case "$MEMORY_STAGE" in
      "")        MEMORY_REPORT="off (interrupted before the memory install ran; nothing written)" ;;
      ran)       MEMORY_REPORT="off (PARTIAL: interrupted after the memory install ran and before its result was checked; hooks may be wired, check $AGENT_HOME/.claude/settings.json)" ;;
      installed) MEMORY_REPORT="on (interrupted before USER_NAME was stamped; hooks wired and silo seeded, add env.USER_NAME by hand)" ;;
      stamping)  MEMORY_REPORT="on (interrupted while USER_NAME was being stamped; hooks wired and silo seeded, the settings are intact because the stamp is an atomic rename, but env.USER_NAME may or may not be there)" ;;
      stamped)   MEMORY_REPORT="on (interrupted after wiring finished; hooks wired, silo seeded)" ;;
      *)         ;;   # already decided; print what it says
    esac
    print_memory_line_signal
    MEMORY_PRINT=0
  else
    MEMORY_PRINT=1
    MEMORY_REPORT="off (run interrupted before memory was wired)"
  fi
  drop_snapshot
  exit "$code"
}

[[ "$VERIFY_ONLY" -eq 1 ]] || { MEMORY_PENDING=1; MEMORY_ARMED=1; }
trap memory_on_exit EXIT
trap 'on_signal 130' INT
trap 'on_signal 143' TERM
trap 'on_signal 129' HUP

if [[ "$VERIFY" == "no" ]]; then
  report_cannot_verify "Verification was skipped (--no-verify)."
fi

if ! command -v claude >/dev/null 2>&1; then
  report_cannot_verify "No \`claude\` on PATH, so there was nothing to ask."
fi

. "$SCRIPT_DIR/claude-binary-check.sh"
warn_if_foreign_claude

PROBE_PROMPT="Answer from your own context, not by reading any files, and reply with exactly two lines and nothing else:
name: <your name>
boot phrase: <the boot phrase recorded in your identity file>
If there is no boot phrase in your context, write: boot phrase: NONE"

PROBE_TIMEOUT="${CREATE_AGENT_VERIFY_TIMEOUT:-180}"
PROBE_OUT="$(mktemp)"; PROBE_ERR="$(mktemp)"

say
say "create-agent: verifying $NAME ..."
say "  one non-interactive turn, from $AGENT_HOME"

# cwd is load-bearing. The runtime assembles CLAUDE.md and its imports relative
# to the directory it was launched in, and files conversation history under a
# slug of that directory. A probe run from anywhere else verifies a different
# project and tells you nothing about this agent.
if command -v timeout >/dev/null 2>&1; then
  ( cd "$AGENT_HOME" && timeout "$PROBE_TIMEOUT" claude ${MODEL_ARGS[@]+"${MODEL_ARGS[@]}"} -p "$PROBE_PROMPT" ) \
    >"$PROBE_OUT" 2>"$PROBE_ERR"
else
  ( cd "$AGENT_HOME" && claude ${MODEL_ARGS[@]+"${MODEL_ARGS[@]}"} -p "$PROBE_PROMPT" ) >"$PROBE_OUT" 2>"$PROBE_ERR"
fi
PROBE_STATUS=$?

REPLY="$(cat "$PROBE_OUT")"
PROBE_STDERR="$(cat "$PROBE_ERR")"

# A non-zero exit means we never got an answer: no runtime, not signed in, rate
# limited, timed out. That is CANNOT VERIFY, and it is NEVER read from empty
# output, which is a different thing entirely and handled below.
if [[ $PROBE_STATUS -ne 0 ]]; then
  detail="exit status $PROBE_STATUS"
  [[ $PROBE_STATUS -eq 124 ]] && detail="timed out after ${PROBE_TIMEOUT}s"
  lines=("The runtime did not answer ($detail).")
  [[ -n "$PROBE_STDERR" ]] && lines+=("" "It said:" "$PROBE_STDERR")
  memory_skip "verification did not pass, so memory was not wired; fix the agent, then run the memory install command with --agent $NAME"
  report_cannot_verify "Ran \`claude -p\` from the agent home and got no usable reply." "${lines[@]}"
fi

# Exit zero and nothing to show for it. This is a FAILURE, not a pass. It is
# called out separately only because "no output" is the single easiest thing in
# this whole script to accidentally score as success.
if [[ -z "${REPLY//[[:space:]]/}" ]]; then
  printf '\n'
  printf 'create-agent: FAILED %s\n' "$NAME"
  printf '  The runtime exited 0 and said nothing at all.\n'
  printf '\n'
  printf '  An empty reply is a failure, not a pass. Nothing came back through the\n'
  printf '  mechanism being tested, so the persona is unproven and treated as absent.\n'
  printf '\n'
  printf '  The files are at %s. Open a session there and see what it says it is.\n' "$AGENT_HOME"
  memory_skip "verification did not pass, so memory was not wired; fix the agent, then run the memory install command with --agent $NAME"
  exit "$EXIT_FAILED"
fi

if [[ "$REPLY" == *"$NONCE"* ]]; then
  printf '\n'
  printf 'create-agent: VERIFIED %s\n' "$NAME"
  printf '  Asked from %s, it quoted its boot phrase back: %s\n' "$AGENT_HOME" "$NONCE"
  printf '  That phrase exists nowhere but its persona file, so the file reached\n'
  printf '  the model. Created, and verified.\n'
  printf '\n'
  printf '  The one thing this does not cover: the probe is a single non-interactive\n'
  printf '  turn. An interactive session uses the same loader from the same directory,\n'
  printf '  so the same context should assemble, but that is an inference from shared\n'
  printf '  mechanism, not something this run observed.\n'
  exit "$EXIT_VERIFIED"
fi

printf '\n'
printf 'create-agent: FAILED %s\n' "$NAME"
printf '  The model replied, and did not know its boot phrase (%s).\n' "$NONCE"
printf '\n'
printf '  This is the failure the check exists for. The files are on disk and the\n'
printf '  import chain resolves, and the persona still did not arrive in the\n'
printf '  session. A file-existence check would have called this a success.\n'
printf '\n'
printf '  What it said, which is the diagnostic:\n'
printf '\n'
while IFS= read -r line; do printf '  | %s\n' "$line"; done <<< "$REPLY"
if [[ -n "$PROBE_STDERR" ]]; then
  printf '\n'
  printf '  On stderr:\n'
  printf '\n'
  while IFS= read -r line; do printf '  | %s\n' "$line"; done <<< "$PROBE_STDERR"
fi
printf '\n'
printf '  Worth checking, in this order:\n'
printf '    - does %s/CLAUDE.md still import IDENTITY.md?\n' "$AGENT_HOME"
printf '    - is anything assembling context with a size cap that silently drops\n'
printf '      the persona when it is exceeded, rather than truncating and saying so?\n'
printf '    - is a hook meant to inject this context installed, and did it run?\n'
memory_skip "verification did not pass, so memory was not wired; fix the agent, then run the memory install command with --agent $NAME"
exit "$EXIT_FAILED"
