/**
 * file-description.server.ts - gemini-3.5-flash-lite description generator +
 * HEAVY per-call spend logging + persisted description cache.
 *
 * SPEC B (decided, Alex 2026-06-18): "follow Nova's AI SDK pattern but with
 * heavy logging, especially on spend." Model gemini-3.5-flash-lite via
 * @ai-sdk/google (createGoogleGenerativeAI({ apiKey: process.env
 * .GOOGLE_GENERATIVE_AI_API_KEY }) then googleProvider(model)), generateText.
 *
 * Three responsibilities:
 *   1. generateDescription(ref) - one gemini call summarising the messages
 *      SURROUNDING where a file was shared into a 1-2 sentence "what this file
 *      is and why it came up here".
 *   2. HEAVY spend logging - EVERY call appends a JSONL line (tokens + computed
 *      USD cost + thread/file context) to data/gemini-spend.jsonl. This is the
 *      cost-control mechanism (per Alex), not a gate. Totalable with `jq` or
 *      sumGeminiSpend().
 *   3. Persisted description cache keyed by (path + window hash) so each
 *      description generates ONCE, never on render.
 *
 * Graceful degrade (SPEC B): on missing key / SDK error, return the link text
 * as the description so the panel still works.
 *
 * Server-side only (.server suffix strips it from the client bundle). The
 * GOOGLE_GENERATIVE_AI_API_KEY never reaches the client.
 *
 * ASCII only - no em-dashes (FND-05).
 */

import fs from "node:fs";
import path from "node:path";
import {
  atomicWrite,
  assertNoLiveSiloRoot,
  confineToRootReal,
} from "./safe-fs.server.js";
import { resolveDataRoot } from "./queue.server.js";
import type { FileReference } from "./file-manifest.js";
import { descriptionCacheKey } from "./file-manifest.js";

// ---------------------------------------------------------------------------
// Model + pricing
// ---------------------------------------------------------------------------

/**
 * The model id. Must be a model the live API serves for generateContent.
 * gemini-3.5-flash-lite is now GA and verified live (2026-07-22): a real
 * generateContent call returns HTTP 200 with modelVersion
 * gemini-3.5-flash-lite-07-2026. It is the current flash-lite tier.
 *
 * History: at first ship (2026-06-18) gemini-3.5-flash-lite 404'd ("not found
 * for API version v1beta") and silently degraded every description to
 * link-text, so we fell back to gemini-3.1-flash-lite (the newest GA tier at
 * that time). That fallback is no longer needed now 3.5 has shipped.
 */
export const DESCRIPTION_MODEL = "gemini-3.5-flash-lite";

/**
 * Published gemini-3.5-flash-lite price, USD per 1,000,000 tokens.
 *
 * Flash-lite is the cheapest tier. These are the published per-Mtok rates used
 * to compute the logged USD cost. Overridable via env so a price change does
 * not need a code edit:
 *   GEMINI_FLASH_LITE_INPUT_USD_PER_MTOK
 *   GEMINI_FLASH_LITE_OUTPUT_USD_PER_MTOK
 *
 * Defaults reflect the flash-lite published rate at build time
 * (input $0.10 / Mtok, output $0.40 / Mtok). A description call is a few-hundred
 * tokens, so cost-per-call is well under a cent (SPEC B "cheap").
 */
const DEFAULT_INPUT_USD_PER_MTOK = 0.1;
const DEFAULT_OUTPUT_USD_PER_MTOK = 0.4;

function inputRate(): number {
  const raw = process.env["GEMINI_FLASH_LITE_INPUT_USD_PER_MTOK"];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : DEFAULT_INPUT_USD_PER_MTOK;
}

function outputRate(): number {
  const raw = process.env["GEMINI_FLASH_LITE_OUTPUT_USD_PER_MTOK"];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : DEFAULT_OUTPUT_USD_PER_MTOK;
}

/**
 * Compute USD cost from token counts and the per-Mtok rates.
 * Pure - exported for the unit test (the cost-calc is required test coverage).
 */
export function computeCostUsd(
  promptTokens: number,
  completionTokens: number,
  inputUsdPerMtok: number = DEFAULT_INPUT_USD_PER_MTOK,
  outputUsdPerMtok: number = DEFAULT_OUTPUT_USD_PER_MTOK
): number {
  const input = (promptTokens / 1_000_000) * inputUsdPerMtok;
  const output = (completionTokens / 1_000_000) * outputUsdPerMtok;
  return input + output;
}

// ---------------------------------------------------------------------------
// Paths (under DATA_ROOT, same root as queue-state.json)
// ---------------------------------------------------------------------------

function descriptionCachePath(): string {
  return (
    process.env["FILE_DESCRIPTION_CACHE_PATH"] ??
    path.join(process.cwd(), "data", "file-descriptions.json")
  );
}

function spendLogPath(): string {
  return (
    process.env["GEMINI_SPEND_LOG_PATH"] ??
    path.join(process.cwd(), "data", "gemini-spend.jsonl")
  );
}

// ---------------------------------------------------------------------------
// Confined write helper (mirrors FileQueueStore.saveState - DATA_ROOT confined)
// ---------------------------------------------------------------------------

function confinedWrite(targetPath: string, data: string): void {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const rootReal = fs.realpathSync(resolveDataRoot());
  assertNoLiveSiloRoot(rootReal, "data");
  const resolved = confineToRootReal(targetPath, rootReal, {
    forWrite: true,
    label: "data",
  });
  atomicWrite(resolved, data);
}

/** Append a single line to a DATA_ROOT-confined file (spend log JSONL). */
function confinedAppendLine(targetPath: string, line: string): void {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const rootReal = fs.realpathSync(resolveDataRoot());
  assertNoLiveSiloRoot(rootReal, "data");
  const resolved = confineToRootReal(targetPath, rootReal, {
    forWrite: true,
    label: "data",
  });
  fs.appendFileSync(resolved, line.endsWith("\n") ? line : line + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// Description cache (JSON: { version, descriptions: { key -> entry } })
// ---------------------------------------------------------------------------

interface CachedDescription {
  /** The generated (or fallback) description text. */
  description: string;
  /** Whether the text came from gemini (true) or the link-text fallback (false). */
  generated: boolean;
  /** ISO timestamp the entry was written. */
  at: string;
}

interface DescriptionCacheFile {
  version: 1;
  descriptions: Record<string, CachedDescription>;
}

/**
 * MR !17: closes the residual N+1 lag behind the file-panel virtualisation fix
 * which cached the manifest read but never touched this cache.
 *
 * In-module memoisation for loadCache(), mirroring file-manifest-cache.server.ts:
 * an mtime/size-guarded copy of the parsed cache file, re-read from disk only
 * when the file does not yet exist in memory or its underlying mtime/size has
 * changed since the last read.
 *
 * WHY: the file-descriptions.json store is a single global accumulating one
 * entry per described file system-wide, so it grows unbounded. loadCache() runs
 * once PER file reference on every panel open (getCachedDescription), and once
 * per describe POST (generateDescription / saveCacheEntry). Doing a synchronous
 * readFileSync + JSON.parse of that whole file N times per open blocks Node's
 * event loop and stalls every concurrent request. Memoising collapses those N
 * reads to at most one.
 *
 * Keyed by resolved cache path so a test that repoints FILE_DESCRIPTION_CACHE_PATH
 * does not read a stale sibling's memo. The cached object is the single canonical
 * copy; it never escapes the module by reference (getCachedDescription returns a
 * string, generateDescription copies primitives into its result), so returning
 * the shared reference instead of a spread-copy is safe and lets writers update
 * the in-memory copy in place.
 */
interface DescriptionCacheMemo {
  mtimeMs: number;
  size: number;
  cache: DescriptionCacheFile;
}

/** (resolved cache path) -> last parsed cache file, tagged with mtime + size. */
const descriptionMemo = new Map<string, DescriptionCacheMemo>();

/** Test instrumentation: number of full disk read+parse runs performed. */
let cacheReadCount = 0;

/**
 * Return the parsed description cache, served from memory when the on-disk file
 * is unchanged since the last read (mtime + size both match). On a miss (first
 * read, an external change, or our own write bumping mtime) the file is read +
 * parsed once and the result replaces the memo entry. A missing file or bad JSON
 * degrades to an empty cache (never crash) and memoises nothing, so a later write
 * self-heals.
 *
 * The returned object is the shared canonical copy for this path: writers mutate
 * it in place (see saveCacheEntry) so a read straight after a write in the same
 * process sees fresh data with no re-read.
 */
function loadCache(): DescriptionCacheFile {
  const cachePath = descriptionCachePath();

  let stat: { mtimeMs: number; size: number } | null;
  try {
    const st = fs.statSync(cachePath);
    stat = { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    // ENOENT etc: no stable file to key a memo against.
    stat = null;
  }

  if (!stat) {
    descriptionMemo.delete(cachePath);
    return { version: 1, descriptions: {} };
  }

  const memo = descriptionMemo.get(cachePath);
  if (memo && memo.mtimeMs === stat.mtimeMs && memo.size === stat.size) {
    return memo.cache;
  }

  // Miss: pay the read+parse once, then memoise against this mtime + size.
  let cache: DescriptionCacheFile;
  try {
    const raw = fs.readFileSync(cachePath, "utf8");
    cacheReadCount += 1;
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      "descriptions" in parsed &&
      typeof (parsed as DescriptionCacheFile).descriptions === "object"
    ) {
      cache = {
        version: 1,
        descriptions: { ...(parsed as DescriptionCacheFile).descriptions },
      };
    } else {
      cache = { version: 1, descriptions: {} };
    }
  } catch {
    // File existed at stat time but is unreadable / bad JSON: degrade to empty,
    // memoise nothing (a later write recreates it cleanly).
    descriptionMemo.delete(cachePath);
    return { version: 1, descriptions: {} };
  }

  descriptionMemo.set(cachePath, { mtimeMs: stat.mtimeMs, size: stat.size, cache });
  return cache;
}

function saveCacheEntry(key: string, entry: CachedDescription): void {
  const cachePath = descriptionCachePath();
  const cache = loadCache();
  cache.descriptions[key] = entry;
  confinedWrite(cachePath, JSON.stringify(cache, null, 2) + "\n");

  // Re-tag the memo to the just-written file's mtime + size, keeping the (now
  // mutated) in-memory copy as the canonical entry. This is load-bearing: the
  // write bumps the file's mtime, so without re-tagging the next loadCache would
  // see a changed mtime and re-read from disk - which would re-introduce the
  // per-row read on a describe storm (each POST writes, so read k+1 would re-read
  // after write k). Re-tagging keeps the storm at one read total and makes the
  // fresh entry visible to a following getCachedDescription with no re-read.
  try {
    const st = fs.statSync(cachePath);
    descriptionMemo.set(cachePath, {
      mtimeMs: st.mtimeMs,
      size: st.size,
      cache,
    });
  } catch {
    // If we cannot stat the file we just wrote, drop the memo so the next read
    // re-reads from disk rather than trusting a possibly-mismatched tag.
    descriptionMemo.delete(cachePath);
  }
}

/** Read-only cache lookup (no write). Returns undefined on miss. */
export function getCachedDescription(ref: FileReference): string | undefined {
  const cache = loadCache();
  const entry = cache.descriptions[descriptionCacheKey(ref)];
  return entry?.description;
}

/** Test hook: clear the memoised cache + read counter between tests. */
export function __resetDescriptionCache(): void {
  descriptionMemo.clear();
  cacheReadCount = 0;
}

/** Test hook: total full disk read+parse runs since the last reset. */
export function __descriptionCacheReadCount(): number {
  return cacheReadCount;
}

// ---------------------------------------------------------------------------
// Spend logging
// ---------------------------------------------------------------------------

export interface SpendLogEntry {
  at: string;
  model: string;
  threadAgent: string;
  participant: string;
  filePath: string;
  cacheKey: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  /** "ok" | "error" | "no-key" - so a failed/degraded call is still logged. */
  outcome: "ok" | "error" | "no-key";
  /** Present when outcome !== "ok". */
  error?: string;
}

/**
 * Append a spend entry. HEAVY logging is a hard requirement - this is called on
 * EVERY description-generation attempt (success, error, and missing-key), so
 * the log totals the true gemini spend. Never throws (a logging failure must
 * not break the panel); a write error is itself console.warn'd.
 */
export function logSpend(entry: SpendLogEntry): void {
  try {
    confinedAppendLine(spendLogPath(), JSON.stringify(entry));
  } catch (err) {
    console.warn(
      `[file-description] spend-log write failed: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

/**
 * Total the spend log (utility for a future cost dashboard / quick check).
 * Returns aggregate tokens, USD, and call count. Degrades to zeros on any read
 * failure.
 */
export function sumGeminiSpend(): {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
} {
  const totals = { calls: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 };
  let raw: string;
  try {
    raw = fs.readFileSync(spendLogPath(), "utf8");
  } catch {
    return totals;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const e = JSON.parse(trimmed) as SpendLogEntry;
      totals.calls += 1;
      totals.promptTokens += e.promptTokens ?? 0;
      totals.completionTokens += e.completionTokens ?? 0;
      totals.costUsd += e.costUsd ?? 0;
    } catch {
      // skip malformed line
    }
  }
  return totals;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

function buildPrompt(ref: FileReference): string {
  const context = ref.surrounding
    .map((m) => `[${m.from}] ${m.body}`)
    .join("\n\n");
  return [
    "You are labelling a file that was shared in a chat thread between an AI agent and its principal.",
    "Given the file path/name and the messages around where it was shared, write ONE or TWO short sentences describing WHAT this file is and WHY it came up here.",
    "Be concrete and specific. No preamble, no quotes, no markdown, no em-dashes. Just the description.",
    "",
    `File: ${ref.path}`,
    `Link text the agent used: ${ref.linkText}`,
    "",
    "Surrounding messages:",
    context || "(no surrounding context)",
    "",
    "Description:",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// generateDescription
// ---------------------------------------------------------------------------

export interface DescribeContext {
  threadAgent: string;
  participant: string;
}

export interface DescribeResult {
  description: string;
  generated: boolean;
  cached: boolean;
}

/**
 * Get a rich description for a file reference. Cache-first: returns the cached
 * value without any gemini call (SPEC B "never regenerated on render"). On a
 * miss, makes ONE gemini-3.5-flash-lite call, logs spend, caches the result.
 *
 * Graceful degrade: missing key or SDK error returns the link text (still
 * logged to spend with outcome no-key/error and zero cost).
 */
export async function generateDescription(
  ref: FileReference,
  ctx: DescribeContext
): Promise<DescribeResult> {
  const key = descriptionCacheKey(ref);

  // Cache-first (no spend on a hit).
  const cache = loadCache();
  const hit = cache.descriptions[key];
  if (hit) {
    return { description: hit.description, generated: hit.generated, cached: true };
  }

  const fallback = ref.linkText || ref.name;
  const apiKey = process.env["GOOGLE_GENERATIVE_AI_API_KEY"];

  if (!apiKey || apiKey.trim() === "") {
    logSpend({
      at: new Date().toISOString(),
      model: DESCRIPTION_MODEL,
      threadAgent: ctx.threadAgent,
      participant: ctx.participant,
      filePath: ref.path,
      cacheKey: key,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      outcome: "no-key",
      error: "GOOGLE_GENERATIVE_AI_API_KEY unset",
    });
    // Cache the fallback so we do not re-attempt every render. A later key set
    // + cache clear regenerates; cheap and correct for the degraded path.
    saveCacheEntry(key, {
      description: fallback,
      generated: false,
      at: new Date().toISOString(),
    });
    return { description: fallback, generated: false, cached: false };
  }

  try {
    // Dynamic import keeps @ai-sdk/google out of any eager server graph and
    // makes the no-key path zero-dependency. Pattern per AgentProvider.ts.
    const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
    const { generateText } = await import("ai");

    const googleProvider = createGoogleGenerativeAI({ apiKey });
    const result = await generateText({
      model: googleProvider(DESCRIPTION_MODEL),
      prompt: buildPrompt(ref),
      // Keep it tight - 1-2 sentences. Bounds completion tokens (and cost).
      maxOutputTokens: 120,
      temperature: 0.3,
    });

    const text = (result.text ?? "").trim();
    const usage = (result.usage ?? {}) as Record<string, number | undefined>;
    // AI SDK v5: usage.inputTokens / usage.outputTokens (number | undefined).
    // Read defensively (older field names + undefined) and coerce to a number.
    const promptTokens =
      usage["inputTokens"] ?? usage["promptTokens"] ?? 0;
    const completionTokens =
      usage["outputTokens"] ?? usage["completionTokens"] ?? 0;
    const costUsd = computeCostUsd(
      promptTokens,
      completionTokens,
      inputRate(),
      outputRate()
    );

    const description = text || fallback;
    const generated = text !== "";

    logSpend({
      at: new Date().toISOString(),
      model: DESCRIPTION_MODEL,
      threadAgent: ctx.threadAgent,
      participant: ctx.participant,
      filePath: ref.path,
      cacheKey: key,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      costUsd,
      outcome: "ok",
    });

    saveCacheEntry(key, {
      description,
      generated,
      at: new Date().toISOString(),
    });

    return { description, generated, cached: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logSpend({
      at: new Date().toISOString(),
      model: DESCRIPTION_MODEL,
      threadAgent: ctx.threadAgent,
      participant: ctx.participant,
      filePath: ref.path,
      cacheKey: key,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      outcome: "error",
      error: msg,
    });
    console.warn(`[file-description] gemini call failed for "${ref.path}": ${msg}`);
    // Degrade to link text; do NOT cache an error so a transient failure can
    // be retried next open (cheap, and avoids pinning a bad description).
    return { description: fallback, generated: false, cached: false };
  }
}
