import { loadCodexQuotaDisplay } from "./codex-quota-display.server";
import { codexQuotaTelemetryEnabled } from "./codex-quota-observer.server";
import { codexUsageReading } from "./codex-quota-usage";
import { acpRunnerEnabled } from "./instance.server";
import { antigravityUsageReading, resolveAcpManifestForAgent, type AcpAdapterManifest, type UsageReading } from "./runner/acp-manifest";

export function unknownUsageReading(now = Date.now()): UsageReading {
  return {
    state: "unknown",
    source: "unknown",
    readAt: new Date(now).toISOString(),
  };
}

/** Read usage at the server seam, without exposing filesystem roots to routes. */
export function readAcpUsageReading(
  env: NodeJS.ProcessEnv,
  agent: string,
  now = Date.now(),
  activeManifest?: AcpAdapterManifest,
): UsageReading {
  if (!acpRunnerEnabled(env)) {
    return unknownUsageReading(now);
  }
  const manifest = activeManifest ?? resolveAcpManifestForAgent(env, agent);
  if (!manifest) {
    return unknownUsageReading(now);
  }
  if (manifest.usageKind !== "codex") {
    return antigravityUsageReading(() => new Date(now).toISOString());
  }
  const display = loadCodexQuotaDisplay(env, now, [agent]);
  if (!codexQuotaTelemetryEnabled(env)) {
    return { state: "unknown", source: display.providers[agent] === "azure" ? "codex-azure" : "codex", readAt: new Date(now).toISOString() };
  }
  return codexUsageReading(display, agent, now);
}
