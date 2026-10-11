// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createRoutesStub } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CodexQuotaPanel,
  ProviderBadge,
} from "~/components/CodexQuotaStatus";
import type { CodexQuotaView } from "~/lib/codex-quota-display";
import { AppShell } from "~/components/AppShell";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(node: React.ReactNode): void {
  act(() => root.render(node));
}

const view: CodexQuotaView = {
  freshness: "fresh",
  status: "AVAILABLE_CONFIRMED",
  available: true,
  blocked: false,
  warning: null,
  observedAt: "2026-09-16T07:59:00.000Z",
  windows: [
    { key: "primary", label: "5-hour", usedPercent: 42, resetAt: "2026-09-16T08:30:00.000Z" },
    { key: "secondary", label: "7-day", usedPercent: 71, resetAt: null },
  ],
};

describe("CodexQuotaPanel", () => {
  it("renders labelled accessible utilisation bars and reset timing", () => {
    render(<CodexQuotaPanel quota={view} />);
    const bars = container.querySelectorAll('[role="progressbar"]');
    expect(bars).toHaveLength(2);
    expect(bars[0]!.getAttribute("aria-label")).toBe("5-hour quota used");
    expect(bars[0]!.getAttribute("aria-valuenow")).toBe("42");
    expect(container.textContent).toContain("42%");
    expect(container.textContent).toContain("7-day");
    expect(container.querySelector("time")?.getAttribute("datetime")).toBe(
      "2026-09-16T08:30:00.000Z"
    );
  });

  it("shows a clear blocked spend-control warning", () => {
    render(
      <CodexQuotaPanel
        quota={{ ...view, available: false, blocked: true, warning: "Spend control reached." }}
      />
    );
    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain("Spend control reached");
  });

  it.each([
    ["missing", "Quota data unavailable"],
    ["malformed", "Quota data invalid"],
    ["stale", "Quota data stale"],
  ] as const)("renders the %s state honestly", (freshness, copy) => {
    render(
      <CodexQuotaPanel
        quota={{ ...view, freshness, available: false, windows: freshness === "stale" ? view.windows : [] }}
      />
    );
    expect(container.textContent).toContain(copy);
  });

  it("states protocol UNKNOWN without presenting it as available", () => {
    render(<CodexQuotaPanel quota={{ ...view, status: "UNKNOWN", available: false }} />);
    expect(container.textContent).toContain("Quota status unknown");
    expect(container.textContent).not.toContain("Available");
  });
});

describe("ProviderBadge", () => {
  it.each([
    ["azure", "Provider Azure"],
    ["plus", "Provider Plus"],
    ["unknown", "Provider Unknown"],
  ] as const)("renders %s as explicit visible text", (provider, label) => {
    render(<ProviderBadge provider={provider} />);
    expect(container.textContent).toBe(label);
  });
});

describe("AppShell Codex status wiring", () => {
  it("shows the active agent's authoritative provider and the read-only quota trigger", () => {
    const Stub = createRoutesStub([
      {
        path: "/threads/:agent",
        Component: () => (
          <AppShell
            agents={[
              {
                name: "alex",
                preview: "Ready",
                lastTimestamp: "2026-09-16T08:00:00Z",
                hasUnhandled: false,
              },
            ]}
            needsItems={[]}
            needsCount={0}
            workCards={[]}
            codexQuota={{ quota: view, providers: { alex: "azure" } }}
          />
        ),
      },
    ]);
    render(<Stub initialEntries={["/threads/alex"]} />);
    expect(container.querySelector('[data-testid="codex-provider-badge"]')?.textContent).toBe(
      "Provider Azure"
    );
    expect(container.querySelector('[data-testid="codex-quota-trigger"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="codex-quota-trigger"]')?.tagName).toBe(
      "BUTTON"
    );
  });

  it("shows Provider Unknown when no authoritative record exists", () => {
    const Stub = createRoutesStub([
      {
        path: "/threads/:agent",
        Component: () => (
          <AppShell
            agents={[]}
            needsItems={[]}
            needsCount={0}
            workCards={[]}
            codexQuota={{ quota: view, providers: {} }}
          />
        ),
      },
    ]);
    render(<Stub initialEntries={["/threads/alex"]} />);
    expect(container.querySelector('[data-testid="codex-provider-badge"]')?.textContent).toBe(
      "Provider Unknown"
    );
  });
});
