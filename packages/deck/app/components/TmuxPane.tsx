/**
 * TmuxPane.tsx - the terminal surface (TASK-437 read, v2 adds write).
 *
 * One dark pane, two homes: the /tmux Team tab (window picker above it)
 * and the thread view in ?view=tmux mode (one agent's window). Renders
 * the captured text or the honest unavailable state.
 *
 * WRITE (v2): when `sendTarget` is provided, a compose row renders under the
 * pane - typing + Send posts to /api/tmux-send (literal text, 1s gap, Enter)
 * which types straight into that agent's live Claude session. When sendTarget
 * is ABSENT, no input renders at all - the read-only posture is one prop away,
 * so a caller that wants view-only just omits it (the fallback is structural).
 *
 * No .server imports - FND-02 (the useFetcher POST does the server work).
 * ASCII only - no em-dashes - FND-05.
 */
import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { EmptyState } from "./EmptyState";
import { TerminalSquare, CornerDownLeft } from "lucide-react";

type SendData = { ok: true } | { ok: false; error: string };

/**
 * The write affordance. A small textarea + Send that posts to the one send
 * seam. Enter submits, Shift+Enter is a newline. Clears only after a send
 * SETTLES ok, so a failed send keeps the typed text for a retry.
 */
function TmuxCompose({ sendTarget }: { sendTarget: string }) {
  const fetcher = useFetcher<SendData>();
  const [text, setText] = useState("");
  const prevState = useRef(fetcher.state);
  const busy = fetcher.state !== "idle";
  const error =
    fetcher.data !== undefined && fetcher.data.ok === false
      ? fetcher.data.error
      : undefined;

  // Clear the box only when a submission transitions back to idle with ok.
  useEffect(() => {
    if (prevState.current !== "idle" && fetcher.state === "idle") {
      if (fetcher.data?.ok) setText("");
    }
    prevState.current = fetcher.state;
  }, [fetcher.state, fetcher.data]);

  function send() {
    if (text.trim() === "" || busy) return;
    fetcher.submit(
      { window: sendTarget, text },
      { method: "post", action: "/api/tmux-send" }
    );
  }

  return (
    <div className="mt-2 shrink-0">
      {error !== undefined ? (
        <p
          data-testid="tmux-compose-error"
          className="label-mono mb-1 text-[10px] text-destructive"
        >
          {error}
        </p>
      ) : null}
      <div className="flex items-end gap-2">
        <textarea
          data-testid="tmux-compose-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          rows={1}
          placeholder={`Type to ${sendTarget}'s session - Enter sends, Shift+Enter newline`}
          className="min-h-11 flex-1 resize-none rounded-lg border border-border bg-[#1c2724] px-3 py-2.5 font-mono text-xs text-[#fffdf5]/90 placeholder:text-[#fffdf5]/30 focus:border-primary focus:outline-none"
        />
        <button
          type="button"
          data-testid="tmux-compose-send"
          onClick={send}
          disabled={busy || text.trim() === ""}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-primary bg-primary/10 px-3 text-xs text-foreground transition-colors hover:bg-primary/20 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <CornerDownLeft className="h-3.5 w-3.5" />
          {busy ? "Sending" : "Send"}
        </button>
      </div>
    </div>
  );
}

export function TmuxPane({
  pane,
  windowName,
  sendTarget,
}: {
  /** Captured pane text; undefined renders the unavailable state. */
  pane: string | undefined;
  /** The window this pane mirrors (named in the unavailable copy). */
  windowName: string | undefined;
  /**
   * When set, a compose row renders under the pane and sends to this window.
   * Omit for a read-only pane - that omission IS the read-only fallback.
   */
  sendTarget?: string;
}) {
  // Follow-bottom: the pane now carries scrollback history (server captures
  // -S -1000), so it lands on the LATEST line and follows new output - unless
  // the operator has scrolled up to read history, in which case their position
  // is preserved across the 1s poll re-render (mirrors the TASK-454 chat
  // scroll-follow). atBottomRef starts true so the first render lands at bottom.
  const preRef = useRef<HTMLPreElement>(null);
  const atBottomRef = useRef(true);

  function handleScroll() {
    const el = preRef.current;
    if (el === null) return;
    atBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }

  useEffect(() => {
    const el = preRef.current;
    if (el !== null && atBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [pane]);

  // The compose row is gated on sendTarget, NOT on pane presence: a capture
  // tick can fail transiently while the window is still live and sendable, so
  // hiding the input on an unavailable pane would strand the operator. The
  // send path carries its own allowlist gate and surfaces an inline error if
  // the window really is gone.
  const compose =
    sendTarget !== undefined ? <TmuxCompose sendTarget={sendTarget} /> : null;

  if (pane === undefined) {
    return (
      <>
        <EmptyState
          icon={TerminalSquare}
          title="Pane unavailable"
          body={
            windowName !== undefined
              ? `Could not capture "${windowName}" right now - it retries on the next tick.`
              : "Pick a window above."
          }
        />
        {compose}
      </>
    );
  }

  return (
    <>
      <pre
        ref={preRef}
        onScroll={handleScroll}
        data-testid="tmux-pane"
        className="min-h-0 flex-1 overflow-auto rounded-lg border border-border bg-[#1c2724] p-4 font-mono text-xs leading-relaxed text-[#fffdf5]/90 whitespace-pre"
      >
        {pane}
      </pre>
      {compose}
    </>
  );
}
