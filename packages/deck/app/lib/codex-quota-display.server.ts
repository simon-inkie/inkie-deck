import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { FileCodexQuotaStore } from "./codex-quota-store.server";
import {
  ensureCodexQuotaObserver,
  codexQuotaTelemetryEnabled,
} from "./codex-quota-observer.server";
import {
  buildCodexQuotaDisplay,
  type CodexProvider,
  type CodexQuotaDisplayData,
} from "./codex-quota-display";
import { AGENT_NAME_RE, confineToRootReal } from "./safe-fs.server";

type Env = Record<string, string | undefined>;

export const DEFAULT_CODEX_QUOTA_STALE_MS = 15 * 60_000;

const ProviderStateSchema = z.object({
  version: z.literal(1).optional(),
  schema_version: z.literal(1).optional(),
  agent: z.string().regex(AGENT_NAME_RE),
  provider: z.enum(["plus", "azure"]),
  observedAt: z.number().optional(),
  updated_at: z.number().optional(),
  operationId: z.string().min(1).optional(),
  transaction_id: z.string().min(1).optional(),
});

function staleAfterMs(env: Env): number {
  const parsed = Number(env["MC_CODEX_QUOTA_STALE_MS"]);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_CODEX_QUOTA_STALE_MS;
}

function readProvider(dataRoot: string, agent: string): CodexProvider {
  if (!AGENT_NAME_RE.test(agent)) return "unknown";
  try {
    const rootReal = fs.realpathSync(dataRoot);
    const candidatePaths = [
      path.join(dataRoot, "provider-switch", "current", `${agent}.json`),
      path.join(dataRoot, agent, "provider-switch", "provider.json"),
    ];
    for (const cand of candidatePaths) {
      if (!fs.existsSync(cand)) continue;
      const file = confineToRootReal(cand, rootReal, {
        forWrite: false,
        label: "data",
      });
      const parsed = ProviderStateSchema.safeParse(
        JSON.parse(fs.readFileSync(file, "utf8"))
      );
      if (parsed.success && parsed.data.agent === agent) {
        return parsed.data.provider;
      }
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}

function resolveDisplayDataRoot(env: Env): string | null {
  const configured = env["DATA_ROOT"]?.trim();
  return configured !== undefined && configured !== "" && path.isAbsolute(configured)
    ? configured
    : null;
}

export function loadCodexQuotaDisplay(
  env: Env,
  now: number,
  agents: string[]
): CodexQuotaDisplayData {
  if (codexQuotaTelemetryEnabled(env)) {
    ensureCodexQuotaObserver({ env });
  }
  const dataRoot = resolveDisplayDataRoot(env);
  if (dataRoot === null) {
    return {
      quota: buildCodexQuotaDisplay(
        { kind: "missing" },
        now,
        staleAfterMs(env)
      ),
      providers: Object.fromEntries(
        agents.map((agent) => [agent, "unknown" as const])
      ),
    };
  }
  const store = new FileCodexQuotaStore(
    path.join(dataRoot, "codex-quota.json"),
    dataRoot
  );
  const providers: Record<string, CodexProvider> = {};
  for (const agent of agents) providers[agent] = readProvider(dataRoot, agent);
  return {
    quota: buildCodexQuotaDisplay(store.loadResult(), now, staleAfterMs(env)),
    providers,
  };
}
