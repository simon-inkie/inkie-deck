// @vitest-environment jsdom
/**
 * compose-voice-single-session.test.tsx - one voice session at a time.
 *
 * The bug: the only guard in toggleMic was status === "active", which is set
 * after getUserMedia AND the socket open. Clicks while connecting each started
 * a new session, overwrote the refs, and orphaned the older ones; every live
 * socket then inserted every Deepgram final, so dictation repeated.
 *
 * getUserMedia, WebSocket and MediaRecorder are stubbed. Compose renders
 * inside createRoutesStub because it uses useFetcher.
 *
 * ASCII only: the dash gate rejects em-dashes and en-dashes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createRoutesStub } from "react-router";
import { Compose } from "~/components/Compose";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeWebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.CONNECTING;
  binaryType = "blob";
  closed = false;
  constructor(public url: string) {
    super();
    FakeWebSocket.instances.push(this);
  }
  send(): void {}
  close(): void {
    this.closed = true;
    this.readyState = FakeWebSocket.CLOSED;
  }
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }
  message(data: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) }));
  }
}

class FakeMediaRecorder extends EventTarget {
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported(): boolean {
    return true;
  }
  state: "inactive" | "recording" = "inactive";
  constructor() {
    super();
    FakeMediaRecorder.instances.push(this);
  }
  start(): void {
    this.state = "recording";
  }
  stop(): void {
    this.state = "inactive";
  }
}

type FakeStream = { stopped: boolean; getTracks: () => { stop: () => void }[] };
function fakeStream(): FakeStream {
  const s: FakeStream = {
    stopped: false,
    getTracks: () => [{ stop: () => { s.stopped = true; } }],
  };
  return s;
}

let container: HTMLDivElement;
let root: Root;
let streams: FakeStream[];
let pending: Array<() => void>;

beforeEach(() => {
  FakeWebSocket.instances = [];
  FakeMediaRecorder.instances = [];
  streams = [];
  pending = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  // getUserMedia resolves only when the test says so, so a click can land
  // while the permission prompt is still "open".
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: () =>
        new Promise((resolve) => {
          const s = fakeStream();
          streams.push(s);
          pending.push(() => resolve(s));
        }),
    },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const Stub = createRoutesStub([
    {
      path: "/",
      Component: () => (
        <Compose draftKey="quill" voiceProxyUrl="ws://localhost:5176/voice" />
      ),
    },
  ]);
  act(() => {
    root.render(<Stub initialEntries={["/"]} />);
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const mic = () => container.querySelector('[data-testid="mic-button"]') as HTMLButtonElement;
const textarea = () => container.querySelector("textarea") as HTMLTextAreaElement;

async function click(): Promise<void> {
  await act(async () => {
    mic().click();
  });
}

async function grantAll(): Promise<void> {
  await act(async () => {
    pending.splice(0).forEach((r) => r());
  });
}

describe("Compose voice: one session at a time", () => {
  it("two rapid clicks before the socket opens create exactly one socket", async () => {
    await click();
    await grantAll();
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(mic().getAttribute("aria-busy")).toBe("true");

    // Second click while still connecting: cancels, does not start another.
    await click();
    await grantAll();
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0]!.closed).toBe(true);
    expect(streams.every((s) => s.stopped)).toBe(true);
    expect(mic().getAttribute("aria-busy")).toBeNull();
  });

  it("a click during the permission prompt cancels without opening a socket", async () => {
    await click();
    await click();
    await grantAll();
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(streams).toHaveLength(1);
    expect(streams[0]!.stopped).toBe(true);
  });

  it("drops finals from a socket that is not the current session", async () => {
    // Session A: start then cancel while connecting.
    await click();
    await grantAll();
    const a = FakeWebSocket.instances[0]!;
    await click();

    // Session B: start and go live.
    await click();
    await grantAll();
    const b = FakeWebSocket.instances[1]!;
    await act(async () => b.open());
    expect(FakeMediaRecorder.instances).toHaveLength(1);

    // A stale socket's events must not reach the textarea or kill B.
    await act(async () => {
      a.open();
      a.message({ type: "final", text: "stale" });
      a.dispatchEvent(new Event("close"));
    });
    expect(textarea().value).toBe("");
    expect(FakeMediaRecorder.instances).toHaveLength(1);
    expect(mic().getAttribute("aria-label")).toBe("Stop voice recording");

    await act(async () => b.message({ type: "final", text: "hello" }));
    expect(textarea().value).toBe("hello");
  });
});
