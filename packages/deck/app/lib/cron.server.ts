/**
 * cron.server.ts - system-crontab + nudge-script management (TASK-460 create-cron).
 *
 * THE ONLY module that touches `crontab` and writes agent nudge scripts.
 *
 * Design posture (mirrors tmux.server.ts discipline):
 *   1. ALL crontab runner and fs operations are injectable via CronDeps so
 *      tests can stub them - tests MUST NEVER touch the real user crontab.
 *   2. Every managed crontab line is tagged # MC-CRON:<id> (active) or
 *      # MC-CRON-DISABLED:<id> (disabled). Lines without these tags are NEVER
 *      touched (mem-monitor, hand-added lines are protected by construction).
 *   3. Write-shape: scripts confined to ~/agents/<target>/bin/<id>.sh; crontab
 *      RMW never rewrites untagged lines. Target validated against live
 *      ~/agents/* dirs.
 *   4. DC4 visibility: nudge script logs fire + delivered timestamps to
 *      <INBOX_ROOT>/<target>/cron-state/<id>.json; listCrons reads it.
 *      INBOX_ROOT is the configured root that holds one directory per agent
 *      (inbox/ lives beside cron-state/ inside it), resolved through the same
 *      resolveInboxRoot() every other silo-adjacent module uses. It is NOT
 *      spelled out as a literal here: a hardcoded silo directory name makes
 *      the writer and the reader agree with each other and disagree with the
 *      deployment, so state written by a fired nudge becomes invisible to the
 *      UI and an edited nudge starts a second, parallel state tree.
 *   5. Every exported function degrades gracefully (no throws on missing
 *      crontab / missing state files). An unset INBOX_ROOT is NOT in that
 *      category: it is a misconfiguration the whole application already
 *      refuses to start against (FND-03, no default), and guessing a path
 *      here is the defect this posture exists to prevent.
 *
 * Delivery (ask-1): agent-mode messages are written to a .prompt.md sibling
 * file and pasted into the tmux pane via bracketed-paste (tmux load-buffer +
 * paste-buffer -p). This avoids any shell interpolation of the message content,
 * allowing arbitrary markdown (backticks, $, ", newlines, etc.).
 *
 * SEAM RULE (FND-02): this module is the seam; routes import only from here.
 * ASCII only - no em-dashes (FND-05).
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { validateCronExpression, validateCronMessage } from "./cron-validate.js";
import { resolveInboxRoot } from "./safe-fs.server.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CronEntry {
  id: string;
  schedule: string;
  target: string;
  message: string;
  targetType: "agent" | "script";
  scriptPath: string;
  enabled: boolean;
  lastFired: string | null;
  lastDelivered: string | null;
}

export interface CreateCronParams {
  schedule: string;
  target: string;
  message: string;
  enabled: boolean;
  targetType?: "agent" | "script";
}

/** Injectable dependencies so tests stub crontab runner + fs. */
export interface CronDeps {
  readCrontab: () => string;
  writeCrontab: (content: string) => void;
  writeScript: (filePath: string, content: string, mode?: number) => void;
  deleteScript: (filePath: string) => void;
  listAgentDirs: () => string[];
  readStateFile: (filePath: string) => string | null;
  writeStateFile: (filePath: string, content: string) => void;
  homedir: () => string;
  /**
   * The configured root holding one directory per agent, i.e. INBOX_ROOT.
   * cron-state/ sits beside inbox/ inside each agent's directory, so the
   * nudge script writes and listCrons reads the SAME configured location on
   * every deployment. Injectable for the same reason everything else here is:
   * the suite must never resolve a real root.
   */
  inboxRoot: () => string;
}

// ---------------------------------------------------------------------------
// Tag helpers
// ---------------------------------------------------------------------------

const TAG_ACTIVE = "# MC-CRON:";
const TAG_DISABLED = "# MC-CRON-DISABLED:";

function activeTag(id: string): string {
  return `${TAG_ACTIVE}${id}`;
}

function disabledTag(id: string): string {
  return `${TAG_DISABLED}${id}`;
}

/** Extract id from a managed line. Returns null if not a managed line. */
function extractTag(line: string): { id: string; enabled: boolean } | null {
  const trimmed = line.trim();
  // Disabled: the comment marker might be at the start OR embedded in the tag
  const disabledMatch =
    trimmed.match(new RegExp(`${escapeRegex(TAG_DISABLED)}([^\\s]+)$`)) ??
    trimmed.match(new RegExp(`#\\s*${escapeRegex(TAG_DISABLED.slice(1))}([^\\s]+)$`));
  if (disabledMatch) {
    return { id: disabledMatch[1]!, enabled: false };
  }
  const activeMatch = trimmed.match(new RegExp(`${escapeRegex(TAG_ACTIVE)}([^\\s]+)$`));
  if (activeMatch) {
    return { id: activeMatch[1]!, enabled: true };
  }
  return null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Default (real) deps
// ---------------------------------------------------------------------------

/** The real crontab runner. Uses execFileSync - no shell. */
export function makeDefaultDeps(): CronDeps {
  return {
    readCrontab(): string {
      try {
        return execFileSync("crontab", ["-l"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        });
      } catch {
        // No crontab installed yet = empty.
        return "";
      }
    },
    writeCrontab(content: string): void {
      execFileSync("crontab", ["-"], {
        encoding: "utf8",
        input: content,
        stdio: ["pipe", "ignore", "ignore"],
      });
    },
    writeScript(filePath: string, content: string, mode = 0o755): void {
      const dir = path.dirname(filePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, content, { encoding: "utf8", mode });
    },
    deleteScript(filePath: string): void {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // Already gone - fine.
      }
    },
    listAgentDirs(): string[] {
      const agentsRoot = path.join(os.homedir(), "agents");
      try {
        return fs
          .readdirSync(agentsRoot, { withFileTypes: true })
          .filter((e) => e.isDirectory() && /^[a-z0-9][a-z0-9-]*$/.test(e.name))
          .map((e) => e.name);
      } catch {
        return [];
      }
    },
    readStateFile(filePath: string): string | null {
      try {
        return fs.readFileSync(filePath, "utf8");
      } catch {
        return null;
      }
    },
    writeStateFile(filePath: string, content: string): void {
      const dir = path.dirname(filePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, content, "utf8");
    },
    homedir(): string {
      return os.homedir();
    },
    inboxRoot(): string {
      // Lazy on purpose: makeDefaultDeps() runs as a default argument on every
      // exported call, including the ones that reject a bad target before they
      // ever need a root. Resolving eagerly would turn "unknown agent" into a
      // configuration throw.
      return resolveInboxRoot();
    },
  };
}

// ---------------------------------------------------------------------------
// Script template (agent mode) - bracketed-paste delivery
// ---------------------------------------------------------------------------

/**
 * Quote a string for safe use inside a single-quoted bash word.
 *
 * The state root became a configured value rather than a literal, and a
 * configured value is one an operator can put a quote, a dollar sign or a
 * backtick into. Inside double quotes bash would expand those; the standard
 * POSIX single-quote escape ('\'') cannot expand anything at all.
 */
function shSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Build the nudge script for agent-mode crons.
 *
 * Delivery: loads the prompt file into a named tmux buffer and pastes it into
 * the agent's pane via bracketed-paste (-p flag). This inserts arbitrary
 * markdown verbatim with ZERO shell interpolation of the content.
 *
 * Keeps: shebang, set -u, CRON_STATE_DIR, MARKER (per-fire-slot idempotent guard),
 * STATE_FILE, has-session guard, double-Enter race defeat, DC4 state writes.
 *
 * @param inboxRoot - The configured agent-directory root (INBOX_ROOT). Baked
 *   into the generated script so a fired nudge writes its state where
 *   listCrons looks for it, on whatever deployment this is.
 */
function buildNudgeScript(
  target: string,
  id: string,
  promptFilePath: string,
  inboxRoot: string
): string {
  // ASCII only - no em-dashes.
  return `#!/usr/bin/env bash
# Generated by Inkie Deck cron admin (TASK-460). Do not edit manually.
# Target: ${target} | ID: ${id}
set -u
CRON_STATE_DIR=${shSingleQuote(path.join(inboxRoot, target, "cron-state"))}
MARKER="$CRON_STATE_DIR/.run-marker-${id}-$(date +%F-%H%M)"
STATE_FILE="$CRON_STATE_DIR/${id}.json"
PROMPT_FILE="${promptFilePath}"
WINDOW="\${WINDOW:-agents:${target}}"
mkdir -p "$CRON_STATE_DIR"
find "$CRON_STATE_DIR" -maxdepth 1 -name ".run-marker-${id}-*" ! -name "$(basename "$MARKER")" -delete 2>/dev/null || true
_fired=$(date -u +%Y-%m-%dT%H:%M:%SZ)
printf '{"fired":"%s","delivered":null}\\n' "$_fired" > "$STATE_FILE"
[ -f "$MARKER" ] && exit 0
tmux has-session -t agents 2>/dev/null || exit 0
tmux load-buffer -b cron-${id} "$PROMPT_FILE"
tmux paste-buffer -p -t "$WINDOW" -b cron-${id}
sleep 1
tmux send-keys -t "$WINDOW" Enter
sleep 1
tmux send-keys -t "$WINDOW" Enter
touch "$MARKER"
_delivered=$(date -u +%Y-%m-%dT%H:%M:%SZ)
printf '{"fired":"%s","delivered":"%s"}\\n' "$_fired" "$_delivered" > "$STATE_FILE"
`;
}

// ---------------------------------------------------------------------------
// Parse state file (DC4 visibility)
// ---------------------------------------------------------------------------

interface CronState {
  fired?: string | null;
  delivered?: string | null;
}

function readCronState(
  inboxRoot: string,
  target: string,
  id: string,
  deps: CronDeps
): { lastFired: string | null; lastDelivered: string | null } {
  // MUST stay byte-identical to the CRON_STATE_DIR the generated script writes
  // (see buildNudgeScript). These two are the reader and the writer of one
  // file; the moment they are derived from different sources they agree with
  // each other and disagree with the deployment.
  const stateFile = path.join(inboxRoot, target, "cron-state", `${id}.json`);
  const raw = deps.readStateFile(stateFile);
  if (!raw) return { lastFired: null, lastDelivered: null };
  try {
    const parsed: CronState = JSON.parse(raw);
    return {
      lastFired: parsed.fired ?? null,
      lastDelivered: parsed.delivered ?? null,
    };
  } catch {
    return { lastFired: null, lastDelivered: null };
  }
}

// ---------------------------------------------------------------------------
// Parse a managed crontab line
// ---------------------------------------------------------------------------

/**
 * Parse an ACTIVE (non-disabled) managed crontab line into its components.
 * Format: <schedule> <scriptPath> <tag>
 * e.g.: 30 7 * * * /home/you/agents/sprout/bin/nudge-abc.sh # MC-CRON:abc
 */
function parseCronLine(
  line: string
): { schedule: string; scriptPath: string } | null {
  const trimmed = line.trim();
  // Remove the tag suffix
  const tagIdx = trimmed.indexOf(TAG_ACTIVE);
  if (tagIdx === -1) return null;
  const body = trimmed.slice(0, tagIdx).trim();
  // body = "<5 cron fields> <scriptPath>"
  const parts = body.split(/\s+/);
  if (parts.length < 6) return null;
  const schedule = parts.slice(0, 5).join(" ");
  const scriptPath = parts.slice(5).join(" ");
  return { schedule, scriptPath };
}

/**
 * Parse a DISABLED managed crontab line.
 * Format: #DISABLED# <schedule> <scriptPath> <disabled-tag>
 * We store: # <schedule> <scriptPath> # MC-CRON-DISABLED:<id>
 */
function parseDisabledCronLine(
  line: string
): { schedule: string; scriptPath: string } | null {
  const trimmed = line.trim();
  const tagIdx = trimmed.indexOf(TAG_DISABLED);
  if (tagIdx === -1) return null;
  // Strip the leading # (the disable comment) and the tag suffix
  const body = trimmed.slice(0, tagIdx).replace(/^#\s*/, "").trim();
  const parts = body.split(/\s+/);
  if (parts.length < 6) return null;
  const schedule = parts.slice(0, 5).join(" ");
  const scriptPath = parts.slice(5).join(" ");
  return { schedule, scriptPath };
}

/**
 * Extract target from a script path.
 * Script path convention: <homedir>/agents/<target>/bin/<id>.sh
 */
function parseScriptPath(
  scriptPath: string,
  homedir: string
): { target: string } | null {
  // Match <homedir>/agents/<target>/bin/<id>.sh
  const agentsBase = path.join(homedir, "agents");
  if (!scriptPath.startsWith(agentsBase + path.sep)) return null;
  const rel = path.relative(agentsBase, scriptPath);
  const parts = rel.split(path.sep);
  if (parts.length !== 3 || parts[1] !== "bin") return null;
  const target = parts[0]!;
  return { target };
}

// ---------------------------------------------------------------------------
// listCrons
// ---------------------------------------------------------------------------

export function listCrons(deps: CronDeps = makeDefaultDeps()): CronEntry[] {
  const raw = deps.readCrontab();
  const home = deps.homedir();
  const inboxRoot = deps.inboxRoot();
  const lines = raw.split("\n");
  const results: CronEntry[] = [];

  for (const line of lines) {
    const tagInfo = extractTag(line);
    if (!tagInfo) continue;

    const { id, enabled } = tagInfo;

    let schedule = "";
    let scriptPath = "";

    if (enabled) {
      const parsed = parseCronLine(line);
      if (!parsed) continue;
      schedule = parsed.schedule;
      scriptPath = parsed.scriptPath;
    } else {
      const parsed = parseDisabledCronLine(line);
      if (!parsed) continue;
      schedule = parsed.schedule;
      scriptPath = parsed.scriptPath;
    }

    const pathInfo = parseScriptPath(scriptPath, home);
    const target = pathInfo?.target ?? "";

    const { lastFired, lastDelivered } = readCronState(inboxRoot, target, id, deps);

    // Detect agent-mode vs script-mode by looking for a .prompt.md sibling.
    // Agent mode: createCron writes <id>.prompt.md alongside the nudge script.
    // Script mode: only the .sh file exists (no .prompt.md).
    const promptFilePath = scriptPath.replace(/\.sh$/, ".prompt.md");
    const promptContent = deps.readStateFile(promptFilePath);

    let message: string;
    let targetType: "agent" | "script";

    if (promptContent !== null) {
      // Agent-mode entry: return the prompt text.
      targetType = "agent";
      message = promptContent;
    } else {
      // Script-mode (or legacy) entry: return the script body.
      targetType = "script";
      const scriptContent = deps.readStateFile(scriptPath);
      message = scriptContent ?? "";
    }

    results.push({
      id,
      schedule,
      target,
      message,
      targetType,
      scriptPath,
      enabled,
      lastFired,
      lastDelivered,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// createCron
// ---------------------------------------------------------------------------

export type CreateCronResult =
  | { ok: true; id: string; scriptPath: string }
  | { ok: false; error: string };

/**
 * SECURITY (shared by createCron + updateCron): validate the write-shape inputs
 * BEFORE any crontab line is built, and return the NORMALISED schedule.
 *
 * Both the create path and the edit path re-write a crontab line, so BOTH must
 * run identical guards. Factoring this into one function means the two paths
 * cannot drift apart and silently reopen the crontab-injection hole on edit.
 *
 *   1. Schedule: explicit CR/LF reject (the crontab-injection vector) followed
 *      by validateCronExpression. The NORMALISED expression is returned so the
 *      caller never interpolates the raw input into the crontab line.
 *   2. Message (agent mode only): TMUX_UNSAFE_CTRL_RE via validateCronMessage -
 *      reject NUL / CR / other C0 control chars (tab + newline are allowed).
 *      Script-mode bodies are code-by-definition and skip the message check,
 *      matching createCron's original behaviour.
 */
function validateCronWriteInputs(
  schedule: string,
  message: string,
  targetType: "agent" | "script"
): { ok: true; normalisedSchedule: string } | { ok: false; error: string } {
  // Belt-and-braces newline rejection: even if validateCronExpression already
  // rejects multi-field injections, explicitly block CR/LF here because a
  // newline in the schedule string is the crontab-injection vector and must
  // never reach the crontab line builder under any circumstances.
  if (/[\n\r]/.test(schedule)) {
    return { ok: false, error: "Schedule must not contain newline or carriage-return characters." };
  }
  const scheduleValidation = validateCronExpression(schedule);
  if (!scheduleValidation.ok) {
    return { ok: false, error: scheduleValidation.error };
  }
  // Agent-mode messages are pasted into a tmux pane: reject control chars that
  // break tmux buffers (NUL/CR/etc.). Script-mode bodies are code, not pasted.
  if (targetType === "agent") {
    const messageValidation = validateCronMessage(message);
    if (!messageValidation.ok) {
      return { ok: false, error: messageValidation.error };
    }
  }
  // Use the normalised expression (trimmed, single-space) from here on.
  return { ok: true, normalisedSchedule: scheduleValidation.expression };
}

export function createCron(
  params: CreateCronParams,
  deps: CronDeps = makeDefaultDeps()
): CreateCronResult {
  const { schedule, target, message, enabled } = params;
  const targetType = params.targetType ?? "agent";

  // SECURITY: validate + normalise schedule (and agent message) before building
  // any crontab line. Shared with updateCron so create + edit never drift.
  const inputValidation = validateCronWriteInputs(schedule, message, targetType);
  if (!inputValidation.ok) {
    return { ok: false, error: inputValidation.error };
  }
  const normalisedSchedule = inputValidation.normalisedSchedule;

  // Validate target against known agent dirs.
  const knownAgents = deps.listAgentDirs();
  if (!knownAgents.includes(target)) {
    return { ok: false, error: `Unknown target agent: "${target}". Must match an existing ~/agents/* directory.` };
  }

  const home = deps.homedir();
  const id = crypto.randomUUID().slice(0, 8);
  const scriptPath = path.join(home, "agents", target, "bin", `cron-nudge-${id}.sh`);
  const tag = enabled ? activeTag(id) : disabledTag(id);

  // RMW crontab with dedup-guard (read first, before writing the script).
  const existing = deps.readCrontab();
  const lines = existing ? existing.split("\n") : [];
  // Strip trailing empty strings so appending a new line never produces a
  // blank separator line between the existing content and the new entry.
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  // Dedup-guard: reject if the same schedule+target combination is already
  // managed. scriptPath encodes a fresh UUID each call so it is not a useful
  // dedup key; schedule + target agent path prefix is the real signal.
  const targetPrefix = path.join(home, "agents", target, "bin");
  const alreadyExists = lines.some((l) => {
    const tagInfo = extractTag(l);
    if (!tagInfo) return false;
    const parsed = tagInfo.enabled ? parseCronLine(l) : parseDisabledCronLine(l);
    if (!parsed) return false;
    return (
      parsed.schedule === normalisedSchedule &&
      parsed.scriptPath.startsWith(targetPrefix + path.sep)
    );
  });
  if (alreadyExists) {
    return {
      ok: false,
      error: `A cron entry for schedule "${normalisedSchedule}" targeting "${target}" already exists.`,
    };
  }

  // The cron line format (same for both target types: the .sh path is what runs).
  const cronLine = enabled
    ? `${normalisedSchedule} ${scriptPath} ${tag}`
    : `# ${normalisedSchedule} ${scriptPath} ${tag}`;

  if (targetType === "agent") {
    // Agent mode: write the prompt to a sibling .prompt.md file, then write
    // the nudge script that delivers it via bracketed-paste.
    // .prompt.md is data (not executable) -- use 0o644.
    const promptFilePath = scriptPath.replace(/\.sh$/, ".prompt.md");
    deps.writeScript(promptFilePath, message, 0o644);
    const scriptContent = buildNudgeScript(target, id, promptFilePath, deps.inboxRoot());
    deps.writeScript(scriptPath, scriptContent);
  } else {
    // Script mode: write the message body directly as the executable script.
    // No prompt file. The crontab line runs it directly (same format).
    // Script body is code-by-definition; SHELL_UNSAFE_RE never applied here.
    deps.writeScript(scriptPath, message);
  }

  // Append the new line.
  const newLines = [...lines, cronLine];
  // Ensure trailing newline (crontab convention).
  const newContent = normaliseContent(newLines);
  deps.writeCrontab(newContent);

  return { ok: true, id, scriptPath };
}

// ---------------------------------------------------------------------------
// updateCron
// ---------------------------------------------------------------------------

export interface UpdateCronParams {
  id: string;
  schedule: string;
  target: string;
  message: string;
  enabled: boolean;
  targetType?: "agent" | "script";
}

export type UpdateCronResult =
  | { ok: true; id: string; scriptPath: string }
  | { ok: false; error: string };

/**
 * Update an existing managed nudge in place: re-write its crontab line and
 * regenerate its script (+ prompt file in agent mode), mirroring createCron's
 * write path and state handling.
 *
 * SECURITY: an edit RE-WRITES the crontab line, so it MUST run the EXACT same
 * validation as createCron BEFORE writing anything. It calls the SHARED
 * validateCronWriteInputs helper (CR/LF reject + validateCronExpression +
 * normalised-expression + agent-message TMUX_UNSAFE_CTRL_RE) so the create and
 * edit paths cannot drift and reopen the crontab-injection hole on edit. The
 * NORMALISED schedule (never the raw input) is what reaches the crontab line.
 */
export function updateCron(
  params: UpdateCronParams,
  deps: CronDeps = makeDefaultDeps()
): UpdateCronResult {
  const { id, schedule, target, message, enabled } = params;
  const targetType = params.targetType ?? "agent";

  // SECURITY: identical validation to createCron, via the shared helper.
  const inputValidation = validateCronWriteInputs(schedule, message, targetType);
  if (!inputValidation.ok) {
    return { ok: false, error: inputValidation.error };
  }
  const normalisedSchedule = inputValidation.normalisedSchedule;

  // Validate target against known agent dirs (same gate as create).
  const knownAgents = deps.listAgentDirs();
  if (!knownAgents.includes(target)) {
    return { ok: false, error: `Unknown target agent: "${target}". Must match an existing ~/agents/* directory.` };
  }

  // Locate the existing managed line by id and capture its old script path so
  // we can clean up files if the target (and therefore the path) changes.
  const raw = deps.readCrontab();
  const lines = raw.split("\n");
  let found = false;
  let oldScriptPath = "";

  for (const line of lines) {
    const tagInfo = extractTag(line);
    if (!tagInfo || tagInfo.id !== id) continue;
    found = true;
    const parsed = tagInfo.enabled ? parseCronLine(line) : parseDisabledCronLine(line);
    if (parsed) oldScriptPath = parsed.scriptPath;
    break;
  }

  if (!found) {
    return { ok: false, error: `No cron entry found with id "${id}".` };
  }

  const home = deps.homedir();
  // Keep the same id; rebuild the script path from the (possibly new) target.
  const scriptPath = path.join(home, "agents", target, "bin", `cron-nudge-${id}.sh`);
  const tag = enabled ? activeTag(id) : disabledTag(id);
  const cronLine = enabled
    ? `${normalisedSchedule} ${scriptPath} ${tag}`
    : `# ${normalisedSchedule} ${scriptPath} ${tag}`;

  // Re-write the script (+ prompt file in agent mode) - identical write-shape
  // to createCron so an edited entry is byte-for-byte equivalent to a freshly
  // created one with the new values.
  if (targetType === "agent") {
    const promptFilePath = scriptPath.replace(/\.sh$/, ".prompt.md");
    deps.writeScript(promptFilePath, message, 0o644);
    const scriptContent = buildNudgeScript(target, id, promptFilePath, deps.inboxRoot());
    deps.writeScript(scriptPath, scriptContent);
  } else {
    deps.writeScript(scriptPath, message);
  }

  // Replace the managed line in place (preserve position; leave every other
  // line - including untagged mem-monitor/hand-added lines - untouched).
  const newLines = lines.map((line) => {
    const tagInfo = extractTag(line);
    if (!tagInfo || tagInfo.id !== id) return line;
    return cronLine;
  });
  deps.writeCrontab(normaliseContent(newLines));

  // If the target changed, the script path moved: delete the stale old files.
  if (oldScriptPath && oldScriptPath !== scriptPath) {
    deps.deleteScript(oldScriptPath);
    deps.deleteScript(oldScriptPath.replace(/\.sh$/, ".prompt.md"));
  }

  return { ok: true, id, scriptPath };
}

// ---------------------------------------------------------------------------
// setEnabled
// ---------------------------------------------------------------------------

export type SetEnabledResult = { ok: true } | { ok: false; error: string };

export function setEnabled(
  id: string,
  enabled: boolean,
  deps: CronDeps = makeDefaultDeps()
): SetEnabledResult {
  const raw = deps.readCrontab();
  const lines = raw.split("\n");
  let found = false;

  const newLines = lines.map((line) => {
    const tagInfo = extractTag(line);
    if (!tagInfo || tagInfo.id !== id) return line;
    found = true;

    if (tagInfo.enabled === enabled) {
      // No change needed.
      return line;
    }

    // Reconstruct from parsed components to avoid any accumulated tag artefacts.
    if (tagInfo.enabled && !enabled) {
      // Active -> disabled: parse schedule+scriptPath, reconstruct with single disabled tag.
      const parsed = parseCronLine(line);
      if (!parsed) return line; // Guard: should not happen on a well-formed active line.
      return `# ${parsed.schedule} ${parsed.scriptPath} ${disabledTag(id)}`;
    }
    // Disabled -> active: parse schedule+scriptPath, reconstruct with single active tag.
    const parsed = parseDisabledCronLine(line);
    if (!parsed) return line; // Guard: should not happen on a well-formed disabled line.
    return `${parsed.schedule} ${parsed.scriptPath} ${activeTag(id)}`;
  });

  if (!found) {
    return { ok: false, error: `No cron entry found with id "${id}".` };
  }

  deps.writeCrontab(normaliseContent(newLines));
  return { ok: true };
}

// ---------------------------------------------------------------------------
// deleteCron
// ---------------------------------------------------------------------------

export type DeleteCronResult = { ok: true } | { ok: false; error: string };

export function deleteCron(
  id: string,
  deps: CronDeps = makeDefaultDeps()
): DeleteCronResult {
  const raw = deps.readCrontab();
  const lines = raw.split("\n");
  let found = false;
  let removedScriptPath = "";

  const newLines = lines.filter((line) => {
    const tagInfo = extractTag(line);
    if (!tagInfo || tagInfo.id !== id) return true;
    found = true;
    // Extract script path for cleanup.
    const parsed = tagInfo.enabled
      ? parseCronLine(line)
      : parseDisabledCronLine(line);
    if (parsed) removedScriptPath = parsed.scriptPath;
    return false; // Remove this line.
  });

  if (!found) {
    return { ok: false, error: `No cron entry found with id "${id}".` };
  }

  deps.writeCrontab(normaliseContent(newLines));

  if (removedScriptPath) {
    // Delete the script file.
    deps.deleteScript(removedScriptPath);
    // Delete the prompt file sibling (agent mode). deleteScript ignores
    // missing files so this is safe for script-mode crons too.
    const promptFilePath = removedScriptPath.replace(/\.sh$/, ".prompt.md");
    deps.deleteScript(promptFilePath);
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// listAgentDirs (exported for use in route loaders)
// ---------------------------------------------------------------------------

export function listAgentDirs(deps: CronDeps = makeDefaultDeps()): string[] {
  return deps.listAgentDirs();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalise crontab content: pop trailing blank lines, ensure single trailing newline. */
function normaliseContent(lines: string[]): string {
  // Pop trailing empty strings to prevent blank-line accumulation on repeated
  // create/delete cycles (splitting a newline-terminated crontab on "\n" gives
  // a trailing empty string; spreading into a new array and appending would
  // accumulate one per operation).
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  // Crontab convention: end with exactly one newline.
  return lines.join("\n") + "\n";
}

/** Exported for tests only. */
export { buildNudgeScript };
