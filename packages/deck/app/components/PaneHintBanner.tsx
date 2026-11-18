import { MessageSquare } from "lucide-react";
import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";
import { Link } from "react-router";
import type { PaneHintId } from "~/lib/pane-hints";

const CHAT_COPY: Record<PaneHintId, (agent: string) => string> = {
  H1: (agent) => `${agent}'s CLI appears to be asking whether to trust this agent's folder. Check the terminal before choosing an option.`,
  H2: (agent) => `${agent}'s CLI appears to need a one-time sign-in. Check the terminal before choosing an option.`,
  H3: (agent) => `${agent}'s CLI appears to have found an API key and is asking whether to use it. Check the terminal before choosing an option.`,
  H4: (agent) => `${agent} appears to be waiting on a setup screen. Check the terminal before choosing an option.`,
  H5: (agent) => `${agent} appears to have exited to a shell in its terminal. Open the terminal to check, then start the agent again.`,
};

const TERMINAL_COPY: Record<PaneHintId, string> = {
  H1: "Folder trust question. Check the terminal before choosing. If you trust this folder, select 'Yes, I trust this folder' with Up or Down, then press Enter.",
  H2: "Sign-in step. Check the terminal before choosing with Up, Down and Enter; a browser link may appear in the pane.",
  H3: "API key question. Check the terminal before choosing with Up, Down and Enter. A key in the environment takes precedence over a subscription sign-in.",
  H4: "Setup screen. Check the terminal before choosing with Up, Down and Enter.",
  H5: "This pane appears to be at a shell prompt, so the agent appears to have exited.",
};

export function TerminalHint({ hint, descriptionId }: { hint: PaneHintId | null; descriptionId: string }) {
  return (
    <p id={descriptionId} role="status" className={hint ? "mb-2 text-sm text-foreground" : undefined}>
      {hint ? TERMINAL_COPY[hint] : ""}
    </p>
  );
}

export function PaneHintBanner({ hint, agent, tmuxOn, focusFallback }: {
  hint: PaneHintId | "H6" | null;
  agent: string;
  tmuxOn: boolean;
  focusFallback: RefObject<HTMLDivElement | null>;
}) {
  const showLink = hint !== null && tmuxOn;
  const terminalLink = useRef<HTMLAnchorElement | null>(null);
  const restoreFocus = useRef(false);
  const linkRef = useCallback((link: HTMLAnchorElement | null) => {
    const previousLink = terminalLink.current;
    if (!link && previousLink) restoreFocus.current = previousLink.ownerDocument.activeElement === previousLink;
    terminalLink.current = link;
  }, []);
  useLayoutEffect(() => {
    if (!showLink && restoreFocus.current) {
      restoreFocus.current = false;
      const fallback = focusFallback.current;
      if (fallback && fallback.ownerDocument.activeElement === fallback.ownerDocument.body) {
        fallback.focus({ preventScroll: true });
      }
    }
  }, [showLink, focusFallback]);

  const emptyCopy = "A new agent writes first after its first start. " +
    (tmuxOn ? "If you expect a message and none has come, open the terminal: the agent may be waiting on a one-time question there. " : "") +
    "Otherwise, send the first message below.";
  return (
    <div className={hint === "H6" ? "mx-auto max-w-sm px-6 py-16 text-center" :
      hint ? "mb-4 rounded-lg border border-border bg-primary/10 px-3 pt-3 text-sm text-foreground" : undefined}>
      {hint === "H6" ? (
        <>
          <MessageSquare aria-hidden="true" className="mx-auto mb-3 size-8 text-muted-foreground/40" />
          <h2 className="mb-2 font-display text-lg font-bold tracking-tight text-foreground">No messages yet</h2>
        </>
      ) : null}
      <p role="status" className={hint === "H6" ? "text-sm text-muted-foreground" : undefined}>
        {hint === "H6" ? emptyCopy : hint ? CHAT_COPY[hint](agent) : ""}
      </p>
      {showLink ? (
        <Link ref={linkRef} to="?view=tmux" className="inline-flex min-h-11 items-center rounded-lg px-3 text-sm font-medium text-foreground underline hover:bg-primary/10">
          Open terminal
        </Link>
      ) : null}
    </div>
  );
}
