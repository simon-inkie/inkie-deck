/**
 * agent-model.server.ts - per-agent model selection seam (M4, selector contract).
 *
 * Source of truth is the boot-script contract (boot-agents.README.md, section
 * "Per-agent model selection"): one single-line file per agent, nothing
 * hardcoded.
 *
 *   <AGENTS_ROOT>/<agent>/.runtime  - claude | agy | codex (platform-layer owned).
 *     Picks which option set in the catalog applies to this agent.
 *   <AGENTS_ROOT>/<agent>/.model    - the exact string passed to the runtime's
 *     model flag and to in-session /model. MISSING = inherit the global
 *     default. Deck is a WRITER of this file (atomic temp + rename) and a
 *     reader for the configured-model display.
 *   <AGENTS_ROOT>/bin/model-catalog.json - option lists keyed by runtime,
 *     entries { id, label }. Platform-layer owned; Deck only reads it.
 *
 * AGENTS_ROOT is a NEW env var (default ~/agents, tilde expanded) because the
 * existing INBOX_ROOT points at the silo tree, not the agent homes. Unlike the
 * no-default roots, the contract names a default explicitly, so this
 * one has one - validateConfiguredRoots does not gate it.
 *
 * v1 is PERSIST-ONLY: setAgentModel writes the file and the change applies on
 * the agent's next boot/restart. NO live in-pane /model send happens here -
 * send-keys into a running turn lands as a conversation message, not a
 * command (plan review sharpening 4). The route reports liveSwitched: false
 * so the UI can say "applies on restart" honestly.
 *
 * SEAM RULE: .server module - routes/loaders call these with
 * process.env; no route touches fs or the agents path shape directly.
 * Reads degrade to null/empty (a broken root renders an absent control, never
 * a 500); writes go through confineToRoot + atomicWrite.
 *
 * ASCII only - no em-dashes.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AGENT_NAME_RE, confineToRoot, atomicWrite } from "./safe-fs.server";

// ---------------------------------------------------------------------------
// Types (the catalog contract)
// ---------------------------------------------------------------------------

/** One selectable model: id = exact runtime flag / "/model" value; label = display. */
export interface CatalogOption {
  id: string;
  label: string;
}

/** What GET returns for one agent: runtime marker, configured model, options. */
export interface AgentModelInfo {
  /** Single line of .runtime, or null when absent/unreadable. */
  runtime: string | null;
  /** Single line of .model, or null = inherit the global default. */
  model: string | null;
  /** Catalog options for this agent's runtime ([] for unknown/empty runtimes). */
  options: CatalogOption[];
}

export type SetModelResult = { ok: true } | { ok: false; error: string };

// ---------------------------------------------------------------------------
// AGENTS_ROOT resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the agent-homes root. AGENTS_ROOT env wins (with a leading ~
 * expanded against the home directory); the contract default is ~/agents.
 * Always returns an absolute path (a relative value resolves against cwd).
 */
export function resolveAgentsRoot(env: NodeJS.ProcessEnv): string {
  const raw = env["AGENTS_ROOT"]?.trim();
  if (!raw) return path.join(os.homedir(), "agents");
  if (raw === "~") return os.homedir();
  if (raw.startsWith("~/")) return path.join(os.homedir(), raw.slice(2));
  return path.resolve(raw);
}

// ---------------------------------------------------------------------------
// Reads (degrade to null/empty - never throw)
// ---------------------------------------------------------------------------

/** First line of a single-line marker file, trimmed; null when absent/empty. */
function readSingleLine(filePath: string): string | null {
  try {
    const line = fs.readFileSync(filePath, "utf8").split("\n")[0]!.trim();
    return line === "" ? null : line;
  } catch {
    return null;
  }
}

/**
 * Read + shape-validate the catalog. Unknown keys and malformed entries are
 * dropped rather than trusted - the catalog is hand-curated and a typo there
 * must degrade to a missing option, never a crash or a bogus dropdown row.
 * Returns {} when the file is absent or unparseable.
 */
export function readModelCatalog(
  env: NodeJS.ProcessEnv
): Record<string, CatalogOption[]> {
  const catalogPath = path.join(
    resolveAgentsRoot(env),
    "bin",
    "model-catalog.json"
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  const catalog: Record<string, CatalogOption[]> = {};
  for (const [runtime, value] of Object.entries(parsed)) {
    if (!Array.isArray(value)) continue;
    const options: CatalogOption[] = [];
    for (const entry of value) {
      if (
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { id?: unknown }).id === "string" &&
        (entry as { id: string }).id.trim() !== "" &&
        typeof (entry as { label?: unknown }).label === "string"
      ) {
        options.push({
          id: (entry as { id: string }).id,
          label: (entry as { label: string }).label,
        });
      }
    }
    catalog[runtime] = options;
  }
  return catalog;
}

/**
 * The GET view-model for one agent. An invalid name, a missing agent dir, or
 * an unreadable root all degrade to { runtime: null, model: null, options: [] }
 * - the UI simply renders no control.
 */
export function getAgentModelInfo(
  env: NodeJS.ProcessEnv,
  agent: string
): AgentModelInfo {
  if (!AGENT_NAME_RE.test(agent)) {
    return { runtime: null, model: null, options: [] };
  }
  const root = resolveAgentsRoot(env);
  const runtime = readSingleLine(path.join(root, agent, ".runtime"));
  const model = readSingleLine(path.join(root, agent, ".model"));
  const options =
    runtime !== null ? readModelCatalog(env)[runtime] ?? [] : [];
  return { runtime, model, options };
}

// ---------------------------------------------------------------------------
// Write (validate-then-persist; atomic temp + rename)
// ---------------------------------------------------------------------------

/**
 * Persist a model pick to <AGENTS_ROOT>/<agent>/.model.
 *
 * Validation before any write (parse-don't-validate at the seam):
 *   1. agent matches the ROSTER window-name regex (kills traversal shapes),
 *   2. the agent home exists under AGENTS_ROOT,
 *   3. model is one of the catalog options for that agent's .runtime - an
 *      empty option set (codex, agy pre-convergence, unknown runtime) means
 *      every model is rejected.
 *
 * The write itself is confined to AGENTS_ROOT (realpath + prefix assert,
 * the shared confineToRoot primitive) and atomic (temp file + same-dir rename), with a
 * trailing newline so the boot scripts' $(cat .model) reads clean.
 *
 * PERSIST-ONLY (v1): never touches a tmux pane. Returns { ok: false } with a
 * human-readable reason on any validation or fs failure - it never throws.
 */
export function setAgentModel(
  env: NodeJS.ProcessEnv,
  agent: string,
  model: string
): SetModelResult {
  if (!AGENT_NAME_RE.test(agent)) {
    return { ok: false, error: "Unknown or invalid agent." };
  }
  const root = resolveAgentsRoot(env);
  const agentDir = path.join(root, agent);
  let isDir = false;
  try {
    isDir = fs.statSync(agentDir).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    return { ok: false, error: `Unknown agent "${agent}".` };
  }

  const runtime = readSingleLine(path.join(agentDir, ".runtime"));
  const options = runtime !== null ? readModelCatalog(env)[runtime] ?? [] : [];
  if (options.length === 0) {
    return {
      ok: false,
      error: `No selectable models for ${agent} (runtime: ${runtime ?? "unknown"}).`,
    };
  }
  if (!options.some((o) => o.id === model)) {
    return {
      ok: false,
      error: `"${model}" is not in the ${runtime} model catalog.`,
    };
  }

  try {
    const resolved = confineToRoot(path.join(agentDir, ".model"), root, {
      forWrite: true,
      label: "agents",
    });
    atomicWrite(resolved, model + "\n");
    return { ok: true };
  } catch {
    return { ok: false, error: "Could not write the model file." };
  }
}
