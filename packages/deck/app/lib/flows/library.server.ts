/**
 * library.server.ts - File-based flow library, draft storage, template diffing, and promotion.
 *
 * Lookup precedence:
 * 1. <projectRoot>/.deck/flows/<name>.yaml (source: "project")
 * 2. <dataRoot>/flows/library/<name>.yaml (source: "library")
 * 3. <builtinsDir>/<name>.yaml (source: "builtin", repo flows/library/)
 *
 * Enforces:
 * - Strict FlowIdRegex validation on all flow names and draft names.
 * - Path confinement and symlink/hardlink refusal via owner.server.ts and load-run.server.ts.
 * - Single YAML parser boundary via validateFlowYaml in validator.ts.
 * - Atomic temp-file + fsync + rename writes for drafts and promotions.
 *
 * ASCII only - no em-dashes.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeUnifiedDiff } from "./diff.js";
import { assertConfinedPath, PathConfinementError } from "./load-run.server.js";
import { assertSafeRegularFile, fsyncDirectory, resolveFlowsRootDir } from "./owner.server.js";
import { FlowIdRegex, type FlowDefinition } from "./types.js";
import { validateFlowYaml } from "./validator.js";

export type FlowLibrarySource = "project" | "library" | "builtin";

export interface FlowLibraryOptions {
  projectRoot?: string;
  dataRoot?: string;
  builtinsDir?: string;
  maxDefinitionBytes?: number;
}

export interface LoadedFlowDefinition {
  flowRef: string;
  source: FlowLibrarySource;
  path: string;
  yaml: string;
  flow: FlowDefinition;
  hash: string;
}

export interface AvailableFlowEntry {
  flowRef: string;
  source: FlowLibrarySource;
  path: string;
  title?: string;
  hash: string;
  stepCount: number;
  hasWorkspace: boolean;
}

export interface AvailableFlowDraftEntry {
  draftName: string;
  flowRef: string;
  path: string;
  title?: string;
  hash: string;
  stepCount: number;
}

export interface AvailableFlowsListing {
  flows: AvailableFlowEntry[];
  drafts: AvailableFlowDraftEntry[];
}

export class FlowNotFoundError extends Error {
  constructor(public readonly flowRef: string) {
    super(`Flow definition '${flowRef}' not found in project, library, or builtin directories`);
    this.name = "FlowNotFoundError";
  }
}

export class FlowValidationError extends Error {
  constructor(
    public readonly flowRef: string,
    public readonly errors: Array<{ path: string; code: string; message: string }>,
  ) {
    super(
      `Flow definition '${flowRef}' failed validation: ${errors
        .map((e) => `${e.path || "<root>"}: ${e.message}`)
        .join("; ")}`,
    );
    this.name = "FlowValidationError";
  }
}

const DEFAULT_BUILTINS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../../flows/library",
);

export function resolveDefaultBuiltinsDir(): string {
  if (fs.existsSync(DEFAULT_BUILTINS_DIR)) {
    return DEFAULT_BUILTINS_DIR;
  }
  const cwdCandidate = path.resolve(process.cwd(), "flows/library");
  if (fs.existsSync(cwdCandidate)) {
    return cwdCandidate;
  }
  const parentCandidate = path.resolve(process.cwd(), "../../flows/library");
  if (fs.existsSync(parentCandidate)) {
    return parentCandidate;
  }
  return DEFAULT_BUILTINS_DIR;
}

function assertValidFlowName(name: string, label = "flowRef"): void {
  if (typeof name !== "string" || !FlowIdRegex.test(name)) {
    throw new PathConfinementError(String(name), label);
  }
}

function resolveProjectFlowsDir(projectRoot: string): string {
  const resolvedProject = path.resolve(projectRoot);
  const deckDir = path.join(resolvedProject, ".deck");
  const flowsDir = path.join(deckDir, "flows");
  assertConfinedPath(flowsDir, resolvedProject);
  return flowsDir;
}

function resolveProjectDraftsDir(projectRoot: string): string {
  const resolvedProject = path.resolve(projectRoot);
  const draftsDir = path.join(resolvedProject, ".deck", "flows", "drafts");
  assertConfinedPath(draftsDir, resolvedProject);
  return draftsDir;
}

function resolveLibraryDir(dataRoot?: string): string | null {
  try {
    const flowsRoot = resolveFlowsRootDir(dataRoot);
    const libDir = path.join(flowsRoot, "library");
    assertConfinedPath(libDir, flowsRoot);
    return libDir;
  } catch (err) {
    // If dataRoot was explicitly supplied by caller, propagate safety/confinement errors.
    if (dataRoot !== undefined) {
      throw err;
    }
    return null;
  }
}

function readConfinedYamlFile(
  filePath: string,
  rootDir: string,
  flowRef: string,
  maxBytes?: number,
): { yaml: string; flow: FlowDefinition; hash: string } | null {
  assertConfinedPath(filePath, rootDir);
  const checked = assertSafeRegularFile(filePath, rootDir, { readBytes: true, maxBytes });
  if (!checked || !checked.bytes) return null;

  const yaml = checked.bytes.toString("utf8");
  const validation = validateFlowYaml(yaml);
  if (!validation.valid) {
    throw new FlowValidationError(flowRef, validation.errors);
  }
  return { yaml, flow: validation.flow, hash: validation.hash };
}

function readAvailableFlow(filePath: string, rootDir: string, flowRef: string) {
  try {
    return readConfinedYamlFile(filePath, rootDir, flowRef);
  } catch (err) {
    if (err instanceof FlowValidationError) return null;
    throw err;
  }
}

function ensureConfinedDirectory(targetDir: string, rootDir: string, mode = 0o755): void {
  const confined = assertConfinedPath(targetDir, rootDir);
  const resolvedRoot = path.resolve(rootDir);
  const rel = path.relative(resolvedRoot, confined);
  let cur = resolvedRoot;
  if (!fs.existsSync(cur)) {
    fs.mkdirSync(cur, { recursive: true, mode });
  }
  if (!rel) return;
  for (const segment of rel.split(path.sep)) {
    cur = path.join(cur, segment);
    const st = fs.lstatSync(cur, { throwIfNoEntry: false });
    if (st) {
      if (st.isSymbolicLink() || !st.isDirectory()) {
        throw new Error(`Expected regular directory (symlink/non-directory forbidden): ${cur}`);
      }
    } else {
      fs.mkdirSync(cur, { mode });
    }
  }
}

function writeAtomicConfinedFile(
  targetPath: string,
  rootDir: string,
  content: string,
  overwrite = true,
): void {
  const confined = assertConfinedPath(targetPath, rootDir);
  const parentDir = path.dirname(confined);
  ensureConfinedDirectory(parentDir, rootDir);

  // Refuse overwriting an existing symlink or hardlink
  const existing = fs.lstatSync(confined, { throwIfNoEntry: false });
  if (existing) {
    if (existing.isSymbolicLink()) {
      throw new Error(`Symlink file forbidden: ${confined}`);
    }
    if (!existing.isFile()) {
      throw new Error(`Expected regular file (non-regular inode forbidden): ${confined}`);
    }
    if (existing.nlink > 1) {
      throw new Error(`Hard-linked file forbidden (nlink=${existing.nlink}): ${confined}`);
    }
  }

  const tmpName = `.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  const tmpPath = path.join(parentDir, tmpName);
  assertConfinedPath(tmpPath, rootDir);

  const flags =
    fs.constants.O_CREAT |
    fs.constants.O_EXCL |
    fs.constants.O_WRONLY |
    (fs.constants.O_NOFOLLOW ?? 0);
  const fd = fs.openSync(tmpPath, flags, 0o600);
  try {
    fs.writeFileSync(fd, content, "utf8");
    fs.fsyncSync(fd);
  } catch (err) {
    try {
      fs.closeSync(fd);
    } catch {
      // ignore
    }
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore
    }
    throw err;
  }
  fs.closeSync(fd);

  try {
    if (overwrite) {
      fs.renameSync(tmpPath, confined);
    } else {
      fs.linkSync(tmpPath, confined);
      fs.unlinkSync(tmpPath);
    }
    fsyncDirectory(parentDir);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore
    }
    throw err;
  }
}

function scanFlowDirectory(
  dirPath: string,
  rootDir: string,
): Array<{ name: string; filePath: string; flow: FlowDefinition; hash: string }> {
  assertConfinedPath(dirPath, rootDir);
  const dirStat = fs.lstatSync(dirPath, { throwIfNoEntry: false });
  if (!dirStat) return [];
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    throw new Error(`Symlink or non-directory forbidden in flow library: ${dirPath}`);
  }

  const entries = fs.readdirSync(dirPath, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const results: Array<{ name: string; filePath: string; flow: FlowDefinition; hash: string }> = [];

  for (const entry of entries) {
    if (!entry.name.endsWith(".yaml")) continue;
    const base = entry.name.slice(0, -".yaml".length);
    if (!FlowIdRegex.test(base)) continue;

    const fullPath = path.join(dirPath, entry.name);
    const loaded = readAvailableFlow(fullPath, rootDir, base);
    if (loaded) {
      results.push({
        name: base,
        filePath: fullPath,
        flow: loaded.flow,
        hash: loaded.hash,
      });
    }
  }
  return results;
}

/**
 * Load a single flow definition following strict precedence:
 * project (.deck/flows) -> library (<dataRoot>/flows/library) -> builtin (flows/library).
 */
export function loadFlowDefinition(
  flowRef: string,
  opts: FlowLibraryOptions = {},
): LoadedFlowDefinition {
  assertValidFlowName(flowRef, "flowRef");
  const filename = `${flowRef}.yaml`;

  const candidates: Array<{ source: FlowLibrarySource; dir: string; root: string }> = [];
  if (opts.projectRoot) {
    const resolvedProject = path.resolve(opts.projectRoot);
    candidates.push({
      source: "project",
      dir: resolveProjectFlowsDir(resolvedProject),
      root: resolvedProject,
    });
  }

  const libDir = resolveLibraryDir(opts.dataRoot);
  if (libDir) {
    const flowsRoot = resolveFlowsRootDir(opts.dataRoot);
    candidates.push({
      source: "library",
      dir: libDir,
      root: flowsRoot,
    });
  }

  const builtinsDir = path.resolve(opts.builtinsDir ?? resolveDefaultBuiltinsDir());
  candidates.push({
    source: "builtin",
    dir: builtinsDir,
    root: builtinsDir,
  });

  let invalidDefinition: FlowValidationError | undefined;
  for (const candidate of candidates) {
    const targetPath = path.join(candidate.dir, filename);
    let loaded: ReturnType<typeof readConfinedYamlFile>;
    try {
      loaded = readConfinedYamlFile(targetPath, candidate.root, flowRef, opts.maxDefinitionBytes);
    } catch (err) {
      if (!(err instanceof FlowValidationError)) throw err;
      invalidDefinition ??= err;
      continue;
    }
    if (loaded) {
      return {
        flowRef,
        source: candidate.source,
        path: targetPath,
        yaml: loaded.yaml,
        flow: loaded.flow,
        hash: loaded.hash,
      };
    }
  }

  throw invalidDefinition ?? new FlowNotFoundError(flowRef);
}

/**
 * List available flows across project, library, and builtin roots (deduplicated by precedence)
 * along with project drafts under <projectRoot>/.deck/flows/drafts/*.yaml.
 */
export function listAvailableFlows(opts: FlowLibraryOptions = {}): AvailableFlowsListing {
  const seen = new Map<string, AvailableFlowEntry>();

  const registerDir = (source: FlowLibrarySource, dir: string, root: string) => {
    for (const item of scanFlowDirectory(dir, root)) {
      if (seen.has(item.name)) continue;
      seen.set(item.name, {
        flowRef: item.name,
        source,
        path: item.filePath,
        ...(item.flow.title ? { title: item.flow.title } : {}),
        hash: item.hash,
        stepCount: item.flow.steps.length,
        hasWorkspace: Boolean(item.flow.workspace),
      });
    }
  };

  if (opts.projectRoot) {
    const resolvedProject = path.resolve(opts.projectRoot);
    registerDir("project", resolveProjectFlowsDir(resolvedProject), resolvedProject);
  }

  const libDir = resolveLibraryDir(opts.dataRoot);
  if (libDir) {
    const flowsRoot = resolveFlowsRootDir(opts.dataRoot);
    registerDir("library", libDir, flowsRoot);
  }

  const builtinsDir = path.resolve(opts.builtinsDir ?? resolveDefaultBuiltinsDir());
  if (fs.existsSync(builtinsDir)) {
    registerDir("builtin", builtinsDir, builtinsDir);
  }

  const drafts: AvailableFlowDraftEntry[] = [];
  if (opts.projectRoot) {
    const resolvedProject = path.resolve(opts.projectRoot);
    const draftsDir = resolveProjectDraftsDir(resolvedProject);
    for (const item of scanFlowDirectory(draftsDir, resolvedProject)) {
      drafts.push({
        draftName: item.name,
        flowRef: item.flow.flow,
        path: item.filePath,
        ...(item.flow.title ? { title: item.flow.title } : {}),
        hash: item.hash,
        stepCount: item.flow.steps.length,
      });
    }
  }

  const flows = Array.from(seen.values()).sort((a, b) => a.flowRef.localeCompare(b.flowRef));
  return { flows, drafts };
}

/**
 * Load an existing project draft from <projectRoot>/.deck/flows/drafts/<draftName>.yaml.
 */
export function loadFlowDraft(params: {
  projectRoot: string;
  draftName: string;
}): { draftName: string; path: string; yaml: string; flow: FlowDefinition; hash: string } {
  assertValidFlowName(params.draftName, "draftName");
  const resolvedProject = path.resolve(params.projectRoot);
  const draftsDir = resolveProjectDraftsDir(resolvedProject);
  const draftPath = path.join(draftsDir, `${params.draftName}.yaml`);
  const loaded = readConfinedYamlFile(draftPath, resolvedProject, params.draftName);
  if (!loaded) {
    throw new FlowNotFoundError(params.draftName);
  }
  return {
    draftName: params.draftName,
    path: draftPath,
    yaml: loaded.yaml,
    flow: loaded.flow,
    hash: loaded.hash,
  };
}

export { computeUnifiedDiff };

/**
 * Validate a flow draft via validateFlowYaml BEFORE atomically writing it to
 * <projectRoot>/.deck/flows/drafts/<draftName>.yaml. Optionally computes unified diff
 * against a base template flowRef.
 */
export function saveFlowDraft(params: {
  projectRoot: string;
  draftName: string;
  yaml: string;
  overwrite?: boolean;
  baseTemplateRef?: string;
  dataRoot?: string;
  builtinsDir?: string;
}): {
  path: string;
  hash: string;
  flow: FlowDefinition;
  diffFromTemplate: string | null;
} {
  assertValidFlowName(params.draftName, "draftName");

  const validation = validateFlowYaml(params.yaml);
  if (!validation.valid) {
    throw new FlowValidationError(params.draftName, validation.errors);
  }

  let diffFromTemplate: string | null = null;
  if (params.baseTemplateRef) {
    const base = loadFlowDefinition(params.baseTemplateRef, {
      projectRoot: params.projectRoot,
      dataRoot: params.dataRoot,
      builtinsDir: params.builtinsDir,
    });
    diffFromTemplate = computeUnifiedDiff(
      base.yaml,
      params.yaml,
      `${base.source}/${base.flowRef}.yaml`,
      `drafts/${params.draftName}.yaml`,
    );
  }

  const resolvedProject = path.resolve(params.projectRoot);
  const draftsDir = resolveProjectDraftsDir(resolvedProject);
  const targetPath = path.join(draftsDir, `${params.draftName}.yaml`);
  writeAtomicConfinedFile(targetPath, resolvedProject, params.yaml, params.overwrite);

  return {
    path: targetPath,
    hash: validation.hash,
    flow: validation.flow,
    diffFromTemplate,
  };
}

/**
 * Promote a validated project draft to either the project flow library
 * (<projectRoot>/.deck/flows/<draftName>.yaml) or the user Deck library
 * (<dataRoot>/flows/library/<draftName>.yaml).
 */
export function promoteFlowDraft(params: {
  projectRoot: string;
  draftName: string;
  target: "library" | "project";
  dataRoot?: string;
}): LoadedFlowDefinition {
  assertValidFlowName(params.draftName, "draftName");
  const draft = loadFlowDraft({
    projectRoot: params.projectRoot,
    draftName: params.draftName,
  });

  if (params.target === "project") {
    const resolvedProject = path.resolve(params.projectRoot);
    const projectFlowsDir = resolveProjectFlowsDir(resolvedProject);
    const destPath = path.join(projectFlowsDir, `${params.draftName}.yaml`);
    writeAtomicConfinedFile(destPath, resolvedProject, draft.yaml);
    return {
      flowRef: params.draftName,
      source: "project",
      path: destPath,
      yaml: draft.yaml,
      flow: draft.flow,
      hash: draft.hash,
    };
  }

  const flowsRoot = resolveFlowsRootDir(params.dataRoot);
  const libDir = path.join(flowsRoot, "library");
  assertConfinedPath(libDir, flowsRoot);
  const destPath = path.join(libDir, `${params.draftName}.yaml`);
  writeAtomicConfinedFile(destPath, flowsRoot, draft.yaml);
  return {
    flowRef: params.draftName,
    source: "library",
    path: destPath,
    yaml: draft.yaml,
    flow: draft.flow,
    hash: draft.hash,
  };
}
