import { buildAcpSessionEnv } from "./acp-session.server";
import { loadCodexQuotaDisplay } from "./codex-quota-display.server";
import { codexQuotaContext, codexQuotaTelemetryEnabled, observerQuotaContext } from "./codex-quota-observer.server";
import { codexUsageReading } from "./codex-quota-usage";
import { acpRunnerEnabled } from "./instance.server";
import { antigravityUsageReading, resolveAcpManifestForAgent, type AcpAdapterManifest, type UsageReading } from "./runner/acp-manifest";
import { resolveAcpAgentHome } from "./runner/acp-manifest.server";

export function unknownUsageReading(now = Date.now()): UsageReading {
  return {
    state: "unknown",
    source: "unknown",
    readAt: new Date(now).toISOString(),
  };
}

export function acpQuotaContext(manifest: AcpAdapterManifest, env: NodeJS.ProcessEnv, home: string): string | undefined {
  if (manifest.usageKind !== "codex") return undefined;
  const adapter = { environment: manifest.envAllowlist, envDefaults: manifest.envDefaults };
  return codexQuotaContext(buildAcpSessionEnv(adapter, env), home);
}

/** Read usage at the server seam, without exposing filesystem roots to routes. */
export function readAcpUsageReading(
  env: NodeJS.ProcessEnv,
  agent: string,
  now = Date.now(),
  active?: { manifest: AcpAdapterManifest; codexQuotaContext?: string },
): UsageReading {
  if (!acpRunnerEnabled(env)) {
    return unknownUsageReading(now);
  }
  const manifest = active?.manifest ?? resolveAcpManifestForAgent(env, agent);
  if (!manifest) {
    return unknownUsageReading(now);
  }
  if (manifest.usageKind !== "codex") {
    return antigravityUsageReading(() => new Date(now).toISOString());
  }
  const enabled = codexQuotaTelemetryEnabled(env);
  let context = active?.codexQuotaContext;
  if (enabled && !active) {
    const home = resolveAcpAgentHome(env, agent);
    if (home) context = acpQuotaContext(manifest, env, home);
  }
  const display = loadCodexQuotaDisplay(env, now, [agent], {
    context: enabled && context && context === observerQuotaContext(env) ? context : undefined,
  });
  return codexUsageReading(display, agent, now);
}
