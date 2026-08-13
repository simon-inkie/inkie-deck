/**
 * e2e/batch-prefs-state.ts - the suite's default batch preferences, seeded into
 * localStorage before the app loads.
 *
 * WHY THIS EXISTS. Submitting in the composer does not send anything.
 * usePendingBatch buffers the text client-side and only POSTs once the user
 * settles, and the shipped default hold is 18s (DEFAULT_BATCH_PREFS.holdSeconds
 * in app/lib/batch-prefs.ts). Every composer test therefore either waits out an
 * 18s hold or - which is what this suite actually did - asserts on the local
 * pending bubble and calls that a send.
 *
 * The hold is a per-browser preference persisted to localStorage under
 * mc.batchPrefs.v1, so Playwright can set it the way a user would, before the
 * app ever reads it. That keeps this a test-environment decision with no
 * application change, and putting it in playwright.config.ts `use` makes it the
 * suite default rather than an opt-in a new spec can forget.
 *
 * 2 is the floor clampHoldSeconds permits, so "immediate" here means the
 * shortest hold the product itself allows, not the absence of one.
 *
 * E2E_HOLD_SECONDS overrides the default, and is the suppression knob for
 * revert-to-red: run with E2E_HOLD_SECONDS=300 and no batch is ever delivered
 * within a test's lifetime. Every assertion that truly pins delivery goes red;
 * anything the pending bubble alone can satisfy stays green. That is how the
 * false greens in this suite were enumerated rather than guessed at.
 *
 * ASCII only - no em-dashes per FND-05.
 */
import type { BatchPrefs } from "../app/lib/batch-prefs";

/** Must match playwright.config.ts baseURL: storageState is keyed by origin. */
export const BASE_URL = "http://localhost:3917";

const STORAGE_KEY = "mc.batchPrefs.v1";

/** The suite default, overridable per run for the revert-to-red proof. */
export const DEFAULT_E2E_HOLD_SECONDS = Number(
  process.env["E2E_HOLD_SECONDS"] ?? 2
);

/**
 * A Playwright storageState seeding mc.batchPrefs.v1 with the given hold.
 *
 * Pass an explicit value in a spec that is testing the hold itself; omit it
 * everywhere else and inherit the suite default.
 *
 * @param holdSeconds - Hold window in seconds. The app clamps to [2, 300].
 */
export function batchPrefsStorageState(
  holdSeconds: number = DEFAULT_E2E_HOLD_SECONDS
) {
  const prefs: BatchPrefs = {
    // "subtle" is the shipped default; the seed must not quietly test a
    // different indicator from the one users get.
    holdIndicator: "subtle",
    holdSeconds,
    livePreview: true,
  };
  return {
    cookies: [],
    origins: [
      {
        origin: BASE_URL,
        localStorage: [{ name: STORAGE_KEY, value: JSON.stringify(prefs) }],
      },
    ],
  };
}
