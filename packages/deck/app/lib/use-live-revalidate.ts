/**
 * use-live-revalidate.ts - Polling live updates, v1 (TASK-455).
 *
 * One hook, mounted ONCE in AppShell: React Router revalidation re-runs
 * every active loader (shell sidebar + bell, home, thread, projects, lens),
 * so a single interval makes every surface live. v2 (SSE off a file watch)
 * replaces the timer without touching the call site.
 *
 * Guards:
 *   - document.hidden: no background-tab polling (a parked laptop must not
 *     hammer the loaders).
 *   - revalidator.state !== "idle": no overlapping revalidations on slow reads.
 *
 * shouldPoll is exported pure for the unit truth table.
 *
 * Client-side module, no env/fs (FND-02). ASCII only (FND-05).
 */
import { useEffect } from "react";
import { useRevalidator } from "react-router";

/** Poll interval. 3s: feels live in conversation, negligible loader cost. */
export const LIVE_REVALIDATE_INTERVAL_MS = 3000;

/**
 * True when a poll tick should fire a revalidation.
 *
 * @param hidden - document.hidden at tick time.
 * @param revalidatorState - "idle" | "loading" from useRevalidator.
 */
export function shouldPoll(hidden: boolean, revalidatorState: string): boolean {
  return !hidden && revalidatorState === "idle";
}

/**
 * Revalidate all active loaders on an interval while the tab is visible.
 * Mount once per page (AppShell).
 */
export function useLiveRevalidate(intervalMs: number = LIVE_REVALIDATE_INTERVAL_MS) {
  const revalidator = useRevalidator();

  useEffect(() => {
    const id = setInterval(() => {
      if (shouldPoll(document.hidden, revalidator.state)) {
        revalidator.revalidate();
      }
    }, intervalMs);
    return () => clearInterval(id);
    // revalidator identity is stable per react-router docs; state is read
    // fresh inside the tick via the closure over the hook's latest render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, revalidator.state]);
}
