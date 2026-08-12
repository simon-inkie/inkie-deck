/**
 * message-chime.ts - in-app sound on incoming messages (TASK-470 follow-up,
 * Alex: "lets add a small sound on desktop").
 *
 * Pure detection + a WebAudio chime, split so the detection is unit-testable:
 *   - detectNewArrivals(prev, next): which agents have a NEW unread message
 *     since the last poll. Keyed on lastTimestamp advancing AND hasUnread -
 *     the user's own sends advance the timestamp but never read as unread,
 *     so they stay silent. A thread the user is actively reading flips to
 *     read before the poll sees it - also silent, which is the right call
 *     (you are looking at it).
 *   - playChime(): soft two-tone ping via OscillatorNode - no audio asset,
 *     quiet gain, ~0.35s. Browsers gate audio behind a user gesture, so the
 *     AudioContext unlocks lazily on the first pointer/key interaction; if
 *     a message lands before any interaction the chime is skipped silently.
 *
 * The useMessageChime hook wires both into the AppShell's existing polling
 * loader data. First render is baseline only - no chime for history.
 *
 * ASCII only - no em-dashes (FND-05).
 */
import { useEffect, useRef } from "react";

export interface ChimeAgentView {
  name: string;
  lastTimestamp: string;
  hasUnread?: boolean;
}

/**
 * Compare the previous poll's per-agent last timestamps against the current
 * view; return the agents with a NEW unread arrival. Unknown agents (first
 * sight) only chime when they arrive unread AFTER the baseline poll -
 * callers pass prev=null on first render to suppress history.
 */
export function detectNewArrivals(
  prev: Map<string, string> | null,
  next: ChimeAgentView[]
): string[] {
  if (prev === null) return [];
  const arrivals: string[] = [];
  for (const agent of next) {
    if (!agent.hasUnread) continue;
    const before = prev.get(agent.name);
    if (before === undefined || agent.lastTimestamp > before) {
      arrivals.push(agent.name);
    }
  }
  return arrivals;
}

// --- WebAudio chime (client-only; all callers are inside useEffect) --------

let audioCtx: AudioContext | null = null;
let unlockArmed = false;

function ensureUnlockListener(): void {
  if (unlockArmed || typeof window === "undefined") return;
  unlockArmed = true;
  const unlock = () => {
    try {
      if (!audioCtx) audioCtx = new AudioContext();
      if (audioCtx.state === "suspended") void audioCtx.resume();
    } catch {
      // No audio available - chime stays silent forever, never throws.
    }
  };
  window.addEventListener("pointerdown", unlock, { passive: true });
  window.addEventListener("keydown", unlock, { passive: true });
}

/** Soft two-tone ping, brand register: quiet, short, no theatre. */
export function playChime(): void {
  try {
    if (!audioCtx || audioCtx.state !== "running") return;
    const now = audioCtx.currentTime;
    for (const [freq, start] of [
      [740, 0],
      [988, 0.12],
    ] as const) {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, now + start);
      gain.gain.linearRampToValueAtTime(0.06, now + start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + start + 0.3);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(now + start);
      osc.stop(now + start + 0.32);
    }
  } catch {
    // Audio failure must never break the shell.
  }
}

/**
 * Chime once per poll cycle when any agent has a new unread arrival.
 * Baselines on first render (no chime for what was already there).
 */
export function useMessageChime(agents: ChimeAgentView[]): void {
  const prevRef = useRef<Map<string, string> | null>(null);

  useEffect(() => {
    ensureUnlockListener();
  }, []);

  useEffect(() => {
    const arrivals = detectNewArrivals(prevRef.current, agents);
    prevRef.current = new Map(agents.map((a) => [a.name, a.lastTimestamp]));
    if (arrivals.length > 0) playChime();
  }, [agents]);
}
