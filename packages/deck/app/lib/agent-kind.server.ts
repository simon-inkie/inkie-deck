/**
 * agent-kind.server.ts - which kind of starter agent a home is, if any.
 *
 * Source of truth is one single-line marker file, written by
 * packages/base/bin/create-agent.sh --kind (never by Deck):
 *
 *   <AGENTS_ROOT>/<agent>/.kind  - assistant | platform
 *
 * Same root resolution and degrade rule as agent-model.server.ts: a missing
 * AGENTS_ROOT, a missing or unreadable marker, or any other value is null,
 * meaning "no pin", never an error. The sidebar is then the same alphabetical
 * list it always was.
 *
 * ASCII only - no em-dashes.
 */

import fs from "node:fs";
import path from "node:path";
import { AGENT_NAME_RE } from "./safe-fs.server";
import { resolveAgentsRoot } from "./agent-model.server";

export type AgentKind = "assistant" | "platform";

export function readAgentKind(env: NodeJS.ProcessEnv, agent: string): AgentKind | null {
  if (!AGENT_NAME_RE.test(agent)) return null;
  try {
    const file = path.join(resolveAgentsRoot(env), agent, ".kind");
    const line = fs.readFileSync(file, "utf8").split("\n")[0]!.trim();
    return line === "assistant" || line === "platform" ? line : null;
  } catch {
    return null;
  }
}
