import { data } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/api.acp";
import { requireSameOriginWrite } from "~/lib/request-origin.server";
import { acpRunnerRegistry } from "~/lib/runner/acp-registry.server";
import { antigravityUsageReading, isAcpOptedIn } from "~/lib/runner/acp-manifest";
import { StartRefusal } from "~/lib/runner/registry.server";
import { AGENT_NAME_RE } from "~/lib/safe-fs.server";

const postPayload = z.discriminatedUnion("op", [
  z.object({
    agent: z.string().regex(AGENT_NAME_RE),
    op: z.literal("start"),
    resume: z.boolean().optional(),
  }).strict(),
  z.object({
    agent: z.string().regex(AGENT_NAME_RE),
    op: z.literal("stop"),
  }).strict(),
  z.object({
    agent: z.string().regex(AGENT_NAME_RE),
    op: z.literal("cancel"),
  }).strict(),
  z.object({
    agent: z.string().regex(AGENT_NAME_RE),
    op: z.literal("prompt"),
    text: z.string().min(1).max(32_768),
  }).strict(),
  z.object({
    agent: z.string().regex(AGENT_NAME_RE),
    op: z.literal("answer-permission"),
    eventId: z.string().min(1).max(64),
    optionId: z.string().min(1).max(64),
  }).strict(),
]);

const refusalMessage: Record<StartRefusal["reason"], string> = {
  "not-opted-in": "The agent has not opted in to ACP.",
  busy: "An ACP session is already starting, running or stopping.",
  "tmux-active": "Close the agent's tmux window before starting ACP.",
  "tmux-unknown": "Could not verify that the agent's tmux window is closed.",
  locked: "An ACP session lock is still held or could not be recovered.",
  "shutting-down": "Deck is shutting down.",
};

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const agent = url.searchParams.get("agent") ?? "";
  if (!AGENT_NAME_RE.test(agent)) {
    return data({ ok: false, error: "Invalid agent name." }, { status: 400 });
  }
  const optedIn = isAcpOptedIn(process.env, agent);
  return {
    ok: true,
    optedIn,
    status: acpRunnerRegistry.status(agent) ?? { state: "stopped" as const, code: null, exitedAt: 0 },
    events: acpRunnerRegistry.events(agent),
    lastSessionId: acpRunnerRegistry.lastSessionId(agent) ?? null,
    usageReading: antigravityUsageReading(),
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  requireSameOriginWrite(request, context);
  if (request.method !== "POST") {
    return data({ ok: false, error: "Use POST to control an ACP session." }, { status: 405, headers: { Allow: "POST" } });
  }
  const parsed = postPayload.safeParse(await request.json().catch(() => undefined));
  if (!parsed.success) {
    return data({ ok: false, error: "Invalid ACP runner payload." }, { status: 400 });
  }
  const body = parsed.data;
  const { agent, op } = body;

  if (!isAcpOptedIn(process.env, agent) && (op === "start" || !acpRunnerRegistry.canControl(agent))) {
    return data({ ok: false, error: refusalMessage["not-opted-in"] }, { status: 403 });
  }

  try {
    if (op === "start") {
      await acpRunnerRegistry.start(agent, { resume: body.resume });
      return { ok: true, status: acpRunnerRegistry.status(agent) };
    }
    if (op === "stop") {
      await acpRunnerRegistry.stop(agent);
      return { ok: true };
    }
    if (op === "cancel") {
      if (!await acpRunnerRegistry.cancel(agent)) {
        return data({ ok: false, error: "The ACP session is not running." }, { status: 409 });
      }
      return { ok: true };
    }
    if (op === "prompt") {
      const session = acpRunnerRegistry.getActiveSession(agent);
      if (!session || session.state.kind === "disconnected" || session.state.kind === "failed" || session.state.kind === "unsupported") {
        return data({ ok: false, error: "The ACP session is not running." }, { status: 409 });
      }
      const wasBusy = session.state.kind === "busy" || session.state.kind === "waiting" || session.queuedCount > 0;
      void session.prompt(body.text).catch(() => {});
      return { ok: true, queued: wasBusy, queuedCount: session.queuedCount };
    }
    if (op === "answer-permission") {
      const session = acpRunnerRegistry.getActiveSession(agent);
      if (!session) {
        return data({ ok: false, error: "No active ACP session for this agent." }, { status: 409 });
      }
      const accepted = session.answerPermission(body.eventId, body.optionId);
      if (!accepted) {
        return data({ ok: false, error: "Permission request is stale, already answered, or invalid." }, { status: 409 });
      }
      return { ok: true };
    }
    return data({ ok: false, error: "Unsupported operation." }, { status: 400 });
  } catch (error) {
    if (error instanceof StartRefusal) {
      return data({ ok: false, error: refusalMessage[error.reason] }, { status: 409 });
    }
    if (error instanceof Error && error.name === "LaunchFailure") {
      return data({ ok: false, error: error.message }, { status: 503 });
    }
    return data({ ok: false, error: `Could not execute ACP ${op}.` }, { status: 503 });
  }
}
