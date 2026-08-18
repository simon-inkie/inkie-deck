/**
 * panel-state.ts - per-thread persistence of the side-panel open state.
 *
 * The review panel (?doc=<path>, ReviewPanel.tsx) and the Files panel (?files=1,
 * FilesPanel.tsx) both keep their open/closed state ENTIRELY in the thread
 * route's URL search params. Search params are scoped to the exact current URL,
 * so navigating anywhere else and coming back drops them and both panels render
 * closed, even though the user was reading something specific a moment ago.
 *
 * This module remembers those two params PER THREAD (keyed by agent) in
 * sessionStorage and restores them on re-entry.
 *
 * Scope, all deliberate:
 *   - Per thread only. A doc open on one agent does NOT follow you to another.
 *   - sessionStorage, not localStorage: transient "where was I a minute ago" UI
 *     state, not a durable record. A fresh browser session starts clean.
 *   - The URL always wins. A deep link (/threads/x?doc=Y) opens exactly Y and
 *     stored state is not consulted.
 *   - An explicit close clears that thread's entry, so a panel the user
 *     deliberately closed is never resurrected.
 *
 * Restoring writes the params back into the URL, so every downstream consumer
 * (ReviewPanel, FilesPanel, the thread route's layout gate) keeps working
 * unchanged off useSearchParams. No component API changes.
 *
 * Client-only and SSR-safe: window/sessionStorage are touched inside functions
 * called from effects, never at module top level, and every access is guarded
 * (private browsing can throw on the property itself).
 *
 * No .server imports. ASCII only - no em-dashes.
 */
import { useEffect, useRef } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";

// ---------------------------------------------------------------------------
// The persisted params
// ---------------------------------------------------------------------------

/**
 * The ?doc= param (ReviewPanel's DOC_PARAM) and the ?files= param
 * (FilesPanel's FILES_PARAM). Declared here rather than imported so this module
 * stays component-free and node-testable; panel-state-persist.test.tsx pins them
 * against the real component constants so the two can never drift.
 */
export const PANEL_PARAMS = ["doc", "files"] as const;
export type PanelParam = (typeof PANEL_PARAMS)[number];

/** Remembered state for one thread. An absent key means "that panel is closed". */
export type PanelState = Partial<Record<PanelParam, string>>;

/**
 * Upper bound on a remembered doc path. Nothing legitimate comes close; the cap
 * only stops a corrupted or hand-edited storage entry from being restored into
 * an absurd URL.
 */
const MAX_VALUE_LENGTH = 2048;

interface PanelParamSpec {
  /** sessionStorage key prefix; the agent name is appended. */
  keyPrefix: string;
  /** Values that fail this are ignored on read and never restored. */
  isValidValue: (value: string) => boolean;
}

const PANEL_PARAM_SPECS: Record<PanelParam, PanelParamSpec> = {
  doc: {
    keyPrefix: "mc:review-panel:",
    isValidValue: (v) => v.length > 0 && v.length <= MAX_VALUE_LENGTH,
  },
  files: {
    // The Files panel is open only for the literal "1" (FilesPanel gates on
    // === "1"), so anything else is meaningless and is dropped.
    keyPrefix: "mc:files-panel:",
    isValidValue: (v) => v === "1",
  },
};

/** sessionStorage key for one panel param on one thread. */
export function panelStorageKey(param: PanelParam, agent: string): string {
  return `${PANEL_PARAM_SPECS[param].keyPrefix}${agent}`;
}

// ---------------------------------------------------------------------------
// Pure helpers (no storage, no router - unit-testable in the node env)
// ---------------------------------------------------------------------------

/** Extract the panel params from a URLSearchParams, dropping invalid values. */
export function panelStateFromParams(params: URLSearchParams): PanelState {
  const state: PanelState = {};
  for (const param of PANEL_PARAMS) {
    const value = params.get(param);
    if (value !== null && PANEL_PARAM_SPECS[param].isValidValue(value)) {
      state[param] = value;
    }
  }
  return state;
}

/**
 * True when the incoming URL already speaks for the panels - a deep link, a
 * shared link, or a panel the user just opened. `has` (not a value check) is
 * deliberate: an explicit `?files=0` is still the URL having an opinion, and
 * that opinion outranks whatever is remembered.
 */
export function urlCarriesPanelState(params: URLSearchParams): boolean {
  return PANEL_PARAMS.some((param) => params.has(param));
}

/**
 * The whole restore decision, as one pure function.
 *
 * Returns the search params to navigate to, or null for "leave the URL alone".
 * Null when the URL already carries panel state (it wins) and null when there
 * is nothing remembered for this thread. Unrelated params (anchor, debug, ...)
 * are preserved.
 */
export function restoredSearchParams(
  current: URLSearchParams,
  stored: PanelState
): URLSearchParams | null {
  if (urlCarriesPanelState(current)) return null;
  const restorable = PANEL_PARAMS.filter((param) => {
    const value = stored[param];
    return value !== undefined && PANEL_PARAM_SPECS[param].isValidValue(value);
  });
  if (restorable.length === 0) return null;
  const next = new URLSearchParams(current);
  for (const param of restorable) {
    next.set(param, stored[param] as string);
  }
  return next;
}

// ---------------------------------------------------------------------------
// sessionStorage access (SSR-safe, never throws)
// ---------------------------------------------------------------------------

function panelStorage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.sessionStorage ?? null;
  } catch {
    // Accessing the property itself can throw (private browsing, blocked
    // storage). Treat it as "no persistence available" and carry on.
    return null;
  }
}

/** Read the remembered panel state for one thread. Empty object when nothing valid is stored. */
export function readPanelState(agent: string): PanelState {
  const store = panelStorage();
  if (store === null || agent === "") return {};
  const state: PanelState = {};
  for (const param of PANEL_PARAMS) {
    try {
      const raw = store.getItem(panelStorageKey(param, agent));
      if (raw !== null && PANEL_PARAM_SPECS[param].isValidValue(raw)) {
        state[param] = raw;
      }
    } catch {
      // Ignore read errors for this param and keep going.
    }
  }
  return state;
}

/**
 * Mirror one thread's panel state into storage. A param absent from `state`
 * DELETES its key - that is what makes an explicit panel close stick instead of
 * being resurrected on the next visit.
 */
export function writePanelState(agent: string, state: PanelState): void {
  const store = panelStorage();
  if (store === null || agent === "") return;
  for (const param of PANEL_PARAMS) {
    const key = panelStorageKey(param, agent);
    const value = state[param];
    try {
      if (value === undefined || !PANEL_PARAM_SPECS[param].isValidValue(value)) {
        store.removeItem(key);
      } else {
        store.setItem(key, value);
      }
    } catch {
      // Quota or blocked storage. Persistence is a convenience, never a gate.
    }
  }
}

// ---------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------

export interface PersistedPanelStateOptions {
  /**
   * Sit this effect out entirely - no restore, no mirror - because another
   * effect on the same route has a search-param edit of its own that has not
   * landed yet.
   *
   * WHY THIS EXISTS. This hook navigates off the RENDER-TIME searchParams
   * snapshot, and so does the ?reply= seed-strip effect in threads.$agent.tsx.
   * Both fire in the same effect flush when a card-reply link lands on a thread
   * that has remembered panel state, and neither snapshot contains the other's
   * pending change. Two replace navigations, last one wins, one edit silently
   * lost: the settled URL was `reply=<id>&doc=<path>`, i.e. this hook's snapshot
   * carried the SPENT seed straight back into the URL, where the strip effect's
   * consume-once ref means it is never removed again. Holding turns one racing
   * pair into two ordered writes: the strip lands, searchParams changes, this
   * effect re-runs on the settled URL and restores from there.
   *
   * The mirror is held too, not just the restore. Mirroring the pre-strip URL
   * would see no panel params and DELETE the very entry that is about to be
   * restored - a hold that only covered the restore would trade the race for a
   * wiped memory.
   *
   * Caller-supplied rather than hardcoded here: this module deliberately knows
   * nothing about card replies. The route holds while the param whose lifetime
   * it owns is still in the URL.
   */
  hold?: boolean;
}

/**
 * usePersistedPanelState - remember and restore this thread's side panels.
 *
 * Call ONCE per thread route render (from ThreadView), passing the agent whose
 * thread is displayed. Returns nothing: it works entirely through the search
 * params, so ReviewPanel and FilesPanel need no changes.
 *
 * One effect, two jobs, in this order:
 *   1. First run for a given agent, when the URL carries NO panel param and
 *      storage has state for that agent: restore it into the URL (replace, so
 *      no history entry and Back does not bounce) and return WITHOUT mirroring.
 *      The navigation re-runs this effect, and the mirror below then sees the
 *      restored URL. Mirroring the pre-restore URL here would delete the very
 *      entry being restored.
 *   2. Otherwise mirror the current URL's panel params into storage for this
 *      agent. This one write covers every case: opening a panel remembers it,
 *      closing it forgets it, and a deep-linked doc becomes what this thread
 *      remembers.
 *
 * Both jobs are skipped while `options.hold` is true - see that field for the
 * race it exists to close.
 *
 * Call it AFTER the route's other search-param effects (notably the #anchor
 * deep-link effect): if two replace-navigations land in the same commit the
 * later effect wins, and the anchor effect re-runs on the changed params and
 * re-applies itself, whereas this one deliberately restores only once per
 * thread. That re-run argument holds for the anchor effect, which is
 * idempotent, and NOT for the consume-once ?reply= strip, which is what
 * `hold` is for.
 */
export function usePersistedPanelState(
  agent: string,
  options: PersistedPanelStateOptions = {}
): void {
  const hold = options.hold ?? false;
  const [searchParams] = useSearchParams();
  // navigate + location.hash rather than setSearchParams: see the restore
  // branch below. Same pair the route's anchor and ?reply= strip effects use.
  const navigate = useNavigate();
  const location = useLocation();
  // The agent whose restore has already been attempted. Keyed by agent, not a
  // bare boolean, because React Router reuses this component across a
  // thread-to-thread navigation (the route module is the same, only the param
  // changes), so there is no remount to reset it.
  const restoreAttemptedFor = useRef<string | null>(null);

  useEffect(() => {
    // Held: do nothing at all, and in particular do NOT spend this thread's
    // one restore attempt. The effect re-runs when the hold lifts.
    if (hold) return;

    if (restoreAttemptedFor.current !== agent) {
      restoreAttemptedFor.current = agent;
      const restored = restoredSearchParams(searchParams, readPanelState(agent));
      if (restored !== null) {
        // THE HASH IS PART OF THE TARGET, NOT AN AFTERTHOUGHT.
        // setSearchParams navigates to a bare "?<search>" string, which parses
        // to a search-only target and therefore resolves to an EMPTY hash. On
        // /threads/<agent>#<decisionId> (the needs-you deep link) that silently
        // destroys the scroll target: the route's anchor effect returns early on
        // an empty location.hash and can never recover it, so any thread with
        // remembered panel state stops scrolling to the linked card. Carry the
        // hash through explicitly, exactly as the anchor and ?reply= strip
        // effects in threads.$agent.tsx already do.
        navigate(
          { search: `?${restored.toString()}`, hash: location.hash },
          { replace: true, preventScrollReset: true }
        );
        return;
      }
    }
    writePanelState(agent, panelStateFromParams(searchParams));
  }, [agent, hold, searchParams, navigate, location.hash]);
}
