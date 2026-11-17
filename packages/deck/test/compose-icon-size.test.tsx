// @vitest-environment jsdom
/**
 * Compose control geometry after Button's Tailwind class merging.
 * These DOM assertions pin the fixed-pixel overrides and clearance; jsdom
 * does not prove rendered geometry at different root font sizes.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createRoutesStub } from "react-router";
import { Compose } from "~/components/Compose";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let mediaDevices: PropertyDescriptor | undefined;
let finishUpload: (() => void) | undefined;

beforeEach(() => {
  mediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: () => new Promise(() => {}) },
  });
  finishUpload = undefined;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => finishUpload?.());
  act(() => root.unmount());
  container.remove();
  if (mediaDevices) Object.defineProperty(navigator, "mediaDevices", mediaDevices);
  else Reflect.deleteProperty(navigator, "mediaDevices");
});

function render(disabled = false): void {
  const Stub = createRoutesStub([
    {
      path: "/",
      action: () => new Promise((resolve) => {
        finishUpload = () => resolve({ ok: true, attachments: [] });
      }),
      Component: () => (
        <Compose
          draftKey="quill"
          voiceProxyUrl="ws://localhost:5176/voice"
          voiceDisabledReason={disabled ? "Voice unavailable" : null}
        />
      ),
    },
  ]);
  act(() => root.render(<Stub initialEntries={["/"]} />));
}

const button = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement;

function expectPixelOverrides(): void {
  for (const id of ["attach-button", "mic-button"]) {
    const btn = button(id);
    const cls = btn.className.split(/\s+/);
    expect(cls).toContain("size-[36px]");
    expect(cls).toContain("[&_svg]:size-[20px]");
    expect(cls).not.toContain("h-9");
    expect(cls).not.toContain("w-9");
    expect(cls).not.toContain("[&_svg]:size-4");
    const glyph = btn.querySelector("svg")!;
    expect(glyph).not.toBeNull();
    expect(glyph.classList.contains("h-5")).toBe(false);
    expect(glyph.classList.contains("w-5")).toBe(false);
  }
  const group = container.querySelector('[data-testid="compose-controls"]') as HTMLElement;
  expect(group.className.split(/\s+/)).toEqual(
    expect.arrayContaining(["bottom-[6px]", "right-[6px]", "gap-[2px]"])
  );
  const ta = container.querySelector('[data-testid="compose-textarea"]') as HTMLTextAreaElement;
  expect(parseFloat(ta.style.paddingRight)).toBeGreaterThanOrEqual(84);
  expect(parseFloat(ta.style.paddingBottom)).toBeGreaterThanOrEqual(44);
  expect(ta.classList.contains("pr-[5rem]")).toBe(false);
  expect(ta.classList.contains("pb-10")).toBe(false);
}

describe("Compose attach and mic pixel overrides", () => {
  it.each([false, true])("retains overrides with voice disabled=%s", (disabled) => {
    render(disabled);
    expect(button("mic-button").disabled).toBe(disabled);
    expectPixelOverrides();
  });

  it("keeps the connecting spinner under the same glyph override", async () => {
    render();
    await act(async () => button("mic-button").click());
    expect(button("mic-button").getAttribute("aria-busy")).toBe("true");
    expect(button("mic-button").querySelector("svg")!.classList.contains("animate-spin")).toBe(true);
    expectPixelOverrides();
    await act(async () => button("mic-button").click());
    expect(button("mic-button").getAttribute("aria-busy")).toBeNull();
  });

  it("keeps upload pulse geometry and disables the draft while uploading", async () => {
    render();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [new File(["sample"], "sample.txt", { type: "text/plain" })] });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    expect(button("attach-button").disabled).toBe(true);
    expect(button("attach-button").getAttribute("aria-label")).toBe("Uploading...");
    expect(button("attach-button").querySelector("svg")!.classList.contains("animate-pulse")).toBe(true);
    expect((container.querySelector("textarea") as HTMLTextAreaElement).disabled).toBe(true);
    expectPixelOverrides();
  });
});
