import { data } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/api.runner";
import { tmuxEnabled } from "~/lib/instance.server";
import { requireSameOriginWrite } from "~/lib/request-origin.server";
import { isPtyOptedIn, runnerRegistry, StartRefusal } from "~/lib/runner/registry.server";
import { AGENT_NAME_RE } from "~/lib/safe-fs.server";

const payload = z.object({
  agent: z.string().regex(AGENT_NAME_RE),
  op: z.enum(["start", "stop", "cancel"]),
}).strict();

const refusalMessage = {
  "not-opted-in": "The agent has not opted in to PTY.",
  busy: "A PTY session is already starting, running or stopping.",
  "tmux-active": "Close the agent's tmux window before starting PTY.",
  "tmux-unknown": "Could not verify that the agent's tmux window is closed.",
  locked: "A PTY session lock is still held or could not be recovered.",
  "shutting-down": "Deck is shutting down.",
};

export async function action({ request, context }: Route.ActionArgs) {
  requireSameOriginWrite(request, context);
  if (request.method !== "POST") {
    return data({ ok: false, error: "Use POST to control a PTY session." }, { status: 405, headers: { Allow: "POST" } });
  }
  if (!tmuxEnabled(process.env)) {
    return data({ ok: false, error: "The terminal is not available on this instance." }, { status: 403 });
  }
  const parsed = payload.safeParse(await request.json().catch(() => undefined));
  if (!parsed.success) {
    return data({ ok: false, error: "Invalid runner payload." }, { status: 400 });
  }
  const { agent, op } = parsed.data;
  if (!isPtyOptedIn(process.env, agent) && (op === "start" || !runnerRegistry.canControl(agent))) {
    return data({ ok: false, error: refusalMessage["not-opted-in"] }, { status: 403 });
  }
  try {
    if (op === "start") await runnerRegistry.start(agent);
    else if (op === "stop") await runnerRegistry.stop(agent);
    else if (!await runnerRegistry.cancel(agent)) {
      return data({ ok: false, error: "The PTY session is not running." }, { status: 409 });
    }
    return { ok: true };
  } catch (error) {
    if (error instanceof StartRefusal) {
      return data({ ok: false, error: refusalMessage[error.reason] }, { status: 409 });
    }
    const status = runnerRegistry.status(agent);
    return data({ ok: false, error: status?.state === "unavailable" ? status.reason : `Could not ${op} the PTY session.` }, { status: 503 });
  }
}
