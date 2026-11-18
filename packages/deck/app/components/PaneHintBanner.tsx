import { MessageSquare } from "lucide-react";
import { Link } from "react-router";
import type { PaneHintId } from "~/lib/pane-hints";

const CHAT_COPY: Record<PaneHintId, (agent: string) => string> = {
  H1: (agent) => `${agent} is waiting for you in its terminal. Its CLI is asking whether to trust this agent's folder, once. Open the terminal to answer.`,
  H2: (agent) => `${agent}'s CLI needs a one-time sign-in. Open the terminal and follow its steps.`,
  H3: (agent) => `${agent}'s CLI found an API key and is asking whether to use it. Open the terminal to answer.`,
  H4: (agent) => `${agent} is waiting on a setup screen in its terminal.`,
  H5: (agent) => `${agent} appears to have exited to a shell in its terminal. Open the terminal to check, then start the agent again.`,
};

const TERMINAL_COPY: Record<PaneHintId, string> = {
  H1: "Folder trust question. If you trust this folder, select 'Yes, I trust this folder' with Up or Down, then press Enter.",
  H2: "Sign-in step. Use Up, Down and Enter to choose; a browser link may appear in the pane.",
  H3: "API key question. Choose with Up or Down, then press Enter. A key in the environment takes precedence over a subscription sign-in.",
  H4: "Setup screen. Use Up, Down and Enter to choose.",
  H5: "This pane appears to be at a shell prompt, so the agent appears to have exited.",
};

type Props =
  | { hint: PaneHintId | "H6"; agent: string; tmuxOn: boolean }
  | { hint: PaneHintId; descriptionId: string };

export function PaneHintBanner(props: Props) {
  const { hint } = props;
  if ("descriptionId" in props) {
    return (
      <p id={props.descriptionId} role="status" aria-live="polite" className="mb-2 text-sm text-foreground">
        {TERMINAL_COPY[props.hint]}
      </p>
    );
  }

  const terminalLink = props.tmuxOn ? (
    <Link to="?view=tmux" className="inline-flex min-h-11 items-center rounded-lg px-3 text-sm font-medium text-foreground underline hover:bg-primary/10">
      Open terminal
    </Link>
  ) : null;

  if (hint === "H6") {
    return (
      <div role="status" aria-live="polite" className="mx-auto max-w-sm px-6 py-16 text-center">
        <MessageSquare aria-hidden="true" className="mx-auto mb-3 size-8 text-muted-foreground/40" />
        <h2 className="mb-2 font-display text-lg font-bold tracking-tight text-foreground">No messages yet</h2>
        <p className="text-sm text-muted-foreground">
          A new agent writes first after its first start.{" "}
          {props.tmuxOn ? "If you expect a message and none has come, open the terminal: the agent may be waiting on a one-time question there. " : ""}
          Otherwise, send the first message below.
        </p>
        {terminalLink}
      </div>
    );
  }

  return (
    <div role="status" aria-live="polite" className="mb-4 rounded-lg border border-border bg-primary/10 px-3 pt-3 text-sm text-foreground">
      <p>{CHAT_COPY[hint](props.agent)}</p>
      {terminalLink}
    </div>
  );
}
