// @vitest-environment jsdom
/**
 * compose-voice-disabled.test.tsx - the mic's disabled state (issue #27).
 *
 * Compose uses useFetcher, so it renders inside createRoutesStub, as the other
 * component tests here do.
 *
 * ASCII only - no em-dashes (FND-05).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createRoutesStub } from "react-router";
import { Compose } from "~/components/Compose";

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

function render(reason: string | null | undefined): void {
  const Stub = createRoutesStub([
    {
      path: "/",
      Component: () => (
        <Compose
          draftKey="quill"
          voiceProxyUrl="ws://localhost:5176/voice"
          voiceDisabledReason={reason}
        />
      ),
    },
  ]);
  act(() => {
    root.render(<Stub initialEntries={["/"]} />);
  });
}

function el(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

describe("Compose mic with no speech key", () => {
  it("disables the mic and says why", () => {
    render("voice disabled: no DEEPGRAM_API_KEY");
    const mic = el("mic-button") as HTMLButtonElement;
    expect(mic.disabled).toBe(true);
    expect(mic.getAttribute("aria-label")).toBe("voice disabled: no DEEPGRAM_API_KEY");
    expect(mic.title).toBe("voice disabled: no DEEPGRAM_API_KEY");
    expect(el("voice-disabled-note")?.textContent).toBe(
      "voice disabled: no DEEPGRAM_API_KEY"
    );
  });

  it("keeps the note out of the box that holds the textarea and the mic", () => {
    render("voice disabled: no DEEPGRAM_API_KEY");
    const note = el("voice-disabled-note")!;
    const textarea = container.querySelector("textarea")!;
    expect(textarea.parentElement?.contains(note)).toBe(false);
  });

  it("leaves the mic enabled and shows no note when voice is on", () => {
    render(null);
    expect((el("mic-button") as HTMLButtonElement).disabled).toBe(false);
    expect(el("voice-disabled-note")).toBeNull();
  });
});
