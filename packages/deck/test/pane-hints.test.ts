import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyPaneHint } from "~/lib/pane-hints";
import panes from "./fixtures/panes/first-run.json";

describe("classifyPaneHint", () => {
  it.each([
    [panes.trust, "H1"],
    [panes.login, "H2"],
    [panes.keyApproval, "H3"],
    [panes.resume, "H4"],
    [panes.fullscreen, "H4"],
    [panes.theme, "H4"],
    [panes.shell, "H5"],
    [panes.busy, null],
    [panes.idle, null],
    [panes.unknown, null],
  ])("classifies %j as %s", (capture, hint) => {
    expect(classifyPaneHint(capture)).toBe(hint);
  });

  it("agrees with the base numbered trust fixture", () => {
    const testSource = readFileSync(new URL("../../base/test/boot-agents.test.sh", import.meta.url), "utf8");
    const trust = /trust\|existing\) printf "([^"]+)"/.exec(testSource)?.[1];
    expect(trust?.replaceAll("\\n", "\n")).toBe(panes.trust);
    expect(classifyPaneHint(panes.trust)).toBe("H1");
  });

  it.each([
    `${panes.trust}${panes.idle}`,
    `${panes.trust}Thinking (esc to interrupt)\n`,
    `${panes.trust}${panes.shell}More output\n`,
    `${panes.trust}${panes.busy.repeat(16)}`,
    "Quick safety check before deployment\n\u276f 1. Continue\n",
    "Quick safety check\n\nChoose a deployment target\n\u276f 1. Preview\n",
    `Do you trust the files in this folder?\n${panes.unknown}`,
    `${panes.trust}${panes.unknown}`,
    "We discussed: Do you trust the files in this folder?\n\u276f 1. Yes\n",
    "Do you trust the files in this folder?\n  1. Yes\n  2. No\n",
    "Quick safety check\n\u276f Yes, I trust this folder\nEnter to confirm\n",
    "Quick safety check\n\u276f Yes, I trust this folder\n\u276f 1. Preview\nEnter to confirm\n",
    "Quick safety check\n\u276f Yes, I trust this folder\nEnter to confirm\n\u276f 1. Preview\nEnter to confirm\n",
    "Deploy report for user@example: 100%\n",
    "Previous shell prompt: user@example:~/agent$\n",
    "Run /login to continue\n",
    "Invalid API key. Please run /login\n",
    "\u276f 1. Yes, I trust this folder\n",
  ])("does not classify %j as a live dialog", (capture) => {
    expect(classifyPaneHint(capture)).toBeNull();
  });

  it("uses the current shell, not the old dialog above it", () => {
    expect(classifyPaneHint(`${panes.trust}${panes.shell}`)).toBe("H5");
  });

  it("only classifies the current dialog when known menus are concatenated", () => {
    expect(classifyPaneHint(`${panes.login}${panes.trust}`)).toBe("H1");
    expect(classifyPaneHint(`${panes.trust}${panes.login}`)).toBe("H2");
  });
});
