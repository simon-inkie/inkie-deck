/**
 * Table-driven tests over the domain layer's state transitions and terminal
 * states. Pure values in, pure values out: no filesystem, no subprocess, no
 * real clock anywhere in this file.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  appendToThread,
  completeAction,
  dismissAction,
  draftMessage,
  markMessageRead,
  markThreadRead,
  openAction,
  openDecision,
  openThread,
  resolveDecision,
  supersedeAction,
  unreadMessages,
  workspaceCapability,
  type Action,
  type Decision,
  type TransitionRefusal,
  type Workspace,
} from "../src/domain/index.ts";
import { EPOCH, fixedClock, makeMessage, odile, pharos, quill, sequenceClock } from "./fixtures.ts";

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// ---------------------------------------------------------------------------
// Message delivery
// ---------------------------------------------------------------------------
describe("message delivery transitions", () => {
  it("drafts a message as sent, stamped from the injected clock", () => {
    const message = draftMessage(fixedClock("2031-03-07T09:15:00Z"), {
      sender: quill.id,
      subject: "paint order",
      body: "Two tins of bilge paint arrive Thursday.",
    });
    expect(message.delivery).toBe("sent");
    expect(message.payload.sentAt).toBe("2031-03-07T09:15:00Z");
  });

  interface MarkReadCase {
    name: string;
    delivery: "sent" | "read";
    sender: string;
    onBehalfOf: string;
    expected: { ok: true; delivery: "read" } | { ok: false; refusal: TransitionRefusal };
  }

  const markReadTable: MarkReadCase[] = [
    {
      name: "the recipient renders a sent message: sent becomes read",
      delivery: "sent",
      sender: quill.id,
      onBehalfOf: odile.id,
      expected: { ok: true, delivery: "read" },
    },
    {
      name: "read is terminal: rendering again changes nothing",
      delivery: "read",
      sender: quill.id,
      onBehalfOf: odile.id,
      expected: { ok: false, refusal: "message-already-read" },
    },
    {
      name: "a participant never marks its own outbound message read",
      delivery: "sent",
      sender: odile.id,
      onBehalfOf: odile.id,
      expected: { ok: false, refusal: "recipient-is-sender" },
    },
    {
      name: "own-message refusal wins even when the message is already read",
      delivery: "read",
      sender: odile.id,
      onBehalfOf: odile.id,
      expected: { ok: false, refusal: "recipient-is-sender" },
    },
    {
      name: "an unavailable remote participant can still be the reader",
      delivery: "sent",
      sender: odile.id,
      onBehalfOf: pharos.id,
      expected: { ok: true, delivery: "read" },
    },
  ];

  for (const row of markReadTable) {
    it(row.name, () => {
      const message = makeMessage({ sender: row.sender, delivery: row.delivery });
      const result = markMessageRead(message, row.onBehalfOf);
      if (row.expected.ok) {
        expect(result.ok, JSON.stringify(result)).toBe(true);
        if (result.ok) {
          expect(result.value.delivery).toBe(row.expected.delivery);
          // The payload is immutable: only delivery state moved.
          expect(result.value.payload).toEqual(message.payload);
        }
      } else {
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.refusal).toBe(row.expected.refusal);
        }
      }
      // The input value is never mutated, whatever the outcome.
      expect(message.delivery).toBe(row.delivery);
    });
  }

  it("never goes back: no transition exists from read to sent", () => {
    // The type has exactly two states and the only transition function
    // targets "read"; this pins the terminal state behaviourally too.
    const read = makeMessage({ sender: quill.id, delivery: "read" });
    const result = markMessageRead(read, odile.id);
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------
describe("thread ordering and read state", () => {
  it("appends positionally, never reordering by timestamp", () => {
    // The second message carries an EARLIER timestamp; position still wins.
    let thread = openThread(odile.id, quill.id);
    thread = appendToThread(thread, makeMessage({ subject: "later", sentAt: "2031-03-08T10:00:00Z" }));
    thread = appendToThread(thread, makeMessage({ subject: "earlier", sentAt: "2031-03-01T08:00:00Z" }));
    expect(thread.messages.map((m) => m.payload.subject)).toEqual(["later", "earlier"]);
  });

  it("tolerates a sender outside the participant pair", () => {
    const thread = appendToThread(
      openThread(odile.id, quill.id),
      makeMessage({ sender: pharos.id }),
    );
    expect(thread.messages).toHaveLength(1);
  });

  it("marks exactly the other side's unrendered messages read", () => {
    let thread = openThread(odile.id, quill.id);
    thread = appendToThread(thread, makeMessage({ sender: quill.id, subject: "a" }));
    thread = appendToThread(thread, makeMessage({ sender: odile.id, subject: "b" }));
    thread = appendToThread(thread, makeMessage({ sender: quill.id, subject: "c", delivery: "read" }));
    thread = appendToThread(thread, makeMessage({ sender: quill.id, subject: "d" }));

    expect(unreadMessages(thread, odile.id).map((m) => m.payload.subject)).toEqual(["a", "d"]);

    const { thread: after, changed } = markThreadRead(thread, odile.id);
    expect(changed).toBe(2);
    expect(after.messages.map((m) => m.delivery)).toEqual(["read", "sent", "read", "read"]);
    expect(unreadMessages(after, odile.id)).toEqual([]);

    // Idempotent: a second pass changes nothing.
    expect(markThreadRead(after, odile.id).changed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------
describe("decision transitions", () => {
  function slipwayDecision(overrides: Partial<Parameters<typeof openDecision>[0]> = {}): Decision {
    return openDecision({
      id: "dec-slipway",
      question: "Which weekend do we lift the boat out?",
      options: ["first weekend", "second weekend"],
      freeTextAllowed: true,
      ...overrides,
    });
  }

  interface ResolveCase {
    name: string;
    decision: () => Decision;
    outcome: Parameters<typeof resolveDecision>[1];
    expected:
      | { ok: true }
      | { ok: false; refusal: TransitionRefusal };
  }

  const resolveTable: ResolveCase[] = [
    {
      name: "selecting an offered option resolves the decision",
      decision: () => slipwayDecision(),
      outcome: { kind: "selected", option: "second weekend" },
      expected: { ok: true },
    },
    {
      name: "selecting an option that was never offered is refused",
      decision: () => slipwayDecision(),
      outcome: { kind: "selected", option: "third weekend" },
      expected: { ok: false, refusal: "option-not-offered" },
    },
    {
      name: "a free-text outcome resolves a decision that allows it",
      decision: () => slipwayDecision(),
      outcome: { kind: "freeText", text: "Neither: wait for the survey." },
      expected: { ok: true },
    },
    {
      name: "a free-text outcome is refused where only options are allowed",
      decision: () => slipwayDecision({ freeTextAllowed: false }),
      outcome: { kind: "freeText", text: "Neither." },
      expected: { ok: false, refusal: "free-text-not-allowed" },
    },
    {
      name: "whitespace-only free text is not an outcome",
      decision: () => slipwayDecision(),
      outcome: { kind: "freeText", text: "   " },
      expected: { ok: false, refusal: "empty-free-text" },
    },
  ];

  for (const row of resolveTable) {
    it(row.name, () => {
      const result = resolveDecision(row.decision(), row.outcome, odile.id, fixedClock());
      if (row.expected.ok) {
        expect(result.ok, JSON.stringify(result)).toBe(true);
        if (result.ok) {
          expect(result.value.state.phase).toBe("resolved");
          if (result.value.state.phase === "resolved") {
            expect(result.value.state.resolvedBy).toBe(odile.id);
            expect(result.value.state.resolvedAt).toBe(EPOCH);
          }
        }
      } else {
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.refusal).toBe(row.expected.refusal);
        }
      }
    });
  }

  it("resolved is terminal: every further outcome is refused", () => {
    const first = resolveDecision(
      slipwayDecision(),
      { kind: "selected", option: "first weekend" },
      odile.id,
      fixedClock(),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    for (const outcome of [
      { kind: "selected", option: "second weekend" } as const,
      { kind: "freeText", text: "Changed my mind." } as const,
    ]) {
      const again = resolveDecision(first.value, outcome, quill.id, fixedClock());
      expect(again.ok).toBe(false);
      if (!again.ok) {
        expect(again.refusal).toBe("decision-already-resolved");
      }
    }
    // And the recorded outcome is untouched.
    if (first.value.state.phase === "resolved") {
      expect(first.value.state.outcome).toEqual({ kind: "selected", option: "first weekend" });
    }
  });
});

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
describe("action transitions", () => {
  function caulkAction(): Action {
    return openAction({ id: "act-caulk", title: "Re-caulk the aft seam" });
  }

  type Closer = (action: Action) => ReturnType<typeof completeAction>;

  const closers: Array<{ name: string; close: Closer; phase: string }> = [
    {
      name: "complete",
      close: (a) => completeAction(a, odile.id, fixedClock()),
      phase: "completed",
    },
    {
      name: "dismiss",
      close: (a) => dismissAction(a, odile.id, fixedClock()),
      phase: "dismissed",
    },
    {
      name: "supersede",
      close: (a) => supersedeAction(a, "act-replank", quill.id, fixedClock()),
      phase: "superseded",
    },
  ];

  for (const closer of closers) {
    it(`${closer.name} closes an open action into ${closer.phase}`, () => {
      const result = closer.close(caulkAction());
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (result.ok) {
        expect(result.value.state.phase).toBe(closer.phase);
      }
    });
  }

  // Terminal-state table: every closed phase refuses every closer.
  for (const first of closers) {
    for (const second of closers) {
      it(`${first.phase} is terminal against ${second.name}`, () => {
        const closed = first.close(caulkAction());
        expect(closed.ok).toBe(true);
        if (!closed.ok) {
          return;
        }
        const again = second.close(closed.value);
        expect(again.ok).toBe(false);
        if (!again.ok) {
          expect(again.refusal).toBe("action-not-open");
        }
      });
    }
  }

  it("supersession records the successor and refuses self-reference", () => {
    const superseded = supersedeAction(caulkAction(), "act-replank", quill.id, fixedClock());
    expect(superseded.ok).toBe(true);
    if (superseded.ok && superseded.value.state.phase === "superseded") {
      expect(superseded.value.state.successor).toBe("act-replank");
    }

    const selfReference = supersedeAction(caulkAction(), "act-caulk", quill.id, fixedClock());
    expect(selfReference.ok).toBe(false);
    if (!selfReference.ok) {
      expect(selfReference.refusal).toBe("action-cannot-supersede-itself");
    }
  });

  it("closing stamps the injected clock's time, and only that time", () => {
    const clock = sequenceClock(["2031-03-09T14:00:00Z", "2031-03-09T15:00:00Z"]);
    const first = completeAction(caulkAction(), odile.id, clock);
    const second = dismissAction(caulkAction(), odile.id, clock);
    expect(first.ok && first.value.state.phase === "completed" && first.value.state.at).toBe(
      "2031-03-09T14:00:00Z",
    );
    expect(second.ok && second.value.state.phase === "dismissed" && second.value.state.at).toBe(
      "2031-03-09T15:00:00Z",
    );
  });
});

// ---------------------------------------------------------------------------
// Workspace capabilities
// ---------------------------------------------------------------------------
describe("workspace capabilities", () => {
  const workspace: Workspace = {
    id: "ws-boatyard",
    label: "Boatyard notebook",
    root: "/srv/deck-fixture-root",
    capabilities: {
      backupSync: { status: "configured" },
      pushRelay: { status: "absent", reason: "the far mooring's relay link is down" },
    },
  };

  it("returns a configured capability as configured", () => {
    expect(workspaceCapability(workspace, "backupSync").status).toBe("configured");
  });

  it("returns an explicitly absent capability with its reason", () => {
    const state = workspaceCapability(workspace, "pushRelay");
    expect(state.status).toBe("absent");
    if (state.status === "absent") {
      expect(state.reason).toContain("relay link is down");
    }
  });

  it("treats a capability the configuration never mentions as absent, not an error", () => {
    const state = workspaceCapability(workspace, "speechToText");
    expect(state.status).toBe("absent");
  });
});

// ---------------------------------------------------------------------------
// Layer purity, asserted mechanically
// ---------------------------------------------------------------------------
describe("domain layer purity", () => {
  const domainDir = path.join(PACKAGE_ROOT, "src", "domain");

  function domainSources(): Array<{ name: string; text: string }> {
    return fs
      .readdirSync(domainDir)
      .filter((name) => name.endsWith(".ts"))
      .map((name) => ({ name, text: fs.readFileSync(path.join(domainDir, name), "utf8") }));
  }

  it("never reads the system clock", () => {
    // Time is injected via Clock; a Date.now() or new Date() in domain code
    // is the leak this rule exists to stop. The dependency-cruiser rules
    // catch module imports; this catches the globals no import would show.
    for (const { name, text } of domainSources()) {
      expect(text, `${name} reads the system clock`).not.toMatch(/Date\.now|new Date\(/);
    }
  });

  it("imports nothing but domain modules and the protocol package", () => {
    // Same property the dependency-cruiser rule enforces in CI, checked here
    // too so a plain `npm test` run catches it without the extra tool.
    const importRe = /from\s+"([^"]+)"/g;
    for (const { name, text } of domainSources()) {
      for (const match of text.matchAll(importRe)) {
        const specifier = match[1]!;
        expect(
          specifier.startsWith("./") || specifier === "inkie-agents-base",
          `${name} imports "${specifier}", which is outside the domain and the protocol package`,
        ).toBe(true);
      }
    }
  });

  it("hardcodes no participant name, not even the fixture cast's", () => {
    // No privileged names: the fixture world lives in tests/ only. If any
    // cast member's id shows up in src/domain, a roster is growing there.
    for (const { name, text } of domainSources()) {
      for (const id of ["odile", "quill", "pharos"]) {
        expect(text, `${name} names a participant literal: ${id}`).not.toContain(id);
      }
    }
  });
});
