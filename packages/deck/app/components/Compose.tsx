/**
 * Compose.tsx - Free-text reply compose box with file attachments and voice input.
 *
 * Renders a textarea + submit button that posts a new reply to the thread
 * action via a fetcher (no full-page navigation). The action receives
 * intent=compose and the reply body text, writes a new message block to
 * the fixture inbox, and RR7 auto-revalidates the loader.
 *
 * When respondingToDecisionId + value + onChange are provided, the box enters
 * "custom answer" mode: the textarea is controlled, shows a "Responding to:"
 * context label, and on submit posts intent=custom with decisionId + text.
 * The parent clears the responding state after submit (via onSent callback).
 *
 * Typing-aware message batching. In standard (non-custom) mode,
 * submits no longer POST immediately. Instead, they call onBatchSubmit which
 * buffers the message in the parent's pending batch (usePendingBatch). The
 * actual POST fires when the settle timer elapses or the user triggers send-now.
 * Custom/card-answer flows are EXEMPT from batching (card answers are
 * not the rapid-fire-burst case; they post directly as today).
 * The postBatchedBody prop is called by the parent to fire the real POST.
 *
 * Attachment support:
 *   - Paperclip button opens a hidden file input (multiple files, capped at 5).
 *   - Paste handler extracts files via extractPasteFiles (files-then-items order)
 *     and works in both standard and custom-answer mode.
 *   - Drag-drop overlay on the compose area (dragenter/dragleave counter pattern
 *     to avoid flicker on nested elements).
 *   - All three paths feed one uploadFiles() function that posts intent=attach
 *     via a separate fetcher, then pushes returned markdown into pendingAttachments
 *     chips.
 *   - Chip row above the textarea: per chip an icon (image vs file) + truncated
 *     filename + 44px X to remove. Removing drops it from the outgoing body;
 *     the uploaded file stays on disk (orphan cleanup is a v2 concern).
 *   - Send merges typed text + chip markdowns via buildOutgoingBody and submits
 *     constructed FormData (preserves intent/decisionId for both modes).
 *   - Textarea required flips off when pendingAttachments is non-empty.
 *   - Send disabled when draft AND pending both empty.
 *
 * Voice input:
 *   - voiceProxyUrl prop arrives from the loader.
 *   - Mic toggle: getUserMedia -> MediaRecorder (audio/webm;codecs=opus, 250ms
 *     timeslice) -> binary chunks over native WebSocket to the local voice proxy.
 *   - Pulse indicator (accent dot animate-pulse) while live.
 *   - INTERIM results: greyed ghost row above the textarea while speaking.
 *   - FINAL results: appended at textarea cursor as plain editable text; ghost clears.
 *   - Toggle off / unmount / send: recorder stopped, tracks stopped, WS closed.
 *     No hot mic ever survives the toggle or page unload.
 *   - Connection failure or no_key status -> mic renders unavailable state
 *     (disabled-looking + title "Voice unavailable"); compose stays fully usable.
 *   - New upstream status frames (upstream_connecting, upstream_open,
 *     upstream_closed, overflow) are logged to debug and otherwise ignored -
 *     no behaviour change in production; visible in the debug panel when debug=true.
 *
 * Debug panel:
 *   - debug=true prop (from ?debug=1 search param in the thread route)
 *     mounts a VoiceDebugPanel above the compose box inside the sticky footer.
 *   - useVoice gains optional onDebugEvent callback for all observable events.
 *   - Client sends {type:"debug_on"} text frame on WS open when debug=true,
 *     opting in to server-side dg_raw mirroring of raw Deepgram frames.
 *
 * Compose writes a new block to the fixture inbox and the reply
 * appears in the thread after revalidation.
 *
 * No .server imports - all data arrives via props.
 * ASCII only - no em-dashes.
 */
import { useRef, useState, useEffect, useCallback } from "react";
import { useFetcher } from "react-router";
import { FileImage, FileText, Mic, MicOff, Paperclip, Settings2, X } from "lucide-react";
import { Button } from "./ui/button";
import { Switch } from "./ui/switch";
import type { BatchPrefs, HoldIndicator } from "~/lib/batch-prefs";
import { VoiceDebugPanel, type DebugEvent } from "./VoiceDebugPanel";
import {
  computeVoiceInsert,
  isSpeechSignal,
  SILENCE_AUTO_STOP_MS,
} from "~/lib/voice-insert";
import { buildOutgoingBody, extractPasteFiles } from "~/lib/compose-attach";
import { cn } from "~/lib/utils";

interface ComposeProps {
  /**
   * The thread's agent name. Namespaces the per-agent draft so typed text is
   * retained per thread: navigating to another agent shows that agent's own
   * draft (or empty), and coming back restores this one. Standard mode only; custom-answer
   * mode is parent-controlled. Omitted -> no persistence (in-memory draft as before).
   */
  draftKey?: string;
  /**
   * When set, the compose box is in "custom answer" mode for this card.
   * The submit button will post intent=custom instead of intent=compose.
   */
  respondingToDecisionId?: string;
  /** The subject of the decision card being responded to (for the context label). */
  respondingToSubject?: string;
  /** Controlled value for the textarea (custom answer draft). */
  value?: string;
  /** Called when the textarea value changes (controlled mode). */
  onChange?: (text: string) => void;
  /** Called after the form is submitted so the parent can clear responding state. */
  onSent?: () => void;
  /** Called when the user clicks the X to cancel responding. */
  onCancel?: () => void;
  /**
   * WebSocket URL for the local voice proxy.
   * Provided by the thread loader - never read from env in this component.
   * When omitted the mic renders in the unavailable state.
   */
  voiceProxyUrl?: string;
  /**
   * Why voice is off, supplied by the loader (#27), e.g. "voice disabled: no
   * <key name>". When set the mic renders disabled with this text instead of
   * opening a WebSocket that can only fail. Null or absent means voice is on.
   */
  voiceDisabledReason?: string | null;
  /**
   * When true, mount the voice debug panel and emit debug events.
   * Driven by ?debug=1 search param in the thread route (pure UI state,
   * not a loader value). Zero cost when absent.
   */
  debug?: boolean;

  // ---------------------------------------------------------------------------
  // Batch hooks (standard mode only; custom/card-answer is exempt).
  // ---------------------------------------------------------------------------

  /**
   * Called on standard submit INSTEAD of POSTing directly. The parent
   * accumulates messages in the pending batch and fires the real POST after settle.
   * When absent, the compose reverts to its earlier direct-POST behaviour
   * (useful for tests/storybook and the custom-answer path, which is always exempt).
   */
  onBatchSubmit?: (body: string, dictated: boolean) => void;

  /**
   * Called on every keystroke in the textarea so the parent can
   * hard-suspend the settle timer while a follow-up draft is in progress.
   */
  onBatchType?: () => void;

  /**
   * Called when the user triggers a send-now override (double-Enter
   * while PENDING/SUSPENDED). The parent fires the batch immediately.
   * Only meaningful when onBatchSubmit is also provided.
   */
  onBatchSendNow?: () => void;

  // ---------------------------------------------------------------------------
  // Batch display preferences (passed from parent, single source).
  // ---------------------------------------------------------------------------

  /**
   * Current batch display preferences. Passed from threads.$agent.tsx
   * which owns the single useBatchPrefs() instance. Do NOT call useBatchPrefs()
   * inside Compose -- single source of truth in the parent, passed down so the
   * gear and the rendered indicator always agree.
   */
  batchPrefs?: BatchPrefs;

  /**
   * Setter for batch preferences. Passed from parent.
   * Accepts a partial update; holdSeconds is clamped to [2, 300] by the hook.
   */
  onBatchPrefsChange?: (next: Partial<BatchPrefs>) => void;

  /**
   * Called on every keystroke with the current textarea value so
   * the parent can display a live draft preview in the pending bubble.
   * Also called with "" after a batch submit so the preview clears.
   * Standard mode only; custom-answer mode never calls this.
   */
  onDraftChange?: (draft: string) => void;

  /**
   * When the user cancels a pending batch, the parent captures the
   * held text and passes it back here so it is restored into the compose textarea
   * rather than being silently discarded. Transitions from "" to a non-empty
   * string trigger the restore; the same string value on a subsequent render
   * is ignored (idempotent via lastRestoredRef).
   * Standard mode only; has no effect in custom-answer mode.
   */
  restoreDraft?: string;
}

// ---------------------------------------------------------------------------
// Voice hook
// ---------------------------------------------------------------------------

type VoiceState =
  | { status: "idle" }
  | { status: "active"; interim: string }
  | { status: "unavailable" };

// ---------------------------------------------------------------------------
// Debug event helpers
// ---------------------------------------------------------------------------

/** Format a Date as HH:MM:SS.mmm for debug event timestamps. */
function fmtTime(d: Date): string {
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

function mkEvent(
  type: DebugEvent["type"],
  data?: string
): DebugEvent {
  return { time: fmtTime(new Date()), type, data };
}

/**
 * useVoice - manages MediaRecorder + WebSocket lifecycle.
 *
 * Returns:
 *   voiceState   - current status + interim text
 *   micAvailable - false when getUserMedia/proxy unavailable (render disabled mic)
 *   toggleMic    - start or stop recording
 *   stopVoice    - programmatic stop (called on send/unmount)
 *   appendText   - passed a setter to insert final text into the textarea
 *
 * When onDebugEvent is provided, emits DebugEvents for every observable step.
 * When debug=true, the hook sends {type:"debug_on"} to the proxy on WS open,
 * enabling dg_raw mirroring of raw Deepgram frames (truncated server-side).
 */
function useVoice(
  proxyUrl: string | undefined,
  onFinalText: (text: string) => void,
  onDebugEvent?: (event: DebugEvent) => void,
  debug?: boolean
) {
  const [voiceState, setVoiceState] = useState<VoiceState>({ status: "idle" });
  const recorderRef = useRef<MediaRecorder | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // Fix layer 1: the WS message listener is registered ONCE per
  // session, so a direct closure over onFinalText goes stale the moment the
  // parent re-renders (its captured draft froze at session start - that was
  // the overwrite-after-a-pause bug). The listener reads through this ref,
  // which an effect keeps pointed at the LATEST callback every render.
  const onFinalTextRef = useRef(onFinalText);
  useEffect(() => {
    onFinalTextRef.current = onFinalText;
  }, [onFinalText]);

  // Item 2: silence auto-stop. Armed at recorder start, reset on
  // every speech signal (interim/final - isSpeechSignal), fired = stopVoice.
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Frame counter for the every-10th-frame aggregate debug event.
  const frameCountRef = useRef(0);
  const frameBytesRef = useRef(0);

  const emit = useCallback(
    (type: DebugEvent["type"], data?: string) => {
      if (onDebugEvent) onDebugEvent(mkEvent(type, data));
    },
    [onDebugEvent]
  );

  const stopVoice = useCallback(() => {
    if (silenceTimerRef.current !== null) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }

    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      try {
        recorderRef.current.stop();
      } catch {
        // already stopped
      }
    }
    recorderRef.current = null;

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }

    if (wsRef.current) {
      try {
        wsRef.current.close();
      } catch {
        // already closed
      }
      wsRef.current = null;
    }

    frameCountRef.current = 0;
    frameBytesRef.current = 0;

    setVoiceState({ status: "idle" });
  }, []);

  // Stop on unmount - no hot mic after component dies.
  useEffect(() => {
    return () => {
      stopVoice();
    };
  }, [stopVoice]);

  // (Re)arm the silence auto-stop window. Called at recorder start and on
  // every speech signal. Firing takes the SAME cleanup path as manual stop.
  const resetSilenceTimer = useCallback(() => {
    if (silenceTimerRef.current !== null) {
      clearTimeout(silenceTimerRef.current);
    }
    silenceTimerRef.current = setTimeout(() => {
      silenceTimerRef.current = null;
      emit("state", `auto-stop: ${SILENCE_AUTO_STOP_MS / 1000}s without speech`);
      stopVoice();
    }, SILENCE_AUTO_STOP_MS);
  }, [emit, stopVoice]);

  const toggleMic = useCallback(async () => {
    if (voiceState.status === "active") {
      stopVoice();
      return;
    }

    if (!proxyUrl) {
      setVoiceState({ status: "unavailable" });
      return;
    }

    // Check getUserMedia support.
    if (!navigator.mediaDevices?.getUserMedia) {
      setVoiceState({ status: "unavailable" });
      return;
    }

    emit("state", "getUserMedia requested");

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      emit("state", "getUserMedia granted");
    } catch (err) {
      const name = err instanceof Error ? err.name : "unknown";
      emit("error", `getUserMedia denied: ${name}`);
      setVoiceState({ status: "unavailable" });
      return;
    }

    streamRef.current = stream;

    // Open WS first; start recording once WS is open.
    const ws = new WebSocket(proxyUrl);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;
    emit("ws", "connecting");

    ws.addEventListener("open", () => {
      emit("ws", "open");

      // If debug mode is on, opt in to dg_raw mirroring.
      if (debug) {
        try {
          ws.send(JSON.stringify({ type: "debug_on" }));
        } catch {
          // safe to ignore
        }
      }

      // Start MediaRecorder after WS is open.
      const mimeType = "audio/webm;codecs=opus";
      const supported = MediaRecorder.isTypeSupported(mimeType);
      const recorderOptions: MediaRecorderOptions = {
        mimeType: supported ? mimeType : undefined,
      };
      emit("audio", `codec: ${supported ? mimeType : "browser-default"}`);

      const recorder = new MediaRecorder(stream, recorderOptions);
      recorderRef.current = recorder;

      recorder.addEventListener("dataavailable", (e) => {
        if (e.data.size > 0 && ws.readyState === WebSocket.OPEN) {
          ws.send(e.data);

          // Aggregate every-10th-frame debug event (not per-frame).
          frameCountRef.current += 1;
          frameBytesRef.current += e.data.size;
          if (frameCountRef.current % 10 === 0) {
            emit(
              "audio",
              `frames sent: ${frameCountRef.current}, bytes: ${frameBytesRef.current}`
            );
          }
        }
      });

      // 250ms timeslice: send chunks regularly so Deepgram can process incrementally.
      recorder.start(250);
      setVoiceState({ status: "active", interim: "" });

      // Arm the silence window from session start: a session that never
      // produces a single transcript stops itself after SILENCE_AUTO_STOP_MS.
      resetSilenceTimer();
    });

    ws.addEventListener("message", (e) => {
      if (typeof e.data !== "string") return;

      // Emit the raw message (truncated to 300 chars) before parsing.
      const raw = e.data.length > 300 ? e.data.slice(0, 300) + "..." : e.data;
      emit("dg", raw);

      let msg: unknown;
      try {
        msg = JSON.parse(e.data);
      } catch {
        emit("parse", "ignored: JSON parse error");
        return;
      }
      if (!msg || typeof msg !== "object") {
        emit("parse", "ignored: not an object");
        return;
      }
      const m = msg as Record<string, unknown>;

      // Speech evidence (interim/final) re-arms the silence window.
      // Machinery (status/dg_raw/unknown) deliberately does not.
      if (isSpeechSignal(m)) {
        resetSilenceTimer();
      }

      if (m["type"] === "status") {
        const state = m["state"];
        if (state === "no_key") {
          emit("status", "no_key: voice unavailable");
          stopVoice();
          setVoiceState({ status: "unavailable" });
          return;
        }
        // Upstream pipe live: RE-arm the silence window so a slow Deepgram
        // connect never eats the silence budget while the user is speaking.
        // The recorder-start arm stays as the dead-pipe fallback - a
        // session whose upstream never opens still stops itself.
        if (state === "upstream_open") {
          resetSilenceTimer();
        }
        // Status frames are otherwise log-only (no behaviour change).
        emit("status", `state: ${String(state)}`);
        emit("parse", `ignored: status/${String(state)}`);
        return;
      }

      if (m["type"] === "dg_raw" && typeof m["text"] === "string") {
        // Raw Deepgram frame mirror (debug_on path). Emit as a separate dg event.
        emit("dg", `[raw] ${m["text"] as string}`);
        emit("parse", "ignored: dg_raw");
        return;
      }

      if (m["type"] === "interim" && typeof m["text"] === "string") {
        const text = m["text"] as string;
        emit("parse", `interim: len=${text.length}`);
        setVoiceState({ status: "active", interim: text });
        return;
      }

      if (m["type"] === "final" && typeof m["text"] === "string") {
        const text = m["text"] as string;
        emit("parse", `final: len=${text.length}`);
        // Through the ref - always the LATEST handler, never the closure
        // captured at session start.
        onFinalTextRef.current(text);
        // Clear ghost row.
        setVoiceState({ status: "active", interim: "" });
        return;
      }

      emit("parse", `ignored: unknown type=${String(m["type"])}`);
    });

    ws.addEventListener("close", (e) => {
      emit("ws", `close code=${e.code} reason=${e.reason || "(none)"}`);
      // If we didn't initiate the close ourselves, flip to unavailable.
      if (wsRef.current !== null) {
        stopVoice();
        setVoiceState({ status: "unavailable" });
      }
    });

    ws.addEventListener("error", () => {
      emit("error", "ws error");
      stopVoice();
      setVoiceState({ status: "unavailable" });
    });
  }, [voiceState.status, proxyUrl, stopVoice, emit, debug, resetSilenceTimer]);

  const micAvailable = voiceState.status !== "unavailable";
  const isActive = voiceState.status === "active";
  const interimText = voiceState.status === "active" ? voiceState.interim : "";

  return { voiceState, micAvailable, isActive, interimText, toggleMic, stopVoice };
}

// ---------------------------------------------------------------------------
// Compose component
// ---------------------------------------------------------------------------

/**
 * Compose box for sending a free-text reply or a custom decision-card answer.
 *
 * Posts to the current route's action with:
 * - intent=compose + body  (standard mode)
 * - intent=custom + decisionId + text  (custom answer mode, when respondingToDecisionId set)
 *
 * The submit button is disabled while the fetcher is pending.
 */
export function Compose({
  draftKey,
  respondingToDecisionId,
  respondingToSubject,
  value,
  onChange,
  onSent,
  onCancel,
  voiceProxyUrl,
  voiceDisabledReason = null,
  debug,
  onBatchSubmit,
  onBatchType,
  onBatchSendNow,
  batchPrefs,
  onBatchPrefsChange,
  onDraftChange,
  restoreDraft,
}: ComposeProps) {
  const fetcher = useFetcher();
  const attachFetcher = useFetcher();
  const busy = fetcher.state !== "idle";
  const uploading = attachFetcher.state !== "idle";
  const isCustomMode = respondingToDecisionId !== undefined;

  // Double-Enter send-now override. Track timestamp of the last Enter
  // press that resulted in a batch submit (draft was non-empty). A subsequent
  // Enter within DOUBLE_ENTER_MS on an empty draft calls onBatchSendNow.
  const lastBatchEnterMsRef = useRef(0);
  const DOUBLE_ENTER_MS = 600;

  // Uncontrolled draft value for standard compose mode.
  const [draft, setDraft] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Tracks the last restoreDraft value that was applied so the
  // effect below only fires on genuinely NEW non-empty values, not on every
  // parent re-render that passes the same string.
  const lastRestoredRef = useRef("");

  // Per-agent draft persistence. The Compose instance is REUSED
  // when navigating between threads, so a single draft state leaked across
  // agents. We namespace the draft in sessionStorage by agent and:
  //   - persist at every mutation site (commitDraft) under the CURRENT key, so
  //     there is no agent-switch race (a stale draft can never be written under
  //     the wrong key),
  //   - load the new agent's draft in an effect keyed on the storage key.
  // sessionStorage (not local): drafts are per tab-session, gone on tab close.
  const draftStorageKey =
    draftKey !== undefined ? `mc-compose-draft:${draftKey}` : null;

  const commitDraft = useCallback(
    (val: string) => {
      setDraft(val);
      if (draftStorageKey !== null && typeof sessionStorage !== "undefined") {
        if (val) sessionStorage.setItem(draftStorageKey, val);
        else sessionStorage.removeItem(draftStorageKey);
      }
    },
    [draftStorageKey]
  );

  // Load this agent's stored draft on mount and whenever the agent changes.
  // Initial render is always "" (matches SSR) so there is no hydration
  // mismatch; the stored value loads post-hydration here. Custom-answer mode
  // is parent-controlled, so it never touches the per-agent draft.
  useEffect(() => {
    if (isCustomMode) return;
    if (draftStorageKey === null || typeof sessionStorage === "undefined") {
      setDraft("");
      return;
    }
    setDraft(sessionStorage.getItem(draftStorageKey) ?? "");
  }, [draftStorageKey, isCustomMode]);

  // When the parent cancels a pending batch and supplies the held
  // text via restoreDraft, write it back into the compose box. The idempotency
  // guard (lastRestoredRef) ensures the restore only fires when a genuinely NEW
  // non-empty value arrives -- repeated renders with the same string are no-ops.
  useEffect(() => {
    if (!restoreDraft || restoreDraft === lastRestoredRef.current) return;
    lastRestoredRef.current = restoreDraft;
    commitDraft(restoreDraft);
    // Focus after state update so the user can carry on typing immediately.
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, [restoreDraft, commitDraft]);

  // Pending attachment chips. Each chip carries the markdown returned
  // by the attach route plus display metadata derived at push time. The chip
  // row renders above the textarea; send-time merge via buildOutgoingBody.
  const [pendingAttachments, setPendingAttachments] = useState<
    Array<{ markdown: string; filename: string; isImage: boolean }>
  >([]);

  // Debug event ring buffer: capped at 200 events (drop oldest on overflow).
  const [debugEvents, setDebugEvents] = useState<DebugEvent[]>([]);

  const handleDebugEvent = useCallback((event: DebugEvent) => {
    setDebugEvents((prev) => {
      const next = [...prev, event];
      if (next.length > 200) {
        return next.slice(next.length - 200);
      }
      return next;
    });
  }, []);

  // Drag-drop counter: increment on dragenter, decrement on dragleave.
  // This avoids flickering when the drag crosses child elements.
  const [dragCount, setDragCount] = useState(0);

  // Batch settings popover (self-contained controlled div; no new dep).
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRef = useRef<HTMLDivElement>(null);

  // Local draft string for the hold-seconds input so multi-digit values (e.g.
  // 10-19) are typable without mid-keystroke clamping. The draft is seeded
  // from batchPrefs.holdSeconds whenever the popover opens. The committed
  // value (on blur or Enter) is what triggers onBatchPrefsChange (which clamps).
  const [holdSecondsDraft, setHoldSecondsDraft] = useState(
    () => String(batchPrefs?.holdSeconds ?? 5),
  );

  // Seed the draft from the committed value whenever the popover opens.
  useEffect(() => {
    if (settingsOpen && batchPrefs) {
      setHoldSecondsDraft(String(batchPrefs.holdSeconds));
    }
  }, [settingsOpen, batchPrefs]);

  // Close the settings popover when the user clicks outside it or presses Escape.
  useEffect(() => {
    if (!settingsOpen) return;
    function handleOutsideClick(e: MouseEvent) {
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) {
        setSettingsOpen(false);
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setSettingsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleOutsideClick);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleOutsideClick);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [settingsOpen]);

  // ---------------------------------------------------------------------------
  // Voice - append final text at a STABLE ANCHOR: the anchor is captured at
  // voice-session start and advanced ONLY by voice finals. Typing while speaking must not
  // scatter voice fragments through hand-typed text - the voice stream stays contiguous. The anchor
  // is clamped to the current value length so edits elsewhere can never make
  // it invalid.
  // ---------------------------------------------------------------------------

  const voiceAnchorRef = useRef<number | null>(null);

  // Fix layer 2: a synchronous mirror of the LATEST compose text.
  // The render-time effect below covers typing, attachments, clears, and
  // custom-mode prop changes; handleFinalText also writes it directly so two
  // finals landing inside one render frame both see fresh text (setState is
  // async - the second final would otherwise read the pre-insert value).
  const currentTextRef = useRef("");

  // Dictation provenance: true once any voice final lands in the current
  // draft, reset on send. Sent as dictated=1 so the written block carries a marker -
  // readers (human + agent) then know the text is transcribed speech and may
  // carry transcription wonk. Editing after dictating keeps the flag: the
  // bulk of the text is still voice-born.
  const voiceUsedRef = useRef(false);

  const handleFinalText = useCallback(
    (text: string) => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      voiceUsedRef.current = true;
      const currentValue = currentTextRef.current;

      // Lazily anchor on the first final if session-start capture missed
      // (belt and braces).
      if (voiceAnchorRef.current === null) {
        voiceAnchorRef.current = textarea.selectionStart ?? currentValue.length;
      }

      // Pure insertion maths (additive contract pinned in voice-insert tests):
      // clamp is protective only, text after the anchor is preserved, the
      // anchor advances so the next final lands behind this one.
      const { newValue, newAnchor } = computeVoiceInsert(
        currentValue,
        voiceAnchorRef.current,
        text
      );
      voiceAnchorRef.current = newAnchor;
      currentTextRef.current = newValue;

      if (isCustomMode && onChange) {
        onChange(newValue);
      } else {
        commitDraft(newValue);
      }
    },
    [isCustomMode, onChange, commitDraft]
  );

  // Render-time mirror: covers every other path that changes the compose
  // text (typing, Ctrl+Enter newline, attachment insertion, submit clear,
  // custom-mode prop updates). handleFinalText's synchronous write above
  // covers the same-frame final-burst case this effect cannot.
  const latestComposeText = isCustomMode ? (value ?? "") : draft;
  useEffect(() => {
    currentTextRef.current = latestComposeText;
  }, [latestComposeText]);

  const { micAvailable, isActive, interimText, toggleMic, stopVoice } =
    useVoice(
      voiceProxyUrl,
      handleFinalText,
      debug ? handleDebugEvent : undefined,
      debug
    );

  const voiceEnabled = voiceDisabledReason === null;
  const micLabel = voiceDisabledReason !== null
    ? voiceDisabledReason
    : !micAvailable
      ? "Voice unavailable"
      : isActive
        ? "Stop voice recording"
        : "Start voice recording";

  // Capture the anchor at the voice-session activation edge; clear on end so
  // the next session re-anchors at the then-current cursor. Deliberately NOT
  // re-captured as the user types mid-session.
  //
  // Anchor-source fix: anchor against the ACTUAL current text, not selectionStart
  // blindly. Two problems with the old read:
  //   1. selectionStart is 0 for a textarea that was never focused (the common
  //      case - the user clicks the mic without first clicking into the box),
  //      so dictation anchored at position 0 and prepended to / mangled an
  //      existing draft instead of appending.
  //   2. The per-agent-drafts refactor made `draft` load
  //      ASYNCHRONOUSLY post-mount, so reading `draft` here could capture a
  //      stale value relative to the buffer handleFinalText actually inserts
  //      into (currentTextRef).
  // Fix: source the value from currentTextRef.current (the same synchronous
  // mirror handleFinalText computes against - they can never disagree), and
  // only honour selectionStart when the textarea genuinely holds focus (a
  // real cursor the user placed). Otherwise anchor at the END of the current
  // text so dictation appends. This keeps the "insert at the user's
  // cursor" behaviour intact while fixing the unfocused/stale-draft cases.
  const prevVoiceActiveRef = useRef(false);
  useEffect(() => {
    if (isActive && !prevVoiceActiveRef.current) {
      const textarea = textareaRef.current;
      // currentTextRef is the live mirror of the rendered draft; prefer it over
      // the (possibly not-yet-loaded) `draft`/`value` so the anchor and the
      // insert buffer are always the same string.
      const currentValue = currentTextRef.current;
      const isFocused =
        typeof document !== "undefined" &&
        textarea !== null &&
        document.activeElement === textarea;
      voiceAnchorRef.current =
        isFocused && textarea.selectionStart !== null
          ? textarea.selectionStart
          : currentValue.length;
    }
    if (!isActive && prevVoiceActiveRef.current) {
      voiceAnchorRef.current = null;
    }
    prevVoiceActiveRef.current = isActive;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive]);

  // ---------------------------------------------------------------------------
  // Upload pipeline: picker, paste, drag-drop all call this one function.
  // ---------------------------------------------------------------------------

  async function uploadFiles(files: FileList | File[]) {
    const fileList = Array.from(files).slice(0, 5);
    if (fileList.length === 0) return;

    const fd = new FormData();
    fd.set("intent", "attach");
    for (const f of fileList) {
      fd.append("files[]", f);
    }

    attachFetcher.submit(fd, { method: "post", encType: "multipart/form-data" });
  }

  // React to attachFetcher completion and push returned markdown into
  // pending chips. The markdown link text encodes the filename; detect images by
  // whether the markdown starts with "!" (image syntax vs plain link syntax).
  // insertMarkdownAtCursor is removed - chips replace inline markdown insertion.
  const prevAttachData = useRef<unknown>(null);
  if (attachFetcher.data !== prevAttachData.current) {
    prevAttachData.current = attachFetcher.data;
    const data = attachFetcher.data as
      | { ok?: boolean; attachments?: Array<{ markdown: string }> }
      | undefined;
    if (data?.ok && data.attachments) {
      const newChips = data.attachments.map((a) => {
        // Image markdown: ![filename](/attachments/...)
        // Plain markdown:  [filename](/attachments/...)
        const isImage = a.markdown.startsWith("!");
        // Extract filename from the link text: content between [ and ].
        const filenameMatch = a.markdown.match(/\[([^\]]+)\]/);
        const filename = filenameMatch?.[1] ?? "attachment";
        return { markdown: a.markdown, filename, isImage };
      });
      setPendingAttachments((prev) => [...prev, ...newChips]);
    }
  }

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    // Stop voice before submitting - no hot mic survives send.
    stopVoice();

    // Build FormData manually so pending attachment markdowns are
    // merged into the body/text field via buildOutgoingBody. This keeps the
    // action schema unchanged - body/text remain free strings.
    const markdowns = pendingAttachments.map((a) => a.markdown);
    const fd = new FormData();

    if (isCustomMode) {
      // Custom/card-answer mode: always POST directly (exempt from batching).
      const mergedText = buildOutgoingBody(currentDraft, markdowns);
      fd.set("intent", "custom");
      fd.set("decisionId", respondingToDecisionId ?? "");
      fd.set("text", mergedText);

      fetcher.submit(fd, { method: "post" });

      // Clear draft + pending after submit (also clears the persisted draft).
      voiceUsedRef.current = false;
      setPendingAttachments([]);
      if (onSent) onSent();
    } else if (onBatchSubmit) {
      // Standard mode with batch hook - buffer the message; do NOT POST.
      // The parent will fire the real POST after settle or send-now.
      const mergedBody = buildOutgoingBody(currentDraft, markdowns);
      if (mergedBody.trim()) {
        const dictated = voiceUsedRef.current;
        onBatchSubmit(mergedBody, dictated);
        // Record the Enter-press time for the double-Enter send-now detection.
        lastBatchEnterMsRef.current = Date.now();
      }
      // Clear the compose box immediately so the user can type the next message.
      commitDraft("");
      // Clear live draft preview now that the message is in the batch.
      if (onDraftChange) onDraftChange("");
      voiceUsedRef.current = false;
      setPendingAttachments([]);
      // Note: onSent is NOT called here (it clears the custom-answer context).
      // Standard-mode callers do not use onSent.
    } else {
      // Standard mode without batch hook: original direct-POST behaviour.
      // Used by tests and any context where the batch prop is not wired.
      const mergedBody = buildOutgoingBody(currentDraft, markdowns);
      fd.set("intent", "compose");
      fd.set("body", mergedBody);
      // Dictation provenance marker - only on plain replies (custom answers
      // resolve into the card record, where the marker has no surface).
      if (voiceUsedRef.current) fd.set("dictated", "1");

      fetcher.submit(fd, { method: "post" });

      // Clear draft + pending after submit (also clears the persisted draft).
      commitDraft("");
      voiceUsedRef.current = false;
      setPendingAttachments([]);
      if (onSent) onSent();
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key !== "Enter") return;
    // Never submit mid-IME composition (e.g. dictation/intl input commits via Enter).
    if (e.nativeEvent.isComposing) return;
    // Ctrl+Enter inserts a newline (Shift+Enter does too, via browser default).
    if (e.ctrlKey) {
      e.preventDefault();
      const el = e.currentTarget;
      const start = el.selectionStart ?? currentDraft.length;
      const end = el.selectionEnd ?? start;
      const next = currentDraft.slice(0, start) + "\n" + currentDraft.slice(end);
      if (isCustomMode && onChange) onChange(next);
      else commitDraft(next);
      requestAnimationFrame(() => {
        el.selectionStart = el.selectionEnd = start + 1;
      });
      return;
    }
    if (e.shiftKey) return;

    e.preventDefault();

    // Double-Enter send-now override (standard mode + batch hook only).
    // If the draft is empty and a batch Enter happened within DOUBLE_ENTER_MS,
    // fire send-now instead of a normal (empty) submit. This lets the operator tap
    // Enter twice in quick succession after a message to skip the settle window.
    if (
      onBatchSendNow &&
      !isCustomMode &&
      !currentDraft.trim() &&
      pendingAttachments.length === 0
    ) {
      const nowMs = Date.now();
      if (nowMs - lastBatchEnterMsRef.current <= DOUBLE_ENTER_MS) {
        lastBatchEnterMsRef.current = 0;
        onBatchSendNow();
        return;
      }
      // No pending draft and no batch to send-now: nothing to do.
      return;
    }

    // Plain Enter sends, matching every chat surface the operator lives in.
    // Allow send when there are pending attachments even if the draft is empty
    // (attachment-only sends are legal - mirrors the Send button disabled logic).
    if (busy || uploading || (!currentDraft.trim() && pendingAttachments.length === 0)) return;
    e.currentTarget.form?.requestSubmit();
  }

  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    // Use extractPasteFiles to handle both file-manager copies
    // (clipboardData.files) and bitmap pastes from Snipping Tool etc.
    // (clipboardData.items of kind "file"). preventDefault only when files
    // found so plain text pastes keep native behaviour.
    if (!e.clipboardData) return;
    const files = extractPasteFiles(e.clipboardData);
    if (files.length > 0) {
      e.preventDefault();
      uploadFiles(files);
    }
  }

  function handleDragEnter(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragCount((c) => c + 1);
  }

  function handleDragLeave(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragCount((c) => Math.max(0, c - 1));
  }

  function handleDragOver(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragCount(0);
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      uploadFiles(files);
    }
  }

  function handlePaperclipClick() {
    fileInputRef.current?.click();
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (files && files.length > 0) {
      uploadFiles(files);
      // Reset the input so the same file can be picked again.
      e.target.value = "";
    }
  }

  const showDragOverlay = dragCount > 0;
  const currentDraft = isCustomMode ? (value ?? "") : draft;
  // Send is allowed when there is text OR pending attachments.
  const hasSendable = currentDraft.trim().length > 0 || pendingAttachments.length > 0;

  // Auto-grow the textarea with its content so a long dictated block is
  // fully visible. Reset to auto first so it can SHRINK
  // when text is deleted; the className max-h caps it and overflow scrolls past
  // the cap. Runs on every draft change (typing, voice append, paste, custom-mode
  // sync) since they all flow through currentDraft.
  useEffect(() => {
    const el = textareaRef.current;
    if (el === null) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [currentDraft]);

  return (
    <div
      className="relative sticky bottom-0 border-t border-border bg-card/80 px-4 pt-3 backdrop-blur-sm"
      style={{ paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom, 0px))" }}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Drag-drop overlay */}
      {showDragOverlay ? (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-md border-2 border-dashed border-primary bg-primary/5">
          <span className="label-mono text-sm text-primary">Drop files to attach</span>
        </div>
      ) : null}

      {/* Voice debug panel - mounted above compose box when ?debug=1 */}
      {debug ? <VoiceDebugPanel events={debugEvents} /> : null}

      {/* Responding-to context banner (custom answer mode only) */}
      {isCustomMode && respondingToSubject ? (
        <div className="mx-auto mb-2 flex max-w-2xl items-center gap-2">
          {/* The only user-visible signal that the composer is tied to a card
              rather than sending plain chat, so it is also the thing the
              cross-route reply-context tests assert on. */}
          <span
            data-testid="responding-to-banner"
            className="label-mono flex-1 truncate text-xs text-primary"
          >
            Responding to: {respondingToSubject}
          </span>
          {onCancel ? (
            <button
              type="button"
              onClick={onCancel}
              className="text-muted-foreground hover:text-foreground"
              aria-label="Cancel responding"
              title="Cancel responding"
            >
              <X className="size-3.5" />
            </button>
          ) : null}
        </div>
      ) : null}

      {/* Hidden file input for paperclip picker */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        /* Any-type policy: no accept filter - the server
           classifies; unknown types store + serve as downloads. */
        className="sr-only"
        aria-hidden="true"
        onChange={handleFileChange}
        data-testid="attach-file-input"
      />

      <fetcher.Form
        method="post"
        className="mx-auto flex max-w-2xl flex-col gap-1"
        onSubmit={handleSubmit}
      >
        {/* Hidden fields switch the intent based on mode */}
        {isCustomMode ? (
          <>
            <input type="hidden" name="intent" value="custom" />
            <input type="hidden" name="decisionId" value={respondingToDecisionId} />
          </>
        ) : (
          <input type="hidden" name="intent" value="compose" />
        )}

        {/* Voice ghost row: shown while active and interim text is non-empty */}
        {isActive && interimText ? (
          <div
            className="rounded-md border border-input bg-background px-3 py-1.5 text-sm text-muted-foreground/60 italic"
            aria-live="polite"
            aria-label="Voice interim transcript"
            data-testid="voice-ghost"
          >
            {interimText}
          </div>
        ) : null}

        {/* Pending attachment chips - shown above the textarea when
            at least one file has been uploaded but not yet sent. Each chip
            shows an icon (image vs file), the truncated filename, and a
            44px-target X to remove the chip (file stays on disk). */}
        {pendingAttachments.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {pendingAttachments.map((chip, idx) => (
              <div
                key={idx}
                className="flex items-center gap-1 rounded-md border border-input bg-muted px-2 py-1 text-xs text-foreground"
                data-testid="pending-attachment-chip"
              >
                {chip.isImage ? (
                  <FileImage className="size-3 shrink-0 text-muted-foreground" />
                ) : (
                  <FileText className="size-3 shrink-0 text-muted-foreground" />
                )}
                <span className="max-w-[140px] truncate" title={chip.filename}>
                  {chip.filename}
                </span>
                <button
                  type="button"
                  aria-label={`Remove attachment ${chip.filename}`}
                  title={`Remove ${chip.filename}`}
                  className="ml-0.5 flex size-[44px] shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
                  style={{ minWidth: "44px", minHeight: "44px" }}
                  onClick={() =>
                    setPendingAttachments((prev) => prev.filter((_, i) => i !== idx))
                  }
                  data-testid="pending-attachment-remove"
                >
                  <X className="size-3" />
                </button>
              </div>
            ))}
          </div>
        ) : null}

        {/* Outer wrapper: positions the floating gear above the compose row */}
        <div className="relative">
          <label htmlFor="compose-body" className="sr-only">
            {isCustomMode ? "Write your answer" : "Reply"}
          </label>

          {/* Gear and Send button live in the same right-hand column */}

          <div className="flex items-end gap-2">
            {/* Textarea wrapper: mic + attach icons sit inside the border, bottom-right */}
            <div className="flex-1">
            <div className="relative">
              <textarea
                id="compose-body"
                ref={textareaRef}
                name={isCustomMode ? "text" : "body"}
                required={pendingAttachments.length === 0}
                rows={2}
                disabled={busy || uploading}
                placeholder={isCustomMode ? "Write your answer..." : "Write a reply..."}
                data-testid="compose-textarea"
                value={currentDraft}
                onChange={
                  isCustomMode && onChange
                    ? (e) => onChange(e.target.value)
                    : (e) => {
                        commitDraft(e.target.value);
                        // Signal a keystroke to the batch state machine so the
                        // settle timer is hard-suspended while a follow-up draft is active.
                        if (onBatchType) onBatchType();
                        // Propagate live draft text for preview in the pending bubble.
                        if (onDraftChange) onDraftChange(e.target.value);
                      }
                }
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                className="min-h-10 max-h-[40vh] w-full resize-none overflow-y-auto rounded-md border border-input bg-background px-3 py-2 pr-[5rem] pb-10 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1 focus:ring-offset-background disabled:opacity-50"
              />

              {/* Attach + Mic live inside the textarea border, bottom-right corner */}
              <div className="absolute bottom-1.5 right-1.5 flex items-center gap-0.5">
                {/* Paperclip - wired to file picker */}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled={uploading}
                  aria-label={uploading ? "Uploading..." : "Attach a file"}
                  title={uploading ? "Uploading..." : "Attach a file"}
                  className="h-9 w-9 p-0 min-h-0 min-w-0 text-muted-foreground"
                  onClick={handlePaperclipClick}
                  data-testid="attach-button"
                >
                  <Paperclip className={cn("h-5 w-5", uploading ? "animate-pulse" : "")} />
                </Button>

                {/* Mic button - live when voiceProxyUrl present and mic available;
                    disabled with an explicit reason when no key is configured (#27). */}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled={!voiceEnabled || !micAvailable}
                  aria-label={micLabel}
                  title={micLabel}
                  className="relative h-9 w-9 p-0 min-h-0 min-w-0 text-muted-foreground"
                  onClick={toggleMic}
                  data-testid="mic-button"
                >
                  {/* Pulse indicator while active */}
                  {isActive ? (
                    <span className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-primary animate-pulse" />
                  ) : null}
                  {voiceEnabled ? (
                    <Mic className={cn("h-5 w-5", isActive ? "text-primary" : "")} />
                  ) : (
                    <MicOff className="h-5 w-5" />
                  )}
                </Button>
              </div>
            </div>
            {/* Outside the textarea box so it can never sit over typed text (#27). */}
            {!voiceEnabled ? (
              <p
                className="mt-1 text-xs text-muted-foreground"
                data-testid="voice-disabled-note"
              >
                {voiceDisabledReason}
              </p>
            ) : null}
            </div>

            {/* Right-hand column: gear above, Send below */}
            <div className="flex flex-col items-center gap-1">
              {batchPrefs && onBatchPrefsChange ? (
                <div ref={settingsRef} className="relative">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="Batch send settings"
                    title="Batch send settings"
                    className="h-7 w-7 p-0 text-muted-foreground/60 hover:text-muted-foreground"
                    onClick={() => setSettingsOpen((o) => !o)}
                    data-testid="batch-settings-button"
                  >
                    <Settings2 className="h-3.5 w-3.5" />
                  </Button>
                  {settingsOpen ? (
                    <div
                      className="absolute bottom-full right-0 mb-1 z-50 w-56 rounded-md border border-border bg-popover p-3 shadow-md"
                      data-testid="batch-settings-popover"
                    >
                      <p className="label-mono mb-2 text-xs font-medium text-muted-foreground">
                        Hold indicator
                      </p>
                      <div className="flex flex-col gap-1 mb-3">
                        {(["none", "subtle", "pill"] as HoldIndicator[]).map((mode) => (
                          <button
                            key={mode}
                            type="button"
                            onClick={() => onBatchPrefsChange({ holdIndicator: mode })}
                            className={`rounded px-2 py-1 text-left text-xs capitalize transition-colors ${
                              batchPrefs.holdIndicator === mode
                                ? "bg-primary text-primary-foreground"
                                : "hover:bg-muted text-foreground"
                            }`}
                            data-testid={`batch-indicator-${mode}`}
                          >
                            {mode === "none" ? "None" : mode === "subtle" ? "Subtle" : "Pill"}
                          </button>
                        ))}
                      </div>
                      {/* Live preview toggle */}
                      <div className="mb-3 flex items-center justify-between">
                        <span className="label-mono text-xs text-muted-foreground">
                          Show typing in bubble
                        </span>
                        <Switch
                          id="batch-live-preview"
                          checked={batchPrefs.livePreview}
                          onChange={(e) =>
                            onBatchPrefsChange({ livePreview: e.target.checked })
                          }
                          data-testid="batch-live-preview-switch"
                        />
                      </div>
                      <label className="label-mono text-xs text-muted-foreground">
                        Hold time (seconds)
                        <input
                          type="number"
                          min={2}
                          max={300}
                          step={1}
                          value={holdSecondsDraft}
                          onChange={(e) => {
                            // Update draft only -- no clamping mid-type so values
                            // like 10-19 are reachable without the "1" snapping to 2.
                            setHoldSecondsDraft(e.target.value);
                          }}
                          onBlur={() => {
                            const parsed = parseInt(holdSecondsDraft, 10);
                            if (!Number.isNaN(parsed) && onBatchPrefsChange) {
                              onBatchPrefsChange({ holdSeconds: parsed });
                              // Mirror the [2,300] clamp the hook applies so the
                              // draft shows the settled value without waiting for
                              // a parent re-render cycle.
                              const clamped = Math.max(2, Math.min(300, parsed));
                              setHoldSecondsDraft(String(clamped));
                            } else {
                              // Invalid / empty: revert to last committed value.
                              setHoldSecondsDraft(String(batchPrefs.holdSeconds));
                            }
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              (e.target as HTMLInputElement).blur();
                            }
                          }}
                          className="mt-1 block w-full rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1 focus:ring-offset-background"
                          data-testid="batch-hold-seconds-input"
                        />
                      </label>
                    </div>
                  ) : null}
                </div>
              ) : null}

              <Button
                type="submit"
                disabled={busy || uploading || !hasSendable}
                className="min-h-11 shrink-0 mb-1.5"
              >
                {busy ? "Sending..." : "Send"}
              </Button>
            </div>
          </div>
        </div>
      </fetcher.Form>
    </div>
  );
}
