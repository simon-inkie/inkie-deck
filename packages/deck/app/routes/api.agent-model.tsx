/**
 * api.agent-model.tsx - the ONE seam for per-agent model selection (M4).
 *
 * GET  ?agent=<name>        -> { agent, runtime, model, options }
 *   .runtime picks the option set from model-catalog.json; .model is the
 *   configured model (null = inherit the global default).
 * POST { agent, model }     -> { persisted: true, liveSwitched: false }
 *   Validates agent against the ROSTER window-name regex AND model against
 *   the catalog options for that agent's runtime, then atomically writes
 *   <AGENTS_ROOT>/<agent>/.model (temp + rename). Invalid input -> 400 with
 *   a clear message.
 *
 * PERSIST-ONLY (v1): liveSwitched is always false - no /model send-keys into
 * a pane ever happens here (mid-turn it would land as a conversation message,
 * not a command). The pick applies on the agent's next boot/restart; the UI
 * says so.
 *
 * OPERATOR GATE: server-side via modelSelectorEnabled, not just hidden UI -
 * a principal instance refuses both verbs with a
 * 403 even when the endpoint is hit directly (same posture as api.tmux-send).
 *
 * SEAM RULE: imports ONLY from agent-model.server / instance.server
 * / safe-fs.server - no fs, no env literals beyond process.env handoff.
 * Validates at the boundary (parse-don't-validate).
 *
 * ASCII only - no em-dashes.
 */
import { z } from "zod";
import { data } from "react-router";
import type { Route } from "./+types/api.agent-model";
import { requireSameOriginWrite } from "~/lib/request-origin.server";
import { getAgentModelInfo, setAgentModel } from "~/lib/agent-model.server";
import { modelSelectorEnabled } from "~/lib/instance.server";
import { AGENT_NAME_RE } from "~/lib/safe-fs.server";

const GATE_MESSAGE = "The model selector is not available on this instance.";

const postSchema = z.object({
  agent: z.string().regex(AGENT_NAME_RE),
  // Length-bounded only; membership is checked against the catalog for the
  // agent's runtime inside setAgentModel (the id list is data, not schema).
  model: z.string().min(1).max(200),
});

export async function loader({ request }: Route.LoaderArgs) {
  if (!modelSelectorEnabled(process.env)) {
    return data({ error: GATE_MESSAGE }, { status: 403 });
  }
  const agent = new URL(request.url).searchParams.get("agent") ?? "";
  if (!AGENT_NAME_RE.test(agent)) {
    return data({ error: "Unknown or invalid agent." }, { status: 400 });
  }
  const info = getAgentModelInfo(process.env, agent);
  return {
    agent,
    runtime: info.runtime,
    model: info.model,
    options: info.options,
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  requireSameOriginWrite(request, context);
  if (!modelSelectorEnabled(process.env)) {
    return data({ error: GATE_MESSAGE }, { status: 403 });
  }
  const formData = await request.formData();
  const parsed = postSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return data({ error: "Invalid model payload." }, { status: 400 });
  }
  const result = setAgentModel(
    process.env,
    parsed.data.agent,
    parsed.data.model
  );
  if (!result.ok) {
    return data({ error: result.error }, { status: 400 });
  }
  // v1 contract: persisted to .model; no live pane switch was attempted.
  return { persisted: true as const, liveSwitched: false as const };
}
