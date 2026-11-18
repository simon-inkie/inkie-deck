// @vitest-environment jsdom
/**
 * sidebar-pinned.test.tsx - the assistant is pinned above the "Agents" label.
 *
 * Plus the .kind reader: a missing or unknown marker means no pin, never an
 * error. ASCII only - no em-dashes.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createRoutesStub } from "react-router";
import { Sidebar, type SidebarAgent } from "~/components/Sidebar";
import { readAgentKind } from "~/lib/agent-kind.server";

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

function render(agents: SidebarAgent[]): void {
  const Stub = createRoutesStub([{ path: "/", Component: () => <Sidebar agents={agents} /> }]);
  act(() => root.render(<Stub initialEntries={["/"]} />));
}

const agent = (name: string, over: Partial<SidebarAgent> = {}): SidebarAgent => ({
  name,
  preview: "hello",
  lastTimestamp: "2026-11-18T09:00:00Z",
  hasUnhandled: false,
  ...over,
});

/** Document order of the label and the agent names. */
const order = () =>
  Array.from(container.querySelectorAll("a, .label-mono")).map((n) =>
    n.tagName === "A" ? (n.getAttribute("href") ?? "").replace("/threads/", "") : "LABEL",
  );

describe("Sidebar pin", () => {
  it("renders a pinned assistant first, above the Agents label, whatever it sorts to", () => {
    render([agent("zed", { pinned: true }), agent("alpha"), agent("beta")]);
    expect(order()).toEqual(["zed", "LABEL", "alpha", "beta"]);
  });

  it("with nothing pinned, is the plain list under the label", () => {
    render([agent("alpha"), agent("beta")]);
    expect(order()).toEqual(["LABEL", "alpha", "beta"]);
  });
});

describe("readAgentKind", () => {
  it("reads assistant, and degrades to null for missing, unknown or unreadable", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kind-test-"));
    try {
      fs.mkdirSync(path.join(dir, "zed"));
      fs.writeFileSync(path.join(dir, "zed", ".kind"), "assistant");
      fs.mkdirSync(path.join(dir, "odd"));
      fs.writeFileSync(path.join(dir, "odd", ".kind"), "wizard");
      fs.mkdirSync(path.join(dir, "bare"));
      const env = { AGENTS_ROOT: dir } as NodeJS.ProcessEnv;
      expect(readAgentKind(env, "zed")).toBe("assistant");
      expect(readAgentKind(env, "odd")).toBeNull();
      expect(readAgentKind(env, "bare")).toBeNull();
      expect(readAgentKind(env, "../x")).toBeNull();
      expect(readAgentKind({ AGENTS_ROOT: path.join(dir, "nope") } as NodeJS.ProcessEnv, "zed")).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
