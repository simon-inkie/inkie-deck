/**
 * VoiceDebugPanel.tsx - Debug event strip for the voice pipeline (TASK-433 reopened).
 *
 * Mounts above the compose box inside the sticky footer when ?debug=1 is present
 * in the thread route URL. Consumed by Compose.tsx which owns the event ring buffer
 * (capped at 200) and passes the current snapshot as the `events` prop.
 *
 * Design idiom lifted from the Inkie interviewer RecordingPanel debug strip:
 *   - bg-gray-900 dark mono, colour-coded type tags, max-h-48 overflow-y-auto
 *   - newest at bottom, auto-scroll via ref on events change
 *
 * Type tag colours:
 *   state  - blue-400   (getUserMedia lifecycle)
 *   ws     - green-400  (WebSocket open/close/error)
 *   audio  - yellow-400 (codec choice, frame aggregates)
 *   status - purple-400 (upstream proxy lifecycle frames)
 *   dg     - cyan-400   (raw Deepgram messages)
 *   parse  - gray-400   (parse results, ignored shapes)
 *   error  - red-400    (any error)
 *
 * FND-02: no env or server imports.
 * FND-05: ASCII only, no em-dashes.
 */
import { useEffect, useRef } from "react";

/** A single debug event emitted by useVoice. */
export interface DebugEvent {
  /** HH:MM:SS.mmm timestamp of the event. */
  time: string;
  /** Semantic category for colour-coding. */
  type: "state" | "ws" | "audio" | "status" | "dg" | "parse" | "error";
  /** Optional human-readable payload string. */
  data?: string;
}

interface VoiceDebugPanelProps {
  /** Current event ring buffer snapshot (up to 200 events, managed by parent). */
  events: DebugEvent[];
}

/** Colour class for each event type tag. */
function tagClass(type: DebugEvent["type"]): string {
  switch (type) {
    case "state":  return "text-blue-400";
    case "ws":     return "text-green-400";
    case "audio":  return "text-yellow-400";
    case "status": return "text-purple-400";
    case "dg":     return "text-cyan-400";
    case "parse":  return "text-gray-400";
    case "error":  return "text-red-400";
    default:       return "text-gray-400";
  }
}

/**
 * Dark mono event strip, colour-coded type tags, auto-scroll to newest.
 * Mounted inside the sticky footer above the compose form when debug is enabled.
 */
export function VoiceDebugPanel({ events }: VoiceDebugPanelProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to the newest event whenever events change.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "nearest" });
  }, [events]);

  return (
    <div
      className="mb-2 rounded-md border border-gray-700 bg-gray-900 text-gray-100 max-h-48 overflow-y-auto"
      data-testid="voice-debug-panel"
    >
      <div className="sticky top-0 bg-gray-900 border-b border-gray-700 px-3 py-1 flex items-center justify-between">
        <span className="font-mono text-xs font-bold text-gray-300">Voice Debug</span>
        <span className="font-mono text-xs text-gray-500">{events.length} events</span>
      </div>
      <div className="px-3 py-1 space-y-0.5 font-mono text-xs">
        {events.length === 0 ? (
          <div className="text-gray-600 py-1">No events yet. Start a voice session.</div>
        ) : (
          events.map((evt, i) => (
            <div key={i} className="flex gap-2 leading-relaxed">
              <span className="text-gray-600 flex-shrink-0 select-none">{evt.time}</span>
              <span className={`flex-shrink-0 ${tagClass(evt.type)}`}>[{evt.type}]</span>
              {evt.data ? (
                <span className="text-gray-300 truncate">{evt.data}</span>
              ) : null}
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
