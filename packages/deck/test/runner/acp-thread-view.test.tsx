// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { AcpThreadView } from "../../app/components/AcpThreadView.js";

it("refreshes quota while a stopped ACP thread is open", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const status = { state: "stopped" as const };
  const usageReading = { state: "unknown" as const, source: "codex", readAt: "2026-11-25T10:00:00Z" };
  const fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({ ok: true, status, usageReading: { ...usageReading, state: "ok" } }),
  }));
  vi.stubGlobal("fetch", fetch);
  const container = document.createElement("div");
  const root = createRoot(container);

  try {
    act(() => root.render(<AcpThreadView agent="fixture-agent" initialStatus={status}
      initialEvents={[]} initialLastSessionId={null} initialUsageReading={usageReading} canWrite />));
    expect(container.textContent).toContain("Quota (codex): unknown");
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(fetch).toHaveBeenCalledWith("/api/acp?agent=fixture-agent");
    expect(container.textContent).toContain("Quota (codex): ok");
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});
