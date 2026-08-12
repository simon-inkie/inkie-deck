/**
 * batch-prefs.ts - Per-browser preferences for the pending batch indicator (TASK-500.1).
 *
 * Client-only, SSR-safe. Persists to localStorage key mc.batchPrefs.v1.
 * Hydration-safe: starts from DEFAULT_BATCH_PREFS on both server and first
 * client render, then loads from localStorage in a useEffect after mount to
 * avoid SSR/client mismatch.
 *
 * No .server imports (FND-02). ASCII only (FND-05).
 */
import { useState, useEffect } from "react";

export type HoldIndicator = "none" | "subtle" | "pill";

export interface BatchPrefs {
  holdIndicator: HoldIndicator;
  holdSeconds: number;
  /** TASK-500.4: show in-progress composer text live in the pending bubble. */
  livePreview: boolean;
}

export const DEFAULT_BATCH_PREFS: BatchPrefs = {
  holdIndicator: "subtle",
  holdSeconds: 18,
  livePreview: true,
};

const STORAGE_KEY = "mc.batchPrefs.v1";
const MIN_HOLD_SECONDS = 2;
const MAX_HOLD_SECONDS = 300;

/** Clamp holdSeconds to the valid range [2, 300]. */
export function clampHoldSeconds(val: number): number {
  return Math.min(MAX_HOLD_SECONDS, Math.max(MIN_HOLD_SECONDS, val));
}

function readPrefs(): BatchPrefs {
  if (typeof window === "undefined") return DEFAULT_BATCH_PREFS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_BATCH_PREFS;
    const parsed = JSON.parse(raw) as Partial<BatchPrefs>;
    const holdIndicator =
      parsed.holdIndicator === "none" ||
      parsed.holdIndicator === "subtle" ||
      parsed.holdIndicator === "pill"
        ? parsed.holdIndicator
        : DEFAULT_BATCH_PREFS.holdIndicator;
    const holdSeconds =
      typeof parsed.holdSeconds === "number"
        ? clampHoldSeconds(parsed.holdSeconds)
        : DEFAULT_BATCH_PREFS.holdSeconds;
    const livePreview =
      typeof parsed.livePreview === "boolean"
        ? parsed.livePreview
        : DEFAULT_BATCH_PREFS.livePreview;
    return { holdIndicator, holdSeconds, livePreview };
  } catch {
    return DEFAULT_BATCH_PREFS;
  }
}

function writePrefs(prefs: BatchPrefs): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // ignore quota errors
  }
}

/**
 * useBatchPrefs - hydration-safe hook for batch display preferences.
 *
 * Returns [prefs, setPrefs]. The setter accepts a partial update; the
 * holdSeconds field is clamped to [2, 300] on every write.
 *
 * Single source of truth: call this ONCE in threads.$agent.tsx and pass
 * the prefs + setter down to Compose as props. Do NOT call useBatchPrefs
 * inside Compose.
 */
export function useBatchPrefs(): [BatchPrefs, (next: Partial<BatchPrefs>) => void] {
  const [prefs, setPrefsState] = useState<BatchPrefs>(DEFAULT_BATCH_PREFS);

  // Hydrate from localStorage after mount (avoids SSR/client mismatch).
  useEffect(() => {
    setPrefsState(readPrefs());
  }, []);

  function setPrefs(next: Partial<BatchPrefs>) {
    setPrefsState((prev) => {
      const updated: BatchPrefs = {
        holdIndicator: next.holdIndicator ?? prev.holdIndicator,
        holdSeconds:
          next.holdSeconds !== undefined
            ? clampHoldSeconds(next.holdSeconds)
            : prev.holdSeconds,
        livePreview: next.livePreview ?? prev.livePreview,
      };
      writePrefs(updated);
      return updated;
    });
  }

  return [prefs, setPrefs];
}
