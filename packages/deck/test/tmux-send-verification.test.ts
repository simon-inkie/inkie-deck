import { describe, expect, it } from "vitest";
import {
  buildPanePayload,
  classifyPaneSnapshot,
  pushMessageToIdleAgent,
  sendKeysToWindow,
  type SendKeysDriver,
} from "~/lib/tmux.server";
import { composerHoldsPayload } from "~/lib/tmux-submit";

type Capture = { plain: string | undefined; raw?: string | undefined };

function fakeDriver(
  captures: Capture[],
  options: { sendText?: boolean; enter?: boolean[] } = {}
): SendKeysDriver & { actions: string[] } {
  const queue = [...captures];
  const enterResults = [...(options.enter ?? [])];
  let current: Capture | undefined;
  const actions: string[] = [];
  return {
    actions,
    listWindows: () => ["agent-a"],
    captureViewport: (_session, _window, raw) => {
      actions.push(raw ? "capture-raw" : "capture-plain");
      if (!raw) {
        current = queue.shift();
        return current?.plain;
      }
      const result = current?.raw ?? current?.plain;
      current = undefined;
      return result;
    },
    sendText: () => {
      actions.push("send-text");
      return options.sendText ?? true;
    },
    pressEnter: () => {
      actions.push("enter");
      return enterResults.shift() ?? true;
    },
    wait: async () => {
      actions.push("wait");
    },
  };
}

const clean = { plain: "transcript\n❯ \nstatus" };
const staged = (text: string): Capture => ({ plain: `transcript\n❯ ${text}\nstatus` });
const claudeFramedStaged = (text: string, width = 132): Capture => {
  const contentWidth = width - 2;
  const rows = text.split("\n").flatMap((logicalLine) => {
    if (logicalLine === "") return [""];
    const chunks: string[] = [];
    for (let offset = 0; offset < logicalLine.length; offset += contentWidth) {
      chunks.push(logicalLine.slice(offset, offset + contentWidth));
    }
    return chunks;
  });
  const [first = "", ...continuation] = rows;
  return {
    plain: [
      "transcript",
      `❯\u00a0${first}`.padEnd(width, " "),
      ...continuation.map((line) => `  ${line}`.padEnd(width, " ")),
      "─".repeat(width),
      "status",
    ].join("\n"),
  };
};
const active = (text: string): Capture => ({
  plain: `Working... (2s · 10 tokens)\n❯ ${text}\nstatus`,
});

function snapshotHoldsPayload(capture: Capture, payload: string): boolean {
  const snapshot = classifyPaneSnapshot(capture.plain ?? "");
  return composerHoldsPayload(
    snapshot.stagedText ?? "",
    payload,
    snapshot.stagedRows
  );
}

describe("sendKeysToWindow verified submission", () => {
  it("retries one swallowed Enter only while its own payload remains idle", async () => {
    const driver = fakeDriver([
      clean,
      staged("hello"),
      staged("hello"),
      staged("hello"),
      clean,
    ]);

    await expect(sendKeysToWindow({}, "agent-a", "hello", driver)).resolves.toEqual({
      status: "submitted",
      evidence: "composer-cleared",
      enterAttempts: 2,
    });
    expect(driver.actions.filter((action) => action === "send-text")).toHaveLength(1);
    expect(driver.actions.filter((action) => action === "enter")).toHaveLength(2);
    expect(driver.actions).not.toContain("clear");
  });

  it("observes delayed submission before retry and never duplicates Enter", async () => {
    const driver = fakeDriver([clean, staged("hello"), clean]);

    const result = await sendKeysToWindow({}, "agent-a", "hello", driver);

    expect(result).toMatchObject({ status: "submitted", enterAttempts: 1 });
    expect(driver.actions.filter((action) => action === "enter")).toHaveLength(1);
  });

  it("does not touch an existing real composer entry", async () => {
    const driver = fakeDriver([staged("a previously staged message")]);

    await expect(sendKeysToWindow({}, "agent-a", "hello", driver)).resolves.toMatchObject({
      status: "not-attempted",
      reason: "unsafe-composer",
      enterAttempts: 0,
    });
    expect(driver.actions).not.toContain("send-text");
    expect(driver.actions).not.toContain("enter");
  });

  it("accepts a dim Codex hint as ghost but rejects the same non-dim text", async () => {
    const plain = "transcript\n› Implement {feature}\nstatus";
    const raw = "transcript\n\x1b[1m›\x1b[0m \x1b[2mImplement {feature}\x1b[0m\nstatus";
    expect(classifyPaneSnapshot(plain, raw).composer).toBe("ghost");
    expect(classifyPaneSnapshot(plain, plain).composer).toBe("staged");

    const ghostDriver = fakeDriver([{ plain, raw }, clean]);
    expect((await sendKeysToWindow({}, "agent-a", "hello", ghostDriver)).status).toBe(
      "submitted"
    );

    const realDriver = fakeDriver([{ plain, raw: plain }]);
    expect((await sendKeysToWindow({}, "agent-a", "hello", realDriver)).status).toBe(
      "not-attempted"
    );
    expect(realDriver.actions).not.toContain("send-text");
  });

  it("stops after one safe retry when the owned payload remains staged", async () => {
    const driver = fakeDriver([
      clean,
      staged("hello"),
      staged("hello"),
      staged("hello"),
      staged("hello"),
      staged("hello"),
    ]);

    await expect(sendKeysToWindow({}, "agent-a", "hello", driver)).resolves.toMatchObject({
      status: "not-submitted",
      reason: "retry-exhausted",
      enterAttempts: 2,
    });
    expect(driver.actions.filter((action) => action === "enter")).toHaveLength(2);
    expect(driver.actions.filter((action) => action === "send-text")).toHaveLength(1);
  });

  it("stops after the first confirmed working transition with no staged composer", async () => {
    const driver = fakeDriver([clean, { plain: "Working... (2s · 10 tokens)" }]);

    await expect(sendKeysToWindow({}, "agent-a", "hello", driver)).resolves.toEqual({
      status: "submitted",
      evidence: "turn-started",
      enterAttempts: 1,
    });
    expect(driver.actions.filter((action) => action === "enter")).toHaveLength(1);
  });

  it("does not treat a busy pane still holding the payload as submitted", async () => {
    const busyDriver = fakeDriver([clean, active("hello")]);
    const busyBaselineDriver = fakeDriver([
      { plain: "Working... (2s · 10 tokens)\n❯ \nstatus" },
      active("hello"),
    ]);
    const changedDriver = fakeDriver([clean, staged("someone else's text")]);

    await expect(sendKeysToWindow({}, "agent-a", "hello", busyDriver)).resolves.toMatchObject({
      status: "not-attempted",
      reason: "busy-queue-pending",
    });
    await expect(
      sendKeysToWindow({}, "agent-a", "hello", busyBaselineDriver)
    ).resolves.toMatchObject({
      status: "not-attempted",
      reason: "busy-queue-pending",
    });
    await expect(
      sendKeysToWindow({}, "agent-a", "hello", changedDriver)
    ).resolves.toMatchObject({ status: "not-attempted", reason: "composer-changed" });
    expect(busyBaselineDriver.actions.filter((action) => action === "enter")).toHaveLength(1);
    expect(changedDriver.actions.filter((action) => action === "enter")).toHaveLength(1);
  });

  it.each(["please wait (45s before continuing", "quoted esc to interrupt text"])(
    "does not let payload-contained activity text prove submission: %s",
    async (payload) => {
      const driver = fakeDriver([
        clean,
        claudeFramedStaged(payload),
        claudeFramedStaged(payload),
        claudeFramedStaged(payload),
        clean,
      ]);
      await expect(sendKeysToWindow({}, "agent-a", payload, driver)).resolves.toMatchObject({
        status: "submitted",
        enterAttempts: 2,
      });
      expect(driver.actions.filter((action) => action === "enter")).toHaveLength(2);
    }
  );

  it("exhausts safely when payload-contained activity text remains staged", async () => {
    const payload = "the pane says esc to interrupt and (45s while still staged";
    const driver = fakeDriver([
      clean,
      claudeFramedStaged(payload),
      claudeFramedStaged(payload),
      claudeFramedStaged(payload),
      claudeFramedStaged(payload),
      claudeFramedStaged(payload),
    ]);
    await expect(sendKeysToWindow({}, "agent-a", payload, driver)).resolves.toMatchObject({
      status: "not-submitted",
      reason: "retry-exhausted",
      enterAttempts: 2,
    });
  });

  it("captures and retries an exact wrapped 1,024-character payload", async () => {
    const payload = ["a".repeat(340), "b".repeat(340), "c".repeat(342)].join("\n");
    expect(payload).toHaveLength(1024);
    expect(snapshotHoldsPayload(claudeFramedStaged(payload), payload)).toBe(true);
    const driver = fakeDriver([
      clean,
      claudeFramedStaged(payload),
      claudeFramedStaged(payload),
      claudeFramedStaged(payload),
      clean,
    ]);
    await expect(sendKeysToWindow({}, "agent-a", payload, driver)).resolves.toMatchObject({
      status: "submitted",
      enterAttempts: 2,
    });
  });

  it("requires exact multiline identity and refuses near matches", async () => {
    const payload = "first line\nsecond  line";
    expect(composerHoldsPayload(payload, payload)).toBe(true);
    expect(composerHoldsPayload("first line\nsecond line", payload)).toBe(false);
    const driver = fakeDriver([
      clean,
      claudeFramedStaged("first line\nsecond line"),
    ]);
    await expect(sendKeysToWindow({}, "agent-a", payload, driver)).resolves.toMatchObject({
      status: "not-attempted",
      reason: "composer-changed",
      enterAttempts: 1,
    });
    expect(driver.actions.filter((action) => action === "enter")).toHaveLength(1);
  });

  it("preserves a leading empty line in a framed multiline composer", () => {
    const payload = "\nsecond line";
    const capture = claudeFramedStaged(payload);
    expect(classifyPaneSnapshot(capture.plain ?? "")).toMatchObject({
      activity: "idle",
      composer: "staged",
    });
    expect(snapshotHoldsPayload(capture, payload)).toBe(true);
  });

  it("classifies a real padded Claude idle capture as clean", () => {
    const viewport = [
      "✻ Cooked for 2s",
      `❯\u00a0${" ".repeat(92)}`,
      "─".repeat(94),
      "  agent-a │ Opus",
    ].join("\n");
    expect(classifyPaneSnapshot(viewport)).toEqual({
      activity: "idle",
      composer: "clean",
    });
  });

  it("matches the exact 1,024-byte prose from the scratch word-wrap capture", () => {
    const base =
      "Amber lanterns rest beside quiet windows while rain traces silver lines across the courtyard and distant clocks mark an ordinary evening. ";
    const payload = base.repeat(Math.ceil(1024 / base.length)).slice(0, 1024);
    const capturedRows = [
      `❯\u00a0Amber lanterns rest beside quiet windows while rain traces silver lines across the courtyard and distant clocks mark an ordinary${" ".repeat(2)}`,
      `  evening. Amber lanterns rest beside quiet windows while rain traces silver lines across the courtyard and distant clocks mark${" ".repeat(5)}`,
      `  an ordinary evening. Amber lanterns rest beside quiet windows while rain traces silver lines across the courtyard and distant${" ".repeat(5)}`,
      `  clocks mark an ordinary evening. Amber lanterns rest beside quiet windows while rain traces silver lines across the courtyard${" ".repeat(5)}`,
      `  and distant clocks mark an ordinary evening. Amber lanterns rest beside quiet windows while rain traces silver lines across the${" ".repeat(3)}`,
      `  courtyard and distant clocks mark an ordinary evening. Amber lanterns rest beside quiet windows while rain traces silver lines${" ".repeat(4)}`,
      `  across the courtyard and distant clocks mark an ordinary evening. Amber lanterns rest beside quiet windows while rain traces${" ".repeat(6)}`,
      `  silver lines across the courtyard and distant clocks mark an ordinary evening. Amber lanterns rest beside quiet windows while${" ".repeat(5)}`,
      `  rain traces${" ".repeat(117)}`,
    ];
    const capture = {
      plain: ["transcript", ...capturedRows, "─".repeat(132), "status"].join("\n"),
    };
    expect(payload).toHaveLength(1024);
    expect(snapshotHoldsPayload(capture, payload)).toBe(true);
    expect(snapshotHoldsPayload(capture, `${payload.slice(0, -1)}X`)).toBe(false);
  });

  it("does not treat a collapsed paste count as exact identity", () => {
    const payload = `${"x".repeat(1024)} unique visible suffix from this payload`;
    expect(composerHoldsPayload("[Pasted Content 1024 chars]", payload)).toBe(false);
    expect(composerHoldsPayload("[Pasted text #1]", payload)).toBe(false);
    expect(
      composerHoldsPayload(
        "[Pasted Content 1024 chars] completely unrelated visible suffix here",
        payload
      )
    ).toBe(false);
  });
});

describe("pushMessageToIdleAgent tri-state propagation", () => {
  it("surfaces submitted, not-attempted and not-submitted without booleans", async () => {
    const panePayload = buildPanePayload("operator", "hello", 5, false);
    const submitted = fakeDriver([clean, clean]);
    const notAttempted = fakeDriver([staged("real draft")]);
    const notSubmitted = fakeDriver([clean], { sendText: false });

    expect(
      (await pushMessageToIdleAgent({}, "agent-a", "operator", "hello", false, submitted)).status
    ).toBe("submitted");
    expect(
      (await pushMessageToIdleAgent({}, "agent-a", "operator", "hello", false, notAttempted))
        .status
    ).toBe("not-attempted");
    expect(
      (await pushMessageToIdleAgent({}, "agent-a", "operator", "hello", false, notSubmitted))
        .status
    ).toBe("not-submitted");
    expect(panePayload).toContain("[inbox from operator] hello");
  });
});
