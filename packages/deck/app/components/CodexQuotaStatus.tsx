import { AlertTriangle } from "lucide-react";
import type {
  CodexProvider,
  CodexQuotaView,
  QuotaWindowView,
} from "~/lib/codex-quota-display";
import { cn } from "~/lib/utils";

const PROVIDER_LABEL: Record<CodexProvider, string> = {
  azure: "Azure",
  plus: "Plus",
  unknown: "Unknown",
};

export function ProviderBadge({ provider }: { provider: CodexProvider }) {
  return (
    <span
      data-testid="codex-provider-badge"
      className={cn(
        "label-mono shrink-0 rounded-full border px-2 py-1 text-[10px]",
        provider === "azure" && "border-primary/40 bg-primary/10 text-primary",
        provider === "plus" && "border-accent/40 bg-accent/10 text-foreground",
        provider === "unknown" && "border-border bg-muted text-muted-foreground"
      )}
    >
      Provider {PROVIDER_LABEL[provider]}
    </span>
  );
}

function ResetTime({ value }: { value: string }) {
  return (
    <time dateTime={value} className="text-[10px] text-muted-foreground">
      resets {new Date(value).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" })}
    </time>
  );
}

function QuotaBar({ window }: { window: QuotaWindowView }) {
  return (
    <div className="space-y-1" data-testid={`codex-quota-${window.key}`}>
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="font-medium text-foreground">{window.label}</span>
        <span className="font-mono text-muted-foreground">{window.usedPercent}%</span>
      </div>
      <div
        role="progressbar"
        aria-label={`${window.label} quota used`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={window.usedPercent}
        className="h-2 overflow-hidden rounded-full bg-muted"
      >
        <div
          aria-hidden="true"
          className={cn(
            "h-full rounded-full",
            window.usedPercent >= 90 ? "bg-destructive" : "bg-primary"
          )}
          style={{ width: `${window.usedPercent}%` }}
        />
      </div>
      {window.resetAt !== null ? <ResetTime value={window.resetAt} /> : null}
    </div>
  );
}

export function CodexQuotaPanel({ quota }: { quota: CodexQuotaView }) {
  const stateCopy =
    quota.freshness === "missing"
      ? "Quota data unavailable"
      : quota.freshness === "malformed"
        ? "Quota data invalid"
        : quota.freshness === "stale"
          ? "Quota data stale"
          : quota.status === "UNKNOWN"
            ? "Quota status unknown"
            : quota.available
              ? "Available"
              : "Quota state pending";

  return (
    <section aria-label="Codex quota" className="w-72 space-y-3 p-1">
      <div className="flex items-center justify-between gap-2">
        <span className="label-mono text-muted-foreground">ChatGPT Plus quota</span>
        <span className="text-xs font-medium text-foreground">{stateCopy}</span>
      </div>
      {quota.warning !== null ? (
        <div role="alert" className="flex items-start gap-2 rounded-md bg-destructive/10 p-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{quota.warning}</span>
        </div>
      ) : null}
      {quota.windows.map((window) => (
        <QuotaBar key={window.key} window={window} />
      ))}
      {quota.observedAt !== null ? (
        <p className="text-[10px] text-muted-foreground">
          Observed <time dateTime={quota.observedAt}>{new Date(quota.observedAt).toLocaleString("en-GB")}</time>
        </p>
      ) : null}
    </section>
  );
}
